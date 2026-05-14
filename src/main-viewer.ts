// Entry point for the standalone viewer window (v0.6.0 work-in-progress).
//
// The viewer window currently supports a minimal PDF rendering path so the
// multi-window plumbing can be exercised end-to-end. EPUB, viewer settings,
// notes, search, spread layout, lazy paging, and reading-position
// persistence will be migrated out of src/main.ts in follow-up commits.

import { convertFileSrc } from "@tauri-apps/api/core";
import "./vendor/fontawesome/css/fontawesome.min.css";
import "./vendor/fontawesome/css/solid.min.css";
import { applyAppTheme, loadPersistedAppTheme } from "./app-theme";
import { detectPdfBindingDirection } from "./pdf-binding-detect";
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

async function renderPdfPageCanvas(
  page: PdfPage,
  pageNumber: number,
  renderScale: number,
  devicePixelRatio: number,
): Promise<HTMLElement> {
  const viewport = page.getViewport({ scale: renderScale });

  const pageEl = document.createElement("div");
  pageEl.className = "pdfjs-page";
  pageEl.dataset.pageNumber = String(pageNumber);
  pageEl.style.width = `${viewport.width}px`;
  pageEl.style.height = `${viewport.height}px`;

  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width * devicePixelRatio);
  canvas.height = Math.floor(viewport.height * devicePixelRatio);
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
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
  return pageEl;
}

type SpreadIndexEntry = {
  spreadEl: HTMLElement;
  pageNumbers: readonly number[];
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

function restoreReadingPosition(
  filePath: string,
  scrollEl: HTMLElement,
  spreadIndex: readonly SpreadIndexEntry[],
): void {
  if (spreadIndex.length === 0) return;
  const cached = loadCachedReadingPosition(filePath);
  if (!cached) return;
  const target = findSpreadForPage(spreadIndex, cached.pageNumber);
  if (!target) return;
  const ratio = clampReadingPositionOffsetRatio(cached.pageOffsetRatio);
  scrollEl.scrollTop = target.spreadEl.offsetTop + ratio * target.spreadEl.offsetHeight;
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
): void {
  if (spreadIndex.length === 0) return;
  window.addEventListener("keydown", (event) => {
    if (event.defaultPrevented) return;
    const target = event.target as HTMLElement | null;
    if (target && (target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName))) {
      return;
    }
    const isNext =
      event.key === "PageDown" ||
      (event.key === " " && !event.shiftKey) ||
      event.key === "ArrowDown";
    const isPrev =
      event.key === "PageUp" || (event.key === " " && event.shiftKey) || event.key === "ArrowUp";
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

// Minimal renderer: build spread groups according to the resolved binding
// direction, lay them out as .pdfjs-spread rows, and render every page at a
// fixed scale. Lazy paging, fit-width/fit-height, text layers, search, and
// per-file viewer settings will follow.
async function renderPdfAllPages(
  filePath: string,
  viewerEl: HTMLElement,
  scrollEl: HTMLElement,
): Promise<SpreadIndexEntry[]> {
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
  const pdfDocument = await documentTask.promise;

  const detectedBinding = (await detectPdfBindingDirection(pdfDocument, () => false)) ?? "left";

  const layoutSettings: ViewerLayoutSettings = {
    pageMode: "spread",
    bindingDirection: detectedBinding,
    treatFirstPageAsCover: true,
  };
  const pageGroups = buildPageGroups(pdfDocument.numPages, layoutSettings);

  // Scale every page to fit the window's height. The shell uses the same
  // strategy in fit-height + spread mode and falls back to splitting spreads
  // whose combined width would still overflow the available width.
  const pageGap = 6;
  const viewerWidth = Math.max(scrollEl.clientWidth, 720);
  const viewerHeight = Math.max(scrollEl.clientHeight, 600);
  const availableWidth = viewerWidth - pageGap - 32;
  const targetHeight = Math.max(260, viewerHeight - 56);

  const layoutGroups: number[][] = [];
  for (const group of pageGroups) {
    if (group.length === 2 && group[0] !== undefined && group[1] !== undefined) {
      const g0 = group[0];
      const g1 = group[1];
      const vp0 = (await pdfDocument.getPage(g0)).getViewport({ scale: 1 });
      const vp1 = (await pdfDocument.getPage(g1)).getViewport({ scale: 1 });
      const fitScale = targetHeight / Math.max(vp0.height, 1);
      const combinedWidth = (vp0.width + vp1.width) * fitScale + pageGap;
      if (combinedWidth > availableWidth) {
        layoutGroups.push([g0]);
        layoutGroups.push([g1]);
        continue;
      }
    }
    layoutGroups.push(group);
  }

  viewerEl.innerHTML = "";
  viewerEl.dataset.filePath = filePath;
  viewerEl.dataset.position = detectedBinding;
  viewerEl.hidden = false;

  const devicePixelRatio = window.devicePixelRatio || 1;
  const spreadIndex: SpreadIndexEntry[] = [];

  for (const group of layoutGroups) {
    const visualOrder = getVisualPageOrder(group, layoutSettings);
    const spreadEl = document.createElement("div");
    spreadEl.className = "pdfjs-spread";
    spreadEl.dataset.pageCount = String(visualOrder.length);
    spreadEl.dataset.binding = detectedBinding;
    if (visualOrder.length === 1 && visualOrder[0] === 1) {
      spreadEl.dataset.cover = "true";
    }
    viewerEl.appendChild(spreadEl);

    const samplePage = await pdfDocument.getPage(group[0]!);
    const sampleViewport = samplePage.getViewport({ scale: 1 });
    const baseScale = targetHeight / Math.max(sampleViewport.height, 1);

    for (const pageNumber of visualOrder) {
      const page = await pdfDocument.getPage(pageNumber);
      const pageEl = await renderPdfPageCanvas(page, pageNumber, baseScale, devicePixelRatio);
      spreadEl.appendChild(pageEl);
    }

    // Record pages in document order so callers can match a saved page number
    // without caring about left/right binding.
    spreadIndex.push({ spreadEl, pageNumbers: [...group] });
  }
  return spreadIndex;
}

async function boot(): Promise<void> {
  const cachedTheme = loadPersistedAppTheme();
  if (cachedTheme) {
    applyAppTheme(cachedTheme);
  }

  const { filePath, source } = readLaunchParams(
    window.location.search,
    window.__RIIDA_LAUNCH_PARAMS__,
  );

  document.body.dataset.startup = "ready";

  if (!filePath) {
    setStatus("No file specified.");
    return;
  }

  setStatus(`Loading ${source ? `${filePath} (source: ${source})` : filePath}...`);

  const viewerEl = document.querySelector<HTMLElement>("#pdfjs-viewer");
  const scrollEl = document.querySelector<HTMLElement>("#main-pane");
  if (!viewerEl || !scrollEl) {
    setStatus("Viewer container is missing from the document.");
    return;
  }

  try {
    const spreadIndex = await renderPdfAllPages(filePath, viewerEl, scrollEl);
    setStatus(null);
    restoreReadingPosition(filePath, scrollEl, spreadIndex);
    installReadingPositionPersistence(filePath, scrollEl, spreadIndex);
    installSpreadKeyboardNavigation(scrollEl, spreadIndex);
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
