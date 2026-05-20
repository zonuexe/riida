// Entry point for the standalone viewer window (v0.6.0 work-in-progress).
//
// The viewer window currently supports a minimal PDF rendering path so the
// multi-window plumbing can be exercised end-to-end. EPUB, viewer settings,
// notes, search, spread layout, lazy paging, and reading-position
// persistence will be migrated out of src/main.ts in follow-up commits.

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import "./vendor/fontawesome/css/fontawesome.min.css";
import "./vendor/fontawesome/css/solid.min.css";
import { applyAppTheme, loadPersistedAppTheme } from "./app-theme";
import { loadEpubJs } from "./epub-runtime";
import type { NoteEditorHandle } from "./note-editor";
import {
  clampNoteWindowPosition,
  ensureNoteWindowPlacement as ensureNoteWindowPlacementForViewport,
  preserveNoteWindowBottomRightOffset,
} from "./note-window-utils";
import { parseRequestedPageNumber } from "./page-jump-utils";
import { detectPdfBindingDirection } from "./pdf-binding-detect";
import {
  resolvePdfLinkTarget,
  type PdfAnnotationRecord,
  type PdfLinkResolver,
} from "./pdf-link-utils";
import { buildPdfRenderWindowPlan } from "./pdf-render-window-utils";
import { loadPdfJsRuntime, TauriBinaryDataFactory } from "./pdf-runtime";
import {
  clampReadingPositionOffsetRatio,
  computePageOffsetRatio,
  loadCachedReadingPosition,
  saveCachedReadingPosition,
  selectAnchorPageIndex,
} from "./reading-position-utils";
import {
  buildPageGroups,
  getVisualPageOrder,
  type ViewerLayoutSettings,
} from "./viewer-layout-utils";
import {
  DEFAULT_VIEWER_SETTINGS,
  type ViewerSettings,
  type ViewerSettingsPayload,
  type ViewerSettingsScope,
  type ViewerSourceType,
} from "./viewer-settings-utils";

type ViewerLaunchParams = {
  filePath: string | null;
  source: string | null;
};

// The Rust open_viewer_window command injects an initialization script that
// sets this global on the new window before any other script runs. It is the
// authoritative source of spawn-time parameters; the query-string fallback is
// for tests and direct URL access during local development.
type InjectedLaunchParams = {
  filePath?: unknown;
  source?: unknown;
};

declare global {
  interface Window {
    __RIIDA_LAUNCH_PARAMS__?: InjectedLaunchParams;
  }
}

function coerceLaunchString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readLaunchParams(
  search: string,
  injected: InjectedLaunchParams | undefined = undefined,
): ViewerLaunchParams {
  if (injected) {
    return {
      filePath: coerceLaunchString(injected.filePath),
      source: coerceLaunchString(injected.source),
    };
  }
  const params = new URLSearchParams(search);
  return {
    filePath: coerceLaunchString(params.get("file")),
    source: coerceLaunchString(params.get("source")),
  };
}

const VIEWER_LAUNCH_PARAMS_SESSION_KEY = "riida.viewer.launchParams";

// A settings change reloads the window; the Rust-injected launch global is
// normally re-applied on reload, but mirror the resolved params into
// sessionStorage so the reloaded page can still find its book if it is not.
function persistLaunchParams(params: ViewerLaunchParams): void {
  try {
    sessionStorage.setItem(VIEWER_LAUNCH_PARAMS_SESSION_KEY, JSON.stringify(params));
  } catch {
    // sessionStorage unavailable — reload falls back to the injected global.
  }
}

function readPersistedLaunchParams(): ViewerLaunchParams | null {
  try {
    const raw = sessionStorage.getItem(VIEWER_LAUNCH_PARAMS_SESSION_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { filePath?: unknown; source?: unknown };
      return {
        filePath: coerceLaunchString(parsed.filePath),
        source: coerceLaunchString(parsed.source),
      };
    }
  } catch {
    // sessionStorage unavailable or corrupt — caller falls back to defaults.
  }
  return null;
}

function setStatus(message: string | null): void {
  const statusEl = document.querySelector<HTMLElement>("#viewer-window-status");
  const targetEl = document.querySelector<HTMLElement>("#viewer-window-target");
  if (!statusEl || !targetEl) return;
  if (message === null) {
    statusEl.hidden = true;
    targetEl.textContent = "";
    return;
  }
  statusEl.hidden = false;
  targetEl.textContent = message;
}

type PdfDocumentLike = Awaited<
  ReturnType<Awaited<ReturnType<typeof loadPdfJsRuntime>>["getDocument"]>["promise"]
>;
type PdfPage = Awaited<ReturnType<PdfDocumentLike["getPage"]>>;

// Pick a backing-buffer resolution that stays crisp when CSS upscales it to
// fit a large window. The viewer window can be maximized after the canvases
// are rendered, so we give ourselves headroom and let CSS handle the actual
// display size.
const CANVAS_RENDER_SCALE = 2.0;

async function renderPdfPageCanvas(
  page: PdfPage,
  pageNumber: number,
  devicePixelRatio: number,
  pdfDocument: PdfDocumentLike,
  onInternalLink: (pageNumber: number) => void,
): Promise<HTMLElement> {
  const viewport = page.getViewport({ scale: CANVAS_RENDER_SCALE });

  const pageEl = document.createElement("div");
  pageEl.className = "pdfjs-page";
  pageEl.dataset.pageNumber = String(pageNumber);
  // Aspect ratio drives the CSS layout in the standalone viewer window. Width
  // and height are left for CSS to compute so the page resizes with the
  // window without re-rendering the canvas.
  pageEl.style.aspectRatio = `${viewport.width} / ${viewport.height}`;

  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width * devicePixelRatio);
  canvas.height = Math.floor(viewport.height * devicePixelRatio);
  // Intentionally do not set canvas.style.width / .style.height; CSS in the
  // viewer-window scope sizes the canvas via max-height / max-width.
  pageEl.appendChild(canvas);

  const ctx = canvas.getContext("2d");
  if (ctx) {
    await page.render({
      canvas,
      canvasContext: ctx,
      viewport,
      transform:
        devicePixelRatio === 1 ? undefined : [devicePixelRatio, 0, 0, devicePixelRatio, 0, 0],
    }).promise;
  }

  const linkLayer = await buildPdfLinkLayer(
    page,
    viewport,
    pageNumber,
    pdfDocument,
    onInternalLink,
  );
  if (linkLayer) {
    pageEl.appendChild(linkLayer);
  }
  return pageEl;
}

type PdfLinkViewport = {
  width: number;
  height: number;
  convertToViewportRectangle: (rect: number[]) => number[];
};

// Build the clickable overlay layer for a PDF page's in-document links. Only
// document-internal links (table-of-contents jumps, cross-references) are
// wired; external URLs are intentionally left inert because WKWebView link
// handling is unreliable (see AGENTS.md). Returns null when the page has no
// internal links so no empty layer is appended.
async function buildPdfLinkLayer(
  page: PdfPage,
  viewport: PdfLinkViewport,
  currentPageNumber: number,
  resolver: PdfDocumentLike,
  onInternalLink: (pageNumber: number) => void,
): Promise<HTMLElement | null> {
  const annotations = (await page.getAnnotations()) as PdfAnnotationRecord[];
  const layer = document.createElement("div");
  layer.className = "pdfjs-link-layer";

  for (const annotation of annotations) {
    if (annotation.subtype !== "Link" || !Array.isArray(annotation.rect)) {
      continue;
    }
    // PdfDocumentProxy structurally satisfies PdfLinkResolver; the cast only
    // bridges getPageIndex's stricter pdf.js RefProxy parameter type.
    const target = await resolvePdfLinkTarget(
      annotation,
      currentPageNumber,
      resolver as unknown as PdfLinkResolver,
    );
    if (target?.type !== "internal") {
      continue;
    }

    const rect = viewport.convertToViewportRectangle(annotation.rect as number[]);
    const x1 = rect[0] ?? 0;
    const y1 = rect[1] ?? 0;
    const x2 = rect[2] ?? 0;
    const y2 = rect[3] ?? 0;
    const width = Math.abs(x2 - x1);
    const height = Math.abs(y2 - y1);
    if (width < 2 || height < 2) {
      continue;
    }

    // Percentage geometry so the link scales with the canvas; the layer itself
    // is sized to the canvas by syncPdfLinkLayers.
    const targetPage = target.pageNumber;
    const linkEl = document.createElement("a");
    linkEl.className = "pdfjs-link";
    linkEl.href = `#page=${targetPage}`;
    linkEl.title = `Go to page ${targetPage}`;
    linkEl.style.left = `${(Math.min(x1, x2) / viewport.width) * 100}%`;
    linkEl.style.top = `${(Math.min(y1, y2) / viewport.height) * 100}%`;
    linkEl.style.width = `${(width / viewport.width) * 100}%`;
    linkEl.style.height = `${(height / viewport.height) * 100}%`;
    linkEl.addEventListener("click", (event) => {
      event.preventDefault();
      onInternalLink(targetPage);
    });
    layer.appendChild(linkEl);
  }

  return layer.childElementCount > 0 ? layer : null;
}

// The link layer is absolutely positioned inside .pdfjs-page; size and place it
// to exactly cover the page canvas so the percentage-positioned links line up.
// Called after each spread renders and on window resize, since the canvas
// display size tracks the window.
function syncPdfLinkLayers(root: ParentNode = document): void {
  for (const layer of root.querySelectorAll<HTMLElement>(".pdfjs-link-layer")) {
    const canvas = layer.parentElement?.querySelector("canvas");
    if (!canvas) {
      continue;
    }
    layer.style.left = `${canvas.offsetLeft}px`;
    layer.style.top = `${canvas.offsetTop}px`;
    layer.style.width = `${canvas.offsetWidth}px`;
    layer.style.height = `${canvas.offsetHeight}px`;
  }
}

type PdfNavigationController = {
  jumpToPage: (pageNumber: number) => void;
};

// Wire the navigation overlay — back/forward history plus page-number jump —
// for a rendered PDF. The history records document scroll offsets visited via
// explicit jumps (in-page link clicks, page-number entry); plain scrolling is
// not recorded, matching how a desktop PDF reader's back/forward behaves.
function createPdfNavigation(
  scrollEl: HTMLElement,
  spreadIndex: readonly SpreadIndexEntry[],
  totalPages: number,
): PdfNavigationController {
  const backStack: number[] = [];
  const forwardStack: number[] = [];

  const navBackEl = document.querySelector<HTMLButtonElement>("#nav-back");
  const navForwardEl = document.querySelector<HTMLButtonElement>("#nav-forward");
  const pageJumpEl = document.querySelector<HTMLElement>("#viewer-page-jump");
  const pageJumpFormEl = document.querySelector<HTMLFormElement>("#viewer-page-jump-form");
  const pageJumpInputEl = document.querySelector<HTMLInputElement>("#viewer-page-jump-input");
  const pageJumpTotalEl = document.querySelector<HTMLElement>("#viewer-page-jump-total");

  const syncButtons = (): void => {
    if (navBackEl) navBackEl.disabled = backStack.length === 0;
    if (navForwardEl) navForwardEl.disabled = forwardStack.length === 0;
  };

  const currentPageNumber = (): number => {
    const entry = spreadIndex[findCurrentSpreadIndex(scrollEl, spreadIndex)] ?? spreadIndex[0];
    if (!entry) return 1;
    // Smallest page in the spread, so the indicator shows the head-side page.
    return entry.pageNumbers.reduce(
      (best, candidate) => (candidate > 0 && candidate < best ? candidate : best),
      entry.pageNumbers[0] ?? 1,
    );
  };

  const syncPageIndicator = (): void => {
    if (pageJumpTotalEl) {
      pageJumpTotalEl.textContent = `/ ${totalPages}`;
    }
    if (pageJumpInputEl && document.activeElement !== pageJumpInputEl) {
      pageJumpInputEl.value = String(currentPageNumber());
    }
  };

  const jumpToPage = (pageNumber: number): void => {
    const entry = findSpreadForPage(spreadIndex, pageNumber);
    if (!entry) return;
    backStack.push(scrollEl.scrollTop);
    forwardStack.length = 0;
    scrollEl.scrollTo({ top: entry.spreadEl.offsetTop, behavior: "smooth" });
    syncButtons();
  };

  const goBack = (): void => {
    const previous = backStack.pop();
    if (previous === undefined) return;
    forwardStack.push(scrollEl.scrollTop);
    scrollEl.scrollTo({ top: previous, behavior: "smooth" });
    syncButtons();
  };

  const goForward = (): void => {
    const next = forwardStack.pop();
    if (next === undefined) return;
    backStack.push(scrollEl.scrollTop);
    scrollEl.scrollTo({ top: next, behavior: "smooth" });
    syncButtons();
  };

  navBackEl?.addEventListener("click", goBack);
  navForwardEl?.addEventListener("click", goForward);

  if (pageJumpEl) {
    pageJumpEl.hidden = false;
  }
  pageJumpInputEl?.addEventListener("focus", () => pageJumpInputEl.select());
  pageJumpInputEl?.addEventListener("blur", () => syncPageIndicator());
  pageJumpInputEl?.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      syncPageIndicator();
      pageJumpInputEl.blur();
    }
  });
  pageJumpFormEl?.addEventListener("submit", (event) => {
    event.preventDefault();
    const requested = parseRequestedPageNumber(pageJumpInputEl?.value ?? "");
    if (requested === null) {
      syncPageIndicator();
      return;
    }
    jumpToPage(Math.min(requested, Math.max(totalPages, 1)));
    pageJumpInputEl?.blur();
  });

  scrollEl.addEventListener("scroll", () => syncPageIndicator(), { passive: true });

  syncButtons();
  syncPageIndicator();

  return { jumpToPage };
}

type PdfOutlineNode = {
  title: string;
  dest: string | unknown[] | null;
  items: PdfOutlineNode[];
};

type EpubTocItem = {
  label: string;
  href: string;
  subitems?: EpubTocItem[];
};

// Wire the table-of-contents toggle button and panel. Returns a handle whose
// close() collapses the panel — used after a TOC entry is chosen.
function installTocToggle(
  toggleEl: HTMLButtonElement,
  panelEl: HTMLElement,
): { close: () => void } {
  let isOpen = false;
  const sync = (): void => {
    toggleEl.setAttribute("aria-expanded", String(isOpen));
    panelEl.hidden = !isOpen;
  };
  toggleEl.hidden = false;
  toggleEl.addEventListener("click", () => {
    isOpen = !isOpen;
    sync();
  });
  sync();
  return {
    close: () => {
      isOpen = false;
      sync();
    },
  };
}

// Populate the TOC panel from the PDF outline. Each entry resolves its
// destination to a page and jumps there through the navigation controller, so
// outline jumps share the back/forward history. No-op when the PDF has no
// outline.
async function installPdfToc(
  pdfDocument: PdfDocumentLike,
  jumpToPage: (pageNumber: number) => void,
): Promise<void> {
  const outline = (await pdfDocument.getOutline()) as PdfOutlineNode[] | null;
  if (!outline || outline.length === 0) return;

  const listEl = document.querySelector<HTMLElement>("#epub-toc-list");
  const toggleEl = document.querySelector<HTMLButtonElement>("#epub-toc-toggle");
  const panelEl = document.querySelector<HTMLElement>("#epub-toc-panel");
  if (!listEl || !toggleEl || !panelEl) return;

  const toc = installTocToggle(toggleEl, panelEl);

  const appendItems = (items: readonly PdfOutlineNode[], depth: number): void => {
    for (const item of items) {
      const itemEl = document.createElement("button");
      itemEl.type = "button";
      itemEl.className = "epub-toc-item";
      itemEl.dataset.depth = String(depth);
      itemEl.textContent = item.title;
      itemEl.addEventListener("click", () => {
        toc.close();
        void (async () => {
          // An outline node carries the same kind of destination as an
          // internal link annotation, so the link resolver handles both.
          const target = await resolvePdfLinkTarget(
            { dest: item.dest },
            1,
            pdfDocument as unknown as PdfLinkResolver,
          );
          if (target?.type === "internal") {
            jumpToPage(target.pageNumber);
          }
        })();
      });
      listEl.appendChild(itemEl);
      if (item.items.length > 0) {
        appendItems(item.items, depth + 1);
      }
    }
  };
  appendItems(outline, 0);
}

// Populate the TOC panel from the EPUB navigation document. Entries navigate
// via epub.js's rendition.display(). No-op when the book has no TOC.
function installEpubToc(book: import("epubjs").Book, rendition: import("epubjs").Rendition): void {
  const navToc = (book.navigation as { toc?: EpubTocItem[] } | undefined)?.toc;
  if (!navToc || navToc.length === 0) return;

  const listEl = document.querySelector<HTMLElement>("#epub-toc-list");
  const toggleEl = document.querySelector<HTMLButtonElement>("#epub-toc-toggle");
  const panelEl = document.querySelector<HTMLElement>("#epub-toc-panel");
  if (!listEl || !toggleEl || !panelEl) return;

  const toc = installTocToggle(toggleEl, panelEl);

  const appendItems = (items: readonly EpubTocItem[], depth: number): void => {
    for (const item of items) {
      const itemEl = document.createElement("button");
      itemEl.type = "button";
      itemEl.className = "epub-toc-item";
      itemEl.dataset.depth = String(depth);
      itemEl.textContent = item.label.trim();
      itemEl.addEventListener("click", () => {
        toc.close();
        void rendition.display(item.href);
      });
      listEl.appendChild(itemEl);
      if (item.subitems && item.subitems.length > 0) {
        appendItems(item.subitems, depth + 1);
      }
    }
  };
  appendItems(navToc, 0);
}

const VIEWER_SETTINGS_PANEL_SESSION_KEY = "riida.viewer.settingsPanel";

// The settings panel triggers a window reload to re-render from the new
// preferences; its open state and scope are stashed here so it reappears
// where the reader left it.
function readSettingsPanelSession(): { open: boolean; scope: ViewerSettingsScope } {
  try {
    const raw = sessionStorage.getItem(VIEWER_SETTINGS_PANEL_SESSION_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { open?: unknown; scope?: unknown };
      return {
        open: parsed.open === true,
        scope: parsed.scope === "file" ? "file" : "global",
      };
    }
  } catch {
    // sessionStorage unavailable or corrupt — fall through to defaults.
  }
  return { open: false, scope: "global" };
}

function writeSettingsPanelSession(state: { open: boolean; scope: ViewerSettingsScope }): void {
  try {
    sessionStorage.setItem(VIEWER_SETTINGS_PANEL_SESSION_KEY, JSON.stringify(state));
  } catch {
    // sessionStorage unavailable — the panel just will not survive a reload.
  }
}

// Wire the viewer settings panel: the toggle button, the global/file scope
// tabs, and every preference control. A changed control is persisted with the
// same save_*_viewer_preferences commands the in-app viewer uses, then the
// window reloads so boot re-renders from the new preferences. pageMode,
// bindingDirection, treatFirstPageAsCover and scrollMode take visible effect;
// the remaining preferences are persisted (and shared with the in-app viewer)
// but not yet reflected by the viewer window's renderer.
async function installViewerSettingsPanel(
  filePath: string,
  sourceType: ViewerSourceType,
): Promise<void> {
  const overlayControlsEl = document.querySelector<HTMLElement>("#viewer-overlay-controls");
  const toggleEl = document.querySelector<HTMLButtonElement>("#viewer-settings-toggle");
  const panelEl = document.querySelector<HTMLElement>("#viewer-settings-panel");
  const scopeGlobalEl = document.querySelector<HTMLButtonElement>("#viewer-settings-scope-global");
  const scopeFileEl = document.querySelector<HTMLButtonElement>("#viewer-settings-scope-file");
  const sourceLabelEl = document.querySelector<HTMLElement>("#viewer-settings-source-label");
  const pageModeEl = document.querySelector<HTMLSelectElement>("#viewer-page-mode");
  const bindingEl = document.querySelector<HTMLSelectElement>("#viewer-binding-direction");
  const zoomModeEl = document.querySelector<HTMLSelectElement>("#viewer-zoom-mode");
  const alignModeEl = document.querySelector<HTMLSelectElement>("#viewer-align-mode");
  const verticalGapModeEl = document.querySelector<HTMLSelectElement>("#viewer-vertical-gap-mode");
  const scrollModeEl = document.querySelector<HTMLSelectElement>("#viewer-scroll-mode");
  const coverModeEl = document.querySelector<HTMLInputElement>("#viewer-cover-mode");
  const epubFontSizeEl = document.querySelector<HTMLInputElement>("#viewer-epub-font-size");
  const epubFontSizeOutputEl = document.querySelector<HTMLOutputElement>(
    "#viewer-epub-font-size-output",
  );
  const backgroundInheritEl = document.querySelector<HTMLInputElement>(
    "#viewer-background-inherit",
  );
  const backgroundRadios = Array.from(
    document.querySelectorAll<HTMLInputElement>('input[name="viewer-background-mode"]'),
  );
  if (
    !overlayControlsEl ||
    !toggleEl ||
    !panelEl ||
    !scopeGlobalEl ||
    !scopeFileEl ||
    !sourceLabelEl ||
    !pageModeEl ||
    !bindingEl ||
    !zoomModeEl ||
    !alignModeEl ||
    !verticalGapModeEl ||
    !scrollModeEl ||
    !coverModeEl ||
    !epubFontSizeEl ||
    !epubFontSizeOutputEl ||
    !backgroundInheritEl
  ) {
    return;
  }

  let payload: ViewerSettingsPayload;
  try {
    payload = await invoke<ViewerSettingsPayload>("load_viewer_preferences", {
      filePath,
      sourceType,
    });
  } catch (error) {
    console.warn("[riida] viewer window: failed to load viewer preferences:", error);
    return;
  }

  const session = readSettingsPanelSession();
  let scope: ViewerSettingsScope = session.scope;
  let isOpen = session.open;

  // File scope with no saved override edits a copy of the effective settings,
  // so the first change there creates the override.
  const settingsForScope = (): ViewerSettings =>
    scope === "file" ? (payload.file ?? payload.effective) : payload.global;

  const populate = (): void => {
    panelEl.dataset.scope = scope;
    panelEl.dataset.sourceType = sourceType;
    sourceLabelEl.textContent = sourceType === "epub" ? "EPUB" : "PDF";
    scopeGlobalEl.classList.toggle("is-active", scope === "global");
    scopeGlobalEl.setAttribute("aria-selected", String(scope === "global"));
    scopeFileEl.classList.toggle("is-active", scope === "file");
    scopeFileEl.setAttribute("aria-selected", String(scope === "file"));

    const settings = settingsForScope();
    pageModeEl.value = settings.pageMode;
    bindingEl.value = settings.bindingDirection;
    zoomModeEl.value = settings.zoomMode;
    alignModeEl.value = settings.alignMode;
    verticalGapModeEl.value = settings.verticalGapMode;
    scrollModeEl.value = settings.scrollMode;
    coverModeEl.checked = settings.treatFirstPageAsCover;
    epubFontSizeEl.value = String(settings.epubFontSize);
    epubFontSizeOutputEl.value = `${settings.epubFontSize}%`;

    const inherits = settings.backgroundMode === "inherit-theme";
    backgroundInheritEl.checked = inherits;
    for (const radio of backgroundRadios) {
      radio.checked = !inherits && radio.value === settings.backgroundMode;
      radio.disabled = inherits;
    }
  };

  const syncToggle = (): void => {
    overlayControlsEl.hidden = false;
    toggleEl.setAttribute("aria-expanded", String(isOpen));
    panelEl.hidden = !isOpen;
  };

  const gather = (): ViewerSettings => {
    const selectedBackground = backgroundRadios.find((radio) => radio.checked);
    return {
      pageMode: pageModeEl.value as ViewerSettings["pageMode"],
      bindingDirection: bindingEl.value as ViewerSettings["bindingDirection"],
      zoomMode: zoomModeEl.value as ViewerSettings["zoomMode"],
      alignMode: alignModeEl.value as ViewerSettings["alignMode"],
      verticalGapMode: verticalGapModeEl.value as ViewerSettings["verticalGapMode"],
      treatFirstPageAsCover: coverModeEl.checked,
      backgroundMode: backgroundInheritEl.checked
        ? "inherit-theme"
        : ((selectedBackground?.value as ViewerSettings["backgroundMode"]) ?? "inherit-theme"),
      scrollMode: scrollModeEl.value as ViewerSettings["scrollMode"],
      epubFontSize: Number.parseInt(epubFontSizeEl.value, 10) || 100,
    };
  };

  const persistAndReload = async (): Promise<void> => {
    const preferences = gather();
    try {
      if (scope === "file") {
        await invoke("save_file_viewer_preferences", { filePath, sourceType, preferences });
      } else {
        await invoke("save_default_viewer_preferences", {
          currentFilePath: filePath,
          sourceType,
          preferences,
        });
      }
    } catch (error) {
      console.error("[riida] viewer window: failed to save viewer preferences:", error);
      return;
    }
    // boot re-reads the saved preferences and re-renders; keep the panel open.
    writeSettingsPanelSession({ open: true, scope });
    window.location.reload();
  };

  toggleEl.addEventListener("click", () => {
    isOpen = !isOpen;
    writeSettingsPanelSession({ open: isOpen, scope });
    syncToggle();
  });
  scopeGlobalEl.addEventListener("click", () => {
    scope = "global";
    writeSettingsPanelSession({ open: isOpen, scope });
    populate();
  });
  scopeFileEl.addEventListener("click", () => {
    scope = "file";
    writeSettingsPanelSession({ open: isOpen, scope });
    populate();
  });

  for (const control of [
    pageModeEl,
    bindingEl,
    zoomModeEl,
    alignModeEl,
    verticalGapModeEl,
    scrollModeEl,
    coverModeEl,
    epubFontSizeEl,
    backgroundInheritEl,
    ...backgroundRadios,
  ]) {
    control.addEventListener("change", () => void persistAndReload());
  }

  populate();
  syncToggle();
}

type SpreadIndexEntry = {
  spreadEl: HTMLElement;
  pageNumbers: readonly number[];
};

type RenderedPdf = {
  spreadIndex: SpreadIndexEntry[];
  bindingDirection: "left" | "right";
};

function findSpreadForPage(
  spreadIndex: readonly SpreadIndexEntry[],
  pageNumber: number,
): SpreadIndexEntry | null {
  let fallback: SpreadIndexEntry | null = null;
  for (const entry of spreadIndex) {
    if (entry.pageNumbers.includes(pageNumber)) {
      return entry;
    }
    if (entry.pageNumbers.some((p) => p > pageNumber)) {
      // pages are in document order; remember the first spread past the
      // target so we can fall back when the saved page number no longer
      // exists in the current document.
      fallback ??= entry;
    }
  }
  return fallback ?? spreadIndex[spreadIndex.length - 1] ?? null;
}

// WKWebView resets a freshly opened window's scroll container to the top
// during its first layout passes (the same early-layout instability the EPUB
// path works around with requestAnimationFrame). Setting scrollTop once is not
// enough: the value takes, then a later layout pass clears it. So re-assert the
// restored position every frame across a short settle window, recomputing the
// offset each time in case the layout itself is still settling, and back off
// as soon as the reader scrolls on their own.
const SCROLL_RESTORE_SETTLE_MS = 2000;

function restoreScrollAfterRender(
  scrollEl: HTMLElement,
  cached: ReturnType<typeof loadCachedReadingPosition>,
  targetEntry: SpreadIndexEntry | null,
): void {
  if (!cached || !targetEntry) return;
  const ratio = clampReadingPositionOffsetRatio(cached.pageOffsetRatio);

  const applyScroll = (): void => {
    scrollEl.scrollTop = targetEntry.spreadEl.offsetTop + ratio * targetEntry.spreadEl.offsetHeight;
  };

  let userTookOver = false;
  const markUserTookOver = (): void => {
    userTookOver = true;
  };
  // Genuine reader input only; a programmatic scrollTop assignment fires none
  // of these, so the settle loop never mistakes its own correction for input.
  const inputEvents: Array<keyof WindowEventMap> = ["wheel", "keydown", "pointerdown"];
  for (const eventName of inputEvents) {
    window.addEventListener(eventName, markUserTookOver, { passive: true });
  }
  const stopWatchingInput = (): void => {
    for (const eventName of inputEvents) {
      window.removeEventListener(eventName, markUserTookOver);
    }
  };

  applyScroll();

  const deadline = performance.now() + SCROLL_RESTORE_SETTLE_MS;
  const tick = (): void => {
    if (userTookOver || performance.now() >= deadline) {
      stopWatchingInput();
      return;
    }
    applyScroll();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function capturePositionFromScroll(
  filePath: string,
  scrollEl: HTMLElement,
  spreadIndex: readonly SpreadIndexEntry[],
): void {
  if (spreadIndex.length === 0) return;
  const anchorLine = scrollEl.scrollTop + 24;
  const anchorIndex = selectAnchorPageIndex(
    spreadIndex.map((entry) => entry.spreadEl.offsetTop),
    anchorLine,
  );
  const anchor = spreadIndex[anchorIndex] ?? spreadIndex[0];
  if (!anchor) return;
  // Multiple page numbers share a spread; use the smallest one so switching
  // from spread to single-page would land on the head-side page.
  const headPageNumber = anchor.pageNumbers.reduce(
    (best, candidate) => (candidate > 0 && candidate < best ? candidate : best),
    anchor.pageNumbers[0] ?? 1,
  );
  const pageOffsetRatio = computePageOffsetRatio(
    scrollEl.scrollTop,
    anchor.spreadEl.offsetTop,
    anchor.spreadEl.offsetHeight,
  );
  saveCachedReadingPosition({
    filePath,
    pageNumber: headPageNumber,
    pageOffsetRatio,
    cfi: null,
    updatedAt: Date.now(),
  });
}

function findCurrentSpreadIndex(
  scrollEl: HTMLElement,
  spreadIndex: readonly SpreadIndexEntry[],
): number {
  if (spreadIndex.length === 0) return -1;
  const anchorLine = scrollEl.scrollTop + 24;
  return selectAnchorPageIndex(
    spreadIndex.map((entry) => entry.spreadEl.offsetTop),
    anchorLine,
  );
}

function scrollToSpread(
  scrollEl: HTMLElement,
  spreadIndex: readonly SpreadIndexEntry[],
  index: number,
): void {
  const clamped = Math.max(0, Math.min(index, spreadIndex.length - 1));
  const target = spreadIndex[clamped];
  if (!target) return;
  scrollEl.scrollTo({ top: target.spreadEl.offsetTop, behavior: "smooth" });
}

function installSpreadKeyboardNavigation(
  scrollEl: HTMLElement,
  spreadIndex: readonly SpreadIndexEntry[],
  bindingDirection: "left" | "right",
): void {
  if (spreadIndex.length === 0) return;
  // For right-bound (typically Japanese tategaki) books, the reader advances
  // toward the left of the spread, so horizontal arrow semantics flip.
  const horizontalNext = bindingDirection === "right" ? "ArrowLeft" : "ArrowRight";
  const horizontalPrev = bindingDirection === "right" ? "ArrowRight" : "ArrowLeft";
  window.addEventListener("keydown", (event) => {
    if (event.defaultPrevented) return;
    // Let the OS / browser handle Cmd-, Ctrl-, and Alt-combinations
    // (Spotlight on Cmd+Space, window cycling on Cmd+`, etc.) so we never
    // accidentally swallow a system shortcut. Shift is allowed because
    // Shift+Space is our own "previous spread" binding.
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    if (target && (target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName))) {
      return;
    }
    const isNext =
      event.key === "PageDown" ||
      (event.key === " " && !event.shiftKey) ||
      event.key === "ArrowDown" ||
      event.key === horizontalNext;
    const isPrev =
      event.key === "PageUp" ||
      (event.key === " " && event.shiftKey) ||
      event.key === "ArrowUp" ||
      event.key === horizontalPrev;
    const isHome = event.key === "Home";
    const isEnd = event.key === "End";
    if (!isNext && !isPrev && !isHome && !isEnd) return;
    event.preventDefault();
    const current = findCurrentSpreadIndex(scrollEl, spreadIndex);
    if (isHome) {
      scrollToSpread(scrollEl, spreadIndex, 0);
    } else if (isEnd) {
      scrollToSpread(scrollEl, spreadIndex, spreadIndex.length - 1);
    } else if (isNext) {
      scrollToSpread(scrollEl, spreadIndex, current + 1);
    } else {
      scrollToSpread(scrollEl, spreadIndex, current - 1);
    }
  });
}

function installReadingPositionPersistence(
  filePath: string,
  scrollEl: HTMLElement,
  spreadIndex: readonly SpreadIndexEntry[],
): void {
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const SAVE_DEBOUNCE_MS = 600;

  const scheduleSave = () => {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      capturePositionFromScroll(filePath, scrollEl, spreadIndex);
    }, SAVE_DEBOUNCE_MS);
  };

  scrollEl.addEventListener("scroll", scheduleSave, { passive: true });
  window.addEventListener("beforeunload", () => {
    if (saveTimer !== null) clearTimeout(saveTimer);
    capturePositionFromScroll(filePath, scrollEl, spreadIndex);
  });
}

// The viewer window has no settings UI yet, so it inherits whatever the in-app
// viewer resolved for this book: a per-file override if one exists, otherwise
// the global preference, otherwise the built-in defaults. Mirrors
// loadViewerSettingsForCurrentBook() in src/main.ts.
async function loadEffectiveViewerSettings(filePath: string): Promise<ViewerSettings> {
  try {
    const payload = await invoke<ViewerSettingsPayload>("load_viewer_preferences", {
      filePath,
      sourceType: "pdf",
    });
    return payload.effective;
  } catch (error) {
    console.warn("[riida] viewer window: failed to load viewer preferences:", error);
    return DEFAULT_VIEWER_SETTINGS;
  }
}

// Build empty spread placeholders, then render page canvases outward from the
// spread the reader left off at, so the requested page paints before the rest
// of the document. Every spread has a fixed 100vh-based height (see
// styles.css), so the scroll layout is final before any canvas is painted and
// appending canvases later never shifts it. Layout and scroll behaviour follow
// the book's effective viewer preferences. Text layers and search will follow.
async function renderPdfDocument(
  filePath: string,
  viewerEl: HTMLElement,
  scrollEl: HTMLElement,
): Promise<RenderedPdf> {
  const sourceUrl = convertFileSrc(filePath);
  const { getDocument } = await loadPdfJsRuntime();

  const documentTask = getDocument({
    url: sourceUrl,
    cMapUrl: "/pdfjs/cmaps/node_modules/pdfjs-dist/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/node_modules/pdfjs-dist/standard_fonts/",
    useSystemFonts: true,
    disableFontFace: false,
    BinaryDataFactory: TauriBinaryDataFactory,
    useWorkerFetch: false,
  });
  const [pdfDocument, preferences] = await Promise.all([
    documentTask.promise,
    loadEffectiveViewerSettings(filePath),
  ]);

  // bindingDirection is tri-state: "auto" runs the detector, while an explicit
  // left/right preference short-circuits it (mirrors the in-app pdfjs path).
  const resolvedBinding =
    preferences.bindingDirection === "auto"
      ? ((await detectPdfBindingDirection(pdfDocument, () => false)) ?? "left")
      : preferences.bindingDirection;

  const layoutSettings: ViewerLayoutSettings = {
    pageMode: preferences.pageMode,
    bindingDirection: resolvedBinding,
    treatFirstPageAsCover: preferences.treatFirstPageAsCover,
  };
  const pageGroups = buildPageGroups(pdfDocument.numPages, layoutSettings);

  viewerEl.innerHTML = "";
  viewerEl.dataset.filePath = filePath;
  viewerEl.hidden = false;

  const devicePixelRatio = window.devicePixelRatio || 1;
  const spreadIndex: SpreadIndexEntry[] = [];
  const spreadVisualOrders: number[][] = [];

  // Build empty spread placeholders up front. Each spread has a fixed height,
  // so the full scroll layout — and the restored reading position — is correct
  // before any page canvas exists.
  for (const group of pageGroups) {
    const visualOrder = getVisualPageOrder(group, layoutSettings);
    const spreadEl = document.createElement("div");
    spreadEl.className = "pdfjs-spread";
    spreadEl.dataset.pageCount = String(visualOrder.length);
    spreadEl.dataset.binding = resolvedBinding;
    if (visualOrder.length === 1 && visualOrder[0] === 1) {
      spreadEl.dataset.cover = "true";
    }
    viewerEl.appendChild(spreadEl);
    // Record pages in document order so callers can match a saved page number
    // without caring about left/right binding.
    spreadIndex.push({ spreadEl, pageNumbers: [...group] });
    spreadVisualOrders.push(visualOrder);
  }

  // Wire the navigation overlay (back/forward history, page-number jump). PDF
  // in-page links jump through the same controller so they share its history.
  const navigation = createPdfNavigation(scrollEl, spreadIndex, pdfDocument.numPages);

  // Populate the table-of-contents panel from the PDF outline (fire-and-forget;
  // it must not delay the first page paint).
  void installPdfToc(pdfDocument, navigation.jumpToPage);

  // Keep the link overlays aligned with their canvases as the window resizes.
  let linkLayerSyncScheduled = false;
  window.addEventListener("resize", () => {
    if (linkLayerSyncScheduled) return;
    linkLayerSyncScheduled = true;
    requestAnimationFrame(() => {
      linkLayerSyncScheduled = false;
      syncPdfLinkLayers();
    });
  });

  // Resolve which spread the reader left off at so it can be rendered first.
  const cached = loadCachedReadingPosition(filePath);
  const targetEntry = cached ? findSpreadForPage(spreadIndex, cached.pageNumber) : null;
  const targetGroupIndex = targetEntry ? Math.max(0, spreadIndex.indexOf(targetEntry)) : 0;

  const renderSpread = async (groupIndex: number): Promise<void> => {
    const entry = spreadIndex[groupIndex];
    const visualOrder = spreadVisualOrders[groupIndex];
    if (!entry || !visualOrder) return;
    for (const pageNumber of visualOrder) {
      const page = await pdfDocument.getPage(pageNumber);
      const pageEl = await renderPdfPageCanvas(
        page,
        pageNumber,
        devicePixelRatio,
        pdfDocument,
        navigation.jumpToPage,
      );
      entry.spreadEl.appendChild(pageEl);
    }
    // Both pages of the spread are in the DOM, so the canvases have their final
    // size; align the link overlays to them.
    syncPdfLinkLayers(entry.spreadEl);
  };

  // buildPdfRenderWindowPlan with a radius spanning every spread yields a
  // distance-ordered sweep: the target spread first, then alternating
  // neighbours outward.
  const { renderOrder } = buildPdfRenderWindowPlan(
    spreadIndex.length,
    targetGroupIndex,
    spreadIndex.length,
    spreadIndex.length,
  );
  const [firstGroup, ...remainingGroups] = renderOrder;

  // Await only the target spread so the window becomes usable as soon as the
  // requested page is on screen; paint the rest in the background.
  if (firstGroup !== undefined) {
    await renderSpread(firstGroup);
  }

  // The status overlay sits above the viewer in normal flow; hide it before
  // measuring spread offsets so the restored scroll position is accurate.
  setStatus(null);
  // "paged" turns on the CSS scroll-snap behaviour (see styles.css); the value
  // comes from the book's effective viewer preferences.
  scrollEl.dataset.scrollMode = preferences.scrollMode;
  restoreScrollAfterRender(scrollEl, cached, targetEntry);

  void (async () => {
    try {
      for (const groupIndex of remainingGroups) {
        await renderSpread(groupIndex);
      }
    } catch (error) {
      console.warn("[riida] viewer window: background page rendering stopped:", error);
    }
  })();

  return { spreadIndex, bindingDirection: resolvedBinding };
}

type EpubRenderResult = {
  rendition: import("epubjs").Rendition;
  isRtl: boolean;
};

function looksLikeEpubPath(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(".epub");
}

async function renderEpubBook(filePath: string, viewerEl: HTMLElement): Promise<EpubRenderResult> {
  const sourceUrl = convertFileSrc(filePath);
  const EpubModule = await loadEpubJs();
  const Epub = EpubModule.default;
  const book = Epub(sourceUrl);
  await book.ready;

  // DPFJ guide §ページ進行方向の遵守: progression direction comes from the OPF
  // spine, not from writing-mode. In rtl books (typically Japanese tategaki)
  // ArrowLeft is "next" and ArrowRight is "previous".
  const bookInternal = book as unknown as {
    spine?: { direction?: string };
    package?: { metadata?: { direction?: string } };
  };
  const spineDirection =
    bookInternal.spine?.direction ?? bookInternal.package?.metadata?.direction ?? "ltr";
  const isRtl = spineDirection === "rtl";

  viewerEl.innerHTML = "";
  viewerEl.dataset.filePath = filePath;
  viewerEl.hidden = false;

  const rendition = book.renderTo(viewerEl, {
    width: "100%",
    height: "100%",
    spread: "auto",
    flow: "paginated",
    allowScriptedContent: true,
  });

  const cached = loadCachedReadingPosition(filePath);
  const restoreCfi = cached?.cfi ?? undefined;
  await rendition.display(restoreCfi);

  // WKWebView occasionally renders the first display at zero dimensions when
  // the iframe attaches before layout has settled. epub.js only re-displays
  // automatically when rendition.location is set; force a redisplay if that
  // window opens at 0x0.
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
  const iframeEl = viewerEl.querySelector<HTMLIFrameElement>("iframe");
  if (!iframeEl || iframeEl.clientWidth === 0 || iframeEl.clientHeight === 0) {
    try {
      await rendition.display(restoreCfi);
    } catch (err) {
      console.warn("[riida] epub redisplay after resize failed:", err);
    }
  }

  rendition.on("relocated", (location: import("epubjs").Location) => {
    const cfi = location.start.cfi;
    if (!cfi) return;
    // Reuse the shared reading-position cache. pageNumber and offsetRatio are
    // unused for EPUB restore (the cfi field drives navigation), but the
    // schema requires them.
    saveCachedReadingPosition({
      filePath,
      pageNumber: 1,
      pageOffsetRatio: 0,
      cfi,
      updatedAt: Date.now(),
    });
  });

  installEpubToc(book, rendition);

  return { rendition, isRtl };
}

function installEpubKeyboardNavigation(
  rendition: import("epubjs").Rendition,
  isRtl: boolean,
): void {
  const horizontalNext = isRtl ? "ArrowLeft" : "ArrowRight";
  const horizontalPrev = isRtl ? "ArrowRight" : "ArrowLeft";
  window.addEventListener("keydown", (event) => {
    if (event.defaultPrevented) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    if (target && (target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName))) {
      return;
    }
    const isNext =
      event.key === "PageDown" ||
      (event.key === " " && !event.shiftKey) ||
      event.key === "ArrowDown" ||
      event.key === horizontalNext;
    const isPrev =
      event.key === "PageUp" ||
      (event.key === " " && event.shiftKey) ||
      event.key === "ArrowUp" ||
      event.key === horizontalPrev;
    if (!isNext && !isPrev) return;
    event.preventDefault();
    if (isNext) {
      void rendition.next();
    } else {
      void rendition.prev();
    }
  });
}

type NoteDocument = {
  filePath: string;
  format: string;
  content: string;
  updatedAt: number | null;
};

type NoteState = {
  isOpen: boolean;
  isLoading: boolean;
  activeFilePath: string | null;
  currentContent: string;
  x: number | null;
  y: number | null;
  width: number;
  height: number;
};

type NoteInteractionState = {
  mode: "drag" | "resize" | null;
  edge: string | null;
  startX: number;
  startY: number;
  startLeft: number;
  startTop: number;
  startWidth: number;
  startHeight: number;
};

const NOTE_MIN_WIDTH = 280;
const NOTE_MIN_HEIGHT = 220;
const NOTE_SAVE_DEBOUNCE_MS = 800;

const noteState: NoteState = {
  isOpen: false,
  isLoading: false,
  activeFilePath: null,
  currentContent: "",
  x: null,
  y: null,
  width: 420,
  height: 540,
};

const noteInteractionState: NoteInteractionState = {
  mode: null,
  edge: null,
  startX: 0,
  startY: 0,
  startLeft: 0,
  startTop: 0,
  startWidth: 0,
  startHeight: 0,
};

let noteEditor: NoteEditorHandle | null = null;
let noteEditorModulePromise: Promise<typeof import("./note-editor")> | null = null;
let noteSaveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingNoteSave: { filePath: string; content: string } | null = null;
let activeBookFilePath: string | null = null;
let lastNoteViewport: { width: number; height: number } | null = null;
// See src/main.ts for the rationale: Milkdown can re-enter scheduleNoteSave
// during destroy() and freeze the renderer.
let isDestroyingNoteEditor = false;

async function loadNoteEditorModule() {
  noteEditorModulePromise ??= import("./note-editor");
  return noteEditorModulePromise;
}

function clampNoteWindow(): void {
  const next = clampNoteWindowPosition(noteState, {
    width: window.innerWidth,
    height: window.innerHeight,
  });
  noteState.x = next.x;
  noteState.y = next.y;
}

function ensureNoteWindowPlacement(): void {
  const next = ensureNoteWindowPlacementForViewport(noteState, {
    width: window.innerWidth,
    height: window.innerHeight,
  });
  noteState.x = next.x;
  noteState.y = next.y;
}

function syncNoteUi(): void {
  const noteToggleEl = document.querySelector<HTMLButtonElement>("#note-toggle");
  const notePanelEl = document.querySelector<HTMLElement>("#note-panel");
  const hasBook = activeBookFilePath !== null;

  if (noteToggleEl) {
    noteToggleEl.hidden = !hasBook || noteState.isOpen;
  }

  if (notePanelEl) {
    notePanelEl.hidden = !hasBook || !noteState.isOpen;
    if (!notePanelEl.hidden) {
      ensureNoteWindowPlacement();
      notePanelEl.style.left = `${noteState.x}px`;
      notePanelEl.style.top = `${noteState.y}px`;
      notePanelEl.style.width = `${noteState.width}px`;
      notePanelEl.style.height = `${noteState.height}px`;
    }
  }
}

async function saveNoteNow(): Promise<void> {
  if (!pendingNoteSave) return;
  const payload = pendingNoteSave;
  pendingNoteSave = null;
  try {
    await invoke<NoteDocument>("save_note", {
      filePath: payload.filePath,
      content: payload.content,
    });
  } catch (error) {
    console.error("[riida] failed to save note:", error);
  }
}

function scheduleNoteSave(markdown: string): void {
  if (isDestroyingNoteEditor) return;
  if (!noteState.activeFilePath) return;
  noteState.currentContent = markdown;
  pendingNoteSave = { filePath: noteState.activeFilePath, content: markdown };
  if (noteSaveTimer !== null) {
    clearTimeout(noteSaveTimer);
  }
  noteSaveTimer = setTimeout(() => {
    noteSaveTimer = null;
    void saveNoteNow();
  }, NOTE_SAVE_DEBOUNCE_MS);
}

async function flushPendingNoteSave(): Promise<void> {
  if (noteSaveTimer !== null) {
    clearTimeout(noteSaveTimer);
    noteSaveTimer = null;
  }
  await saveNoteNow();
}

async function destroyNoteEditor(): Promise<void> {
  if (!noteEditor) return;
  // Match the shell's teardown: drop focus from inside the editor and suppress
  // re-entrant scheduleNoteSave calls while Milkdown is unmounting.
  const noteEditorEl = document.querySelector<HTMLElement>("#note-editor");
  const activeEl = document.activeElement;
  if (activeEl instanceof HTMLElement && noteEditorEl?.contains(activeEl)) {
    activeEl.blur();
  }
  const editor = noteEditor;
  noteEditor = null;
  isDestroyingNoteEditor = true;
  try {
    await editor.destroy();
  } catch (error) {
    console.warn("[riida] failed to destroy note editor:", error);
  } finally {
    isDestroyingNoteEditor = false;
  }
}

async function loadNoteForBook(filePath: string): Promise<void> {
  const noteRootEl = document.querySelector<HTMLElement>("#note-editor");
  if (!noteRootEl) return;
  if (noteState.activeFilePath === filePath && noteEditor) return;

  await flushPendingNoteSave();
  await destroyNoteEditor();

  noteState.isLoading = true;
  noteState.activeFilePath = filePath;
  noteState.currentContent = "";
  syncNoteUi();

  try {
    const note = await invoke<NoteDocument>("load_note", { filePath });
    noteState.activeFilePath = note.filePath;
    noteState.currentContent = note.content;

    const { mountNoteEditor } = await loadNoteEditorModule();
    noteEditor = await mountNoteEditor({
      root: noteRootEl,
      initialMarkdown: note.content,
      onMarkdownChange: (markdown) => {
        scheduleNoteSave(markdown);
      },
    });
  } catch (error) {
    console.error("[riida] failed to load note:", error);
  } finally {
    noteState.isLoading = false;
    syncNoteUi();
  }
}

function beginNoteDrag(event: PointerEvent): void {
  const target = event.target as HTMLElement | null;
  if (!target || target.closest("#note-close")) return;
  event.preventDefault();
  ensureNoteWindowPlacement();
  noteInteractionState.mode = "drag";
  noteInteractionState.edge = null;
  noteInteractionState.startX = event.clientX;
  noteInteractionState.startY = event.clientY;
  noteInteractionState.startLeft = noteState.x ?? 0;
  noteInteractionState.startTop = noteState.y ?? 0;
}

function beginNoteResize(event: PointerEvent, edge: string): void {
  event.preventDefault();
  ensureNoteWindowPlacement();
  noteInteractionState.mode = "resize";
  noteInteractionState.edge = edge;
  noteInteractionState.startX = event.clientX;
  noteInteractionState.startY = event.clientY;
  noteInteractionState.startLeft = noteState.x ?? 0;
  noteInteractionState.startTop = noteState.y ?? 0;
  noteInteractionState.startWidth = noteState.width;
  noteInteractionState.startHeight = noteState.height;
}

function updateNoteInteraction(event: PointerEvent): void {
  if (!noteInteractionState.mode) return;
  const dx = event.clientX - noteInteractionState.startX;
  const dy = event.clientY - noteInteractionState.startY;

  if (noteInteractionState.mode === "drag") {
    noteState.x = noteInteractionState.startLeft + dx;
    noteState.y = noteInteractionState.startTop + dy;
    clampNoteWindow();
    syncNoteUi();
    return;
  }

  const edge = noteInteractionState.edge ?? "";
  let nextLeft = noteInteractionState.startLeft;
  let nextTop = noteInteractionState.startTop;
  let nextWidth = noteInteractionState.startWidth;
  let nextHeight = noteInteractionState.startHeight;

  if (edge.includes("e")) {
    nextWidth = Math.max(NOTE_MIN_WIDTH, noteInteractionState.startWidth + dx);
  }
  if (edge.includes("s")) {
    nextHeight = Math.max(NOTE_MIN_HEIGHT, noteInteractionState.startHeight + dy);
  }
  if (edge.includes("w")) {
    nextWidth = Math.max(NOTE_MIN_WIDTH, noteInteractionState.startWidth - dx);
    nextLeft = noteInteractionState.startLeft + dx;
    if (nextWidth === NOTE_MIN_WIDTH) {
      nextLeft =
        noteInteractionState.startLeft + (noteInteractionState.startWidth - NOTE_MIN_WIDTH);
    }
  }
  if (edge.includes("n")) {
    nextHeight = Math.max(NOTE_MIN_HEIGHT, noteInteractionState.startHeight - dy);
    nextTop = noteInteractionState.startTop + dy;
    if (nextHeight === NOTE_MIN_HEIGHT) {
      nextTop =
        noteInteractionState.startTop + (noteInteractionState.startHeight - NOTE_MIN_HEIGHT);
    }
  }

  noteState.width = Math.min(nextWidth, window.innerWidth - 24);
  noteState.height = Math.min(nextHeight, window.innerHeight - 24);
  noteState.x = nextLeft;
  noteState.y = nextTop;
  clampNoteWindow();
  syncNoteUi();
}

function endNoteInteraction(): void {
  noteInteractionState.mode = null;
  noteInteractionState.edge = null;
}

function attachNotePanelInteractions(): void {
  const noteToggleEl = document.querySelector<HTMLButtonElement>("#note-toggle");
  const noteCloseEl = document.querySelector<HTMLButtonElement>("#note-close");
  const noteDragHandleEl = document.querySelector<HTMLElement>("#note-drag-handle");
  const notePanelEl = document.querySelector<HTMLElement>("#note-panel");

  noteToggleEl?.addEventListener("click", () => {
    if (!activeBookFilePath) return;
    noteState.isOpen = true;
    ensureNoteWindowPlacement();
    syncNoteUi();
    void loadNoteForBook(activeBookFilePath);
  });

  noteCloseEl?.addEventListener("click", () => {
    noteState.isOpen = false;
    void flushPendingNoteSave();
    syncNoteUi();
  });

  noteDragHandleEl?.addEventListener("pointerdown", (event) => {
    beginNoteDrag(event);
  });

  notePanelEl?.querySelectorAll<HTMLElement>(".note-resize-handle").forEach((handleEl) => {
    handleEl.addEventListener("pointerdown", (event) => {
      const edge = handleEl.dataset.resize ?? "";
      if (!edge) return;
      beginNoteResize(event, edge);
    });
  });

  window.addEventListener("pointermove", (event) => {
    updateNoteInteraction(event);
  });

  window.addEventListener("pointerup", () => {
    endNoteInteraction();
  });

  lastNoteViewport = { width: window.innerWidth, height: window.innerHeight };
  window.addEventListener("resize", () => {
    const next = { width: window.innerWidth, height: window.innerHeight };
    if (lastNoteViewport) {
      const moved = preserveNoteWindowBottomRightOffset(noteState, lastNoteViewport, next);
      noteState.x = moved.x;
      noteState.y = moved.y;
    }
    lastNoteViewport = next;
    clampNoteWindow();
    syncNoteUi();
  });

  window.addEventListener("beforeunload", () => {
    void flushPendingNoteSave();
  });
}

async function boot(): Promise<void> {
  const cachedTheme = loadPersistedAppTheme();
  if (cachedTheme) {
    applyAppTheme(cachedTheme);
  }

  const launch = readLaunchParams(window.location.search, window.__RIIDA_LAUNCH_PARAMS__);
  // The settings panel reloads the window; fall back to the session-persisted
  // params in case Tauri does not re-run its launch-param injection script.
  const persisted = launch.filePath ? null : readPersistedLaunchParams();
  const filePath = launch.filePath ?? persisted?.filePath ?? null;
  const source = launch.source ?? persisted?.source ?? null;

  document.body.dataset.startup = "ready";

  if (!filePath) {
    setStatus("No file specified.");
    return;
  }
  persistLaunchParams({ filePath, source });

  setStatus(`Loading ${source ? `${filePath} (source: ${source})` : filePath}...`);

  const scrollEl = document.querySelector<HTMLElement>("#main-pane");
  if (!scrollEl) {
    setStatus("Viewer container is missing from the document.");
    return;
  }

  attachNotePanelInteractions();

  if (looksLikeEpubPath(filePath)) {
    const epubViewerEl = document.querySelector<HTMLElement>("#epub-viewer");
    if (!epubViewerEl) {
      setStatus("EPUB viewer container is missing from the document.");
      return;
    }
    try {
      const { rendition, isRtl } = await renderEpubBook(filePath, epubViewerEl);
      setStatus(null);
      installEpubKeyboardNavigation(rendition, isRtl);
      void installViewerSettingsPanel(filePath, "epub");
      activeBookFilePath = filePath;
      syncNoteUi();
    } catch (error) {
      console.error("[riida] viewer window: failed to render EPUB:", error);
      setStatus(`Failed to render EPUB: ${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }

  const viewerEl = document.querySelector<HTMLElement>("#pdfjs-viewer");
  if (!viewerEl) {
    setStatus("Viewer container is missing from the document.");
    return;
  }

  try {
    const { spreadIndex, bindingDirection } = await renderPdfDocument(filePath, viewerEl, scrollEl);
    installReadingPositionPersistence(filePath, scrollEl, spreadIndex);
    installSpreadKeyboardNavigation(scrollEl, spreadIndex, bindingDirection);
    void installViewerSettingsPanel(filePath, "pdf");
    activeBookFilePath = filePath;
    syncNoteUi();
  } catch (error) {
    console.error("[riida] viewer window: failed to render PDF:", error);
    setStatus(`Failed to render PDF: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => void boot(), { once: true });
  } else {
    void boot();
  }
}

export const __testables = { readLaunchParams };
