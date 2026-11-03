// epub.js renderer for reflowable and non-image EPUBs.

import { invoke } from "@tauri-apps/api/core";
import { message } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { epubPageNumberFromLocation } from "../epub-page-utils";
import { loadCachedEpubLocations, saveCachedEpubLocations } from "../epub-locations-cache";
import { loadEpubJs } from "../epub-runtime";
import { resolveEpubLinkAction } from "../epub-link-routing";
import { clampEpubFontSize } from "../viewer-shortcuts";
import { viewerColorPaletteForMode, type ViewerSettingsPayload } from "../viewer-settings-utils";
import {
  destroyImageEpub,
  type EpubImageLayoutPayload,
  imageEpubLayoutCache,
  renderImageEpub,
} from "./image-epub-viewer";
import { syncNavigationHistory } from "./navigation";
import { releaseActivePdfDocument } from "./pdf-viewer";
import { scheduleEpubPositionSave } from "./reading-position";
import {
  appState,
  viewerSettings,
  viewerState,
  currentAppTheme,
  currentViewerSettingsSourceType,
} from "./state";
import { buildEpubToc, syncTocUi } from "./toc";
import {
  applyEpubColorsToDocument,
  applyEpubFontSize,
  applyEpubViewerColors,
  applyViewerSettingsPayload,
  applyViewerVerticalGapMode,
  currentViewerPreferences,
  resizeEpubRendition,
  setViewerDraft,
  syncViewerSettingsUi,
} from "./viewer-settings";
import { syncViewerPageJumpUi } from "./viewer";

let epubRenderToken = 0;
let activeEpubLinkMessageHandler: ((event: MessageEvent) => void) | null = null;

// WKWebView does not recognize the -epub-writing-mode vendor prefix, so
// vertical-text EPUBs render horizontally. Scan each section's stylesheets and
// inject a companion <style> that mirrors every -epub-writing-mode declaration
// as a standard writing-mode declaration, which WKWebView does understand.
function injectEpubWritingModeCSS(doc: Document) {
  const EPUB_PROP = "-epub-writing-mode";
  const STD_PROP = "writing-mode";

  let extraRules = "";

  for (const styleEl of Array.from(doc.querySelectorAll("style"))) {
    const sheet = styleEl.sheet;
    if (!sheet) continue;
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSStyleRule)) continue;
      const epubVal = rule.style.getPropertyValue(EPUB_PROP).trim();
      if (!epubVal) continue;
      // Only add writing-mode if not already declared by the book's CSS.
      const alreadyHasStd = rule.style.getPropertyValue(STD_PROP).trim() !== "";
      if (alreadyHasStd) continue;
      extraRules += `${rule.selectorText}{${STD_PROP}:${epubVal}}\n`;
    }
  }

  // Also handle inline styles.
  for (const el of Array.from(doc.querySelectorAll<HTMLElement>("[style]"))) {
    const epubVal = el.style.getPropertyValue(EPUB_PROP).trim();
    if (!epubVal) continue;
    if (el.style.getPropertyValue(STD_PROP).trim() !== "") continue;
    el.style.setProperty(STD_PROP, epubVal);
  }

  if (extraRules) {
    const injected = doc.createElement("style");
    injected.dataset.riidaInjected = "writing-mode";
    injected.textContent = extraRules;
    (doc.head ?? doc.documentElement)?.appendChild(injected);
  }
}

// Overlay a full-bleed <img> on top of the epub viewer when the rendered
// section is a cover page. This sidesteps epub.js's multi-column layout,
// which constrains in-iframe images to a single column and makes them
// impossible to scale reliably via CSS alone.
function syncEpubCoverOverlay(epubViewerEl: HTMLElement) {
  const iframes = epubViewerEl.querySelectorAll<HTMLIFrameElement>("iframe");
  let coverSrc: string | null = null;
  let coverAlt = "";

  for (const iframe of iframes) {
    const body = iframe.contentDocument?.body;
    if (!body) continue;
    const epubType = body.getAttribute("epub:type") ?? "";
    const isCover = epubType.split(/\s+/).includes("cover") || body.classList.contains("coverimg");
    if (!isCover) {
      body.style.removeProperty("visibility");
      continue;
    }
    body.style.setProperty("visibility", "hidden", "important");
    const imgEl = body.querySelector<HTMLImageElement>("img");
    if (imgEl?.src && !coverSrc) {
      coverSrc = imgEl.src;
      coverAlt = imgEl.alt;
    }
  }

  let overlay = epubViewerEl.querySelector<HTMLImageElement>(":scope > .epub-cover-overlay");

  if (!coverSrc) {
    overlay?.remove();
    return;
  }

  if (!overlay) {
    overlay = document.createElement("img");
    overlay.className = "epub-cover-overlay";
    epubViewerEl.appendChild(overlay);
  }
  if (overlay.src !== coverSrc) {
    overlay.src = coverSrc;
  }
  overlay.alt = coverAlt;
}

const EPUB_PREVIEW_NOTICE_STORAGE_KEY = "riida.epub.previewNoticeShown";

async function maybeShowEpubPreviewNotice(): Promise<void> {
  try {
    if (window.localStorage.getItem(EPUB_PREVIEW_NOTICE_STORAGE_KEY) === "1") {
      return;
    }
  } catch {
    // localStorage unavailable — fall through and show the notice once.
  }
  try {
    await message("EPUBは開発中です。リンクは機能せず、画面が乱れる可能性があります。", {
      title: "EPUB (開発中)",
      kind: "warning",
    });
  } catch {
    // Ignore dialog failures; we still record that we tried to show it.
  }
  try {
    window.localStorage.setItem(EPUB_PREVIEW_NOTICE_STORAGE_KEY, "1");
  } catch {
    // localStorage unavailable — the notice will show again next time.
  }
}

export function isEpubNextPageKey(event: KeyboardEvent): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  return event.key === "PageDown" || event.key === "ArrowDown" || event.key === "ArrowRight";
}

export function isEpubPrevPageKey(event: KeyboardEvent): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  return event.key === "PageUp" || event.key === "ArrowUp" || event.key === "ArrowLeft";
}

export function currentEpubFontSize(): number {
  return clampEpubFontSize(currentViewerPreferences().epubFontSize);
}

export function applyEpubFontSizeShortcut(nextSize: number) {
  if (viewerState.currentBook?.sourceType !== "epub") {
    return;
  }
  const clamped = clampEpubFontSize(nextSize);
  applyEpubFontSize(clamped);

  const draft = { ...currentViewerPreferences(), epubFontSize: clamped };
  setViewerDraft(viewerSettings.scope, draft);
  syncViewerSettingsUi();

  const currentFilePath = viewerState.currentBook.filePath;
  const sourceType = currentViewerSettingsSourceType() ?? viewerSettings.sourceType;
  void (async () => {
    try {
      if (viewerSettings.scope === "file" && currentFilePath) {
        const payload = await invoke<ViewerSettingsPayload>("save_file_viewer_preferences", {
          filePath: currentFilePath,
          sourceType,
          preferences: draft,
        });
        applyViewerSettingsPayload(payload, sourceType, "file");
      } else {
        const payload = await invoke<ViewerSettingsPayload>("save_default_viewer_preferences", {
          currentFilePath,
          sourceType,
          preferences: draft,
        });
        applyViewerSettingsPayload(payload, sourceType, "global");
      }
    } catch (error) {
      console.error("Failed to save EPUB font-size shortcut:", error);
    }
  })();
}

export function destroyEpubBook() {
  if (activeEpubLinkMessageHandler) {
    window.removeEventListener("message", activeEpubLinkMessageHandler);
    activeEpubLinkMessageHandler = null;
  }
  appState.activeEpubTotalPages = null;
  appState.activeEpubRendition = null;
  appState.activeEpubIsRtl = false;
  appState.tocPanelOpen = false;
  if (appState.activeEpubBook) {
    appState.activeEpubBook.destroy();
    appState.activeEpubBook = null;
  }
  epubRenderToken += 1;
  const epubViewerEl = document.querySelector<HTMLElement>("#epub-viewer");
  if (epubViewerEl) {
    epubViewerEl.innerHTML = "";
    epubViewerEl.hidden = true;
    epubViewerEl.dataset.filePath = "";
  }
}

type EpubLinkMessage = {
  type: "riida:epub-link";
  href: string;
  filePath: string;
  sectionIndex: number;
};

function isEpubLinkMessage(value: unknown): value is EpubLinkMessage {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    record.type === "riida:epub-link" &&
    typeof record.href === "string" &&
    typeof record.filePath === "string" &&
    typeof record.sectionIndex === "number"
  );
}

function installEpubLinkBridge(contents: import("epubjs").Contents, filePath: string) {
  const doc = contents.document;
  if (!doc?.documentElement) {
    return;
  }

  doc.documentElement.dataset.riidaFilePath = filePath;
  doc.documentElement.dataset.riidaSectionIndex = String(contents.sectionIndex);
}

export function captureEpubCfiForHistory(rendition: import("epubjs").Rendition) {
  try {
    const loc = rendition.location as { start?: { cfi?: string } } | null;
    const cfi = loc?.start?.cfi;
    if (cfi && appState.activeReadingPosition) {
      appState.activeReadingPosition = { ...appState.activeReadingPosition, cfi };
    }
  } catch {
    // rendition may not have a location yet; skip silently
  }
}

async function epubDisplayHref(
  book: import("epubjs").Book,
  rendition: import("epubjs").Rendition,
  target: string,
) {
  // Prefer CFI-based navigation to avoid paginated-layout breakage on anchor
  // jumps. epub.js's rendition.display(href) can reset the paginator to a
  // single-page view when the href contains a fragment; going through CFI
  // preserves the spread/paginated flow.
  try {
    const bookLocations = book.locations as unknown as {
      cfiFromHref?: (href: string) => string | null;
    };
    const cfi = bookLocations.cfiFromHref?.(target);
    if (cfi) {
      await rendition.display(cfi);
      return;
    }
  } catch {
    // fall through to plain href display
  }
  await rendition.display(target);
}

function syncEpubLinkOverlays(
  rendition: import("epubjs").Rendition,
  book: import("epubjs").Book,
  epubViewerEl: HTMLElement,
) {
  let overlayRoot = epubViewerEl.querySelector<HTMLElement>(".epub-link-overlays");
  if (!overlayRoot) {
    overlayRoot = document.createElement("div");
    overlayRoot.className = "epub-link-overlays";
    epubViewerEl.appendChild(overlayRoot);
  }

  overlayRoot.innerHTML = "";
  const viewerRect = epubViewerEl.getBoundingClientRect();
  const contentsList = rendition.getContents() as unknown as import("epubjs").Contents[];

  for (const contents of contentsList) {
    const frameEl = contents.window?.frameElement;
    if (!(frameEl instanceof HTMLIFrameElement)) {
      continue;
    }

    const frameRect = frameEl.getBoundingClientRect();
    const links = contents.document
      ? (Array.from(contents.document.querySelectorAll("a[href]")) as HTMLAnchorElement[])
      : null;
    if (!links) {
      continue;
    }

    for (const link of links) {
      const href = link.getAttribute("href");
      if (!href) {
        continue;
      }

      const rect = link.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        continue;
      }

      const action = resolveEpubLinkAction(
        href,
        book.spine.get(contents.sectionIndex)?.href ?? null,
      );
      if (!action) {
        continue;
      }

      const overlay = document.createElement("button");
      overlay.type = "button";
      overlay.className = "epub-link-overlay";
      overlay.style.left = `${frameRect.left - viewerRect.left + rect.left}px`;
      overlay.style.top = `${frameRect.top - viewerRect.top + rect.top}px`;
      overlay.style.width = `${rect.width}px`;
      overlay.style.height = `${rect.height}px`;
      overlay.setAttribute("aria-label", href);
      overlay.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (action.kind === "external") {
          void openUrl(action.target);
          return;
        }
        captureEpubCfiForHistory(rendition);
        syncNavigationHistory("push");
        void epubDisplayHref(book, rendition, action.target);
      });
      overlayRoot.appendChild(overlay);
    }
  }
}

export async function renderEpubBook(
  frame: HTMLIFrameElement,
  pdfjsViewerEl: HTMLElement,
  epubViewerEl: HTMLElement,
  sourceUrl: string,
) {
  if (!viewerState.currentBook) {
    return;
  }

  // Image-sequence fixed-layout EPUBs (comics / scans: every page a single
  // image) get the lightweight native image viewer instead of epub.js.
  const epubFilePath = viewerState.currentBook.filePath;
  let imageLayout = imageEpubLayoutCache.get(epubFilePath);
  if (!imageLayout) {
    try {
      imageLayout = await invoke<EpubImageLayoutPayload>("epub_image_layout", {
        filePath: epubFilePath,
      });
      imageEpubLayoutCache.set(epubFilePath, imageLayout);
    } catch (error) {
      console.warn("[riida] epub_image_layout failed:", error);
    }
  }
  if (viewerState.currentBook?.filePath !== epubFilePath) {
    return;
  }
  if (imageLayout?.is_image_epub) {
    renderImageEpub(imageLayout);
    return;
  }
  destroyImageEpub();

  applyEpubViewerColors(viewerSettings.backgroundMode);
  await maybeShowEpubPreviewNotice();
  destroyEpubBook();
  releaseActivePdfDocument();
  appState.activePdfOutline = null;
  frame.hidden = true;
  frame.src = "about:blank";
  frame.dataset.filePath = "";
  pdfjsViewerEl.hidden = true;
  pdfjsViewerEl.innerHTML = "";
  pdfjsViewerEl.dataset.filePath = "";
  epubViewerEl.hidden = false;
  epubViewerEl.dataset.filePath = viewerState.currentBook.filePath;
  epubViewerEl.innerHTML = "";
  const epubLoadingEl = document.createElement("div");
  epubLoadingEl.className = "epub-loading";
  const epubLoadingSpinnerEl = document.createElement("div");
  epubLoadingSpinnerEl.className = "epub-loading-spinner";
  epubLoadingEl.appendChild(epubLoadingSpinnerEl);
  const epubLoadingLabelEl = document.createElement("div");
  epubLoadingLabelEl.className = "epub-loading-label";
  epubLoadingLabelEl.textContent = "Loading EPUB...";
  epubLoadingEl.appendChild(epubLoadingLabelEl);
  epubViewerEl.appendChild(epubLoadingEl);

  epubRenderToken += 1;
  const currentToken = epubRenderToken;

  try {
    const EpubModule = await loadEpubJs();
    if (currentToken !== epubRenderToken) return;

    const Epub = EpubModule.default;
    const book = Epub(sourceUrl);
    appState.activeEpubBook = book;
    await book.ready;
    if (currentToken !== epubRenderToken) return;

    appState.tocPanelOpen = false;
    buildEpubToc();
    syncTocUi();

    // Fast path: reuse previously-generated locations when the file
    // hasn't changed. Falls back to background generation after display.
    const locationsFilePath = viewerState.currentBook.filePath;
    const locationsFileSize = viewerState.currentBook.fileSize;
    const cachedLocations = loadCachedEpubLocations(locationsFilePath, locationsFileSize);
    let locationsReady = false;
    if (cachedLocations) {
      try {
        book.locations.load(cachedLocations);
        appState.activeEpubTotalPages = Math.max(book.locations.length(), 1);
        locationsReady = true;
      } catch (err) {
        console.warn("[riida] failed to load cached EPUB locations:", err);
      }
    }
    syncViewerPageJumpUi();

    // Detect page-progression-direction for correct key mapping.
    // DPFJ guide §ページ進行方向の遵守: direction is from OPF spine, not writing-mode.
    // In rtl books (Japanese vertical text etc.) ArrowLeft = next page, ArrowRight = prev.
    // epub.js exposes package/spine internals not covered by the public typings.
    const bookInternal = book as unknown as {
      spine?: { direction?: string };
      package?: { metadata?: { direction?: string; rendition_layout?: string } };
    };
    const spineDirection =
      bookInternal.spine?.direction ?? bookInternal.package?.metadata?.direction ?? "ltr";
    appState.activeEpubIsRtl = spineDirection === "rtl";

    // Detect fixed-layout vs. reflow from OPF metadata.
    // DPFJ guide §固定レイアウト: pre-paginated books use SVG-wrapped images and
    // require flow:"pre-paginated" so epub.js renders each spine item as a single page.
    const renditionLayout = bookInternal.package?.metadata?.rendition_layout ?? "";
    const isPrePaginated = renditionLayout === "pre-paginated";
    const flow: string = isPrePaginated ? "pre-paginated" : "paginated";
    const spread = isPrePaginated
      ? "auto"
      : viewerSettings.pageMode === "spread"
        ? "always"
        : "none";

    book.spine.hooks.content.register((doc: Document, section: { index: number }) => {
      doc.documentElement?.setAttribute(
        "data-riida-file-path",
        viewerState.currentBook?.filePath ?? "",
      );
      doc.documentElement?.setAttribute("data-riida-section-index", String(section.index));
    });

    // Ensure the viewer element has actually been laid out before
    // creating the rendition. WKWebView occasionally reports 0 for
    // clientWidth/clientHeight on the first frame after show; epub.js
    // then locks the stage to 0x0 and never recovers. Poll up to ~20
    // frames for a non-zero size so the stage starts at the right size.
    for (let attempts = 0; attempts < 20; attempts += 1) {
      if (epubViewerEl.clientWidth > 0 && epubViewerEl.clientHeight > 0) break;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (currentToken !== epubRenderToken) return;
    }

    const rendition = book.renderTo(epubViewerEl, {
      width: "100%",
      height: "100%",
      spread,
      flow,
      allowScriptedContent: true,
    });

    const epubThemePalette = viewerColorPaletteForMode(
      viewerSettings.backgroundMode,
      currentAppTheme(),
    );
    rendition.themes.default({
      html: {
        "background-color": `${epubThemePalette.background} !important`,
        color: `${epubThemePalette.foreground} !important`,
      },
      // DPFJ guide §ページメディアの余白: RS should not add its own margins to body.
      // epub.js injects padding by default; suppress it so the book's own CSS controls spacing.
      body: {
        "background-color": `${epubThemePalette.background} !important`,
        color: `${epubThemePalette.foreground} !important`,
        padding: "0 !important",
        margin: "0 !important",
      },
      a: {
        color: `${epubThemePalette.link} !important`,
      },
      pre: {
        "white-space": "pre-wrap !important",
        "word-break": "break-all !important",
        "overflow-wrap": "break-word !important",
      },
      code: {
        "word-break": "break-all !important",
        "overflow-wrap": "break-word !important",
      },
    });

    const contentHooks = rendition.hooks.content.list();
    if (contentHooks.length > 0) {
      rendition.hooks.content.deregister(contentHooks[0]);
    }

    rendition.hooks.content.register((contents: import("epubjs").Contents) => {
      try {
        installEpubLinkBridge(contents, viewerState.currentBook?.filePath ?? "");
        if (contents.document) {
          applyEpubColorsToDocument(
            contents.document,
            viewerColorPaletteForMode(viewerSettings.backgroundMode, currentAppTheme()),
          );
          injectEpubWritingModeCSS(contents.document);
        }
      } catch (err) {
        console.error("[riida] epub link hook failed:", err);
      }
    });

    activeEpubLinkMessageHandler = (event: MessageEvent) => {
      if (currentToken !== epubRenderToken || !isEpubLinkMessage(event.data)) {
        return;
      }

      const currentBook = viewerState.currentBook;
      if (!currentBook || currentBook.sourceType !== "epub") {
        return;
      }

      if (event.data.filePath !== currentBook.filePath) {
        return;
      }

      const sectionHref = book.spine.get(event.data.sectionIndex)?.href ?? null;
      const action = resolveEpubLinkAction(event.data.href, sectionHref);
      if (!action) {
        return;
      }

      if (action.kind === "external") {
        void openUrl(action.target);
        return;
      }

      captureEpubCfiForHistory(rendition);
      syncNavigationHistory("push");
      void epubDisplayHref(book, rendition, action.target);
    };
    window.addEventListener("message", activeEpubLinkMessageHandler);

    const restoreCfi = appState.activeReadingPosition?.cfi ?? undefined;
    await rendition.display(restoreCfi);
    if (currentToken !== epubRenderToken) return;

    appState.activeEpubRendition = rendition;
    applyViewerVerticalGapMode(viewerSettings.verticalGapMode);
    applyEpubViewerColors(viewerSettings.backgroundMode);
    applyEpubFontSize(viewerSettings.epubFontSize);

    // Safety net: if the initial render ended up at zero dimensions
    // (WKWebView can report 0 clientWidth/Height on first attach),
    // force resize + redisplay before hiding the spinner. epub.js's
    // own onResized only re-displays when rendition.location is set,
    // which can fail to happen after a 0x0 initial render.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    if (currentToken !== epubRenderToken) return;
    const iframeEl = epubViewerEl.querySelector<HTMLIFrameElement>("iframe");
    if (!iframeEl || iframeEl.clientWidth === 0 || iframeEl.clientHeight === 0) {
      resizeEpubRendition();
      try {
        await rendition.display(restoreCfi);
      } catch (err) {
        console.warn("[riida] epub redisplay after resize failed:", err);
      }
      if (currentToken !== epubRenderToken) return;
    }

    syncEpubLinkOverlays(rendition, book, epubViewerEl);
    epubLoadingEl.remove();

    // Slow path: compute pagination in the background so the first
    // page renders immediately. Result is cached for next open.
    if (!locationsReady) {
      void (async () => {
        try {
          await book.locations.generate(1200);
          if (currentToken !== epubRenderToken) return;
          appState.activeEpubTotalPages = Math.max(book.locations.length(), 1);
          saveCachedEpubLocations(locationsFilePath, locationsFileSize, book.locations.save());
          syncViewerPageJumpUi();
        } catch (err) {
          console.warn("[riida] failed to generate EPUB locations:", err);
        }
      })();
    }

    rendition.on("relocated", (location: import("epubjs").Location) => {
      const cfi = location.start.cfi;
      const currentBook = viewerState.currentBook;
      if (!cfi || !currentBook || currentBook.sourceType !== "epub") return;
      const totalPages = appState.activeEpubTotalPages ?? Math.max(book.locations.length(), 1);
      const currentPageNumber = epubPageNumberFromLocation(location.start.location, totalPages);
      appState.activeReadingPosition = {
        filePath: currentBook.filePath,
        pageNumber: currentPageNumber,
        pageOffsetRatio: 0,
        cfi,
        updatedAt: appState.activeReadingPosition?.updatedAt ?? null,
      };
      syncEpubLinkOverlays(rendition, book, epubViewerEl);
      syncViewerPageJumpUi();
      scheduleEpubPositionSave();
    });

    rendition.on("rendered", () => {
      syncEpubLinkOverlays(rendition, book, epubViewerEl);
      syncEpubCoverOverlay(epubViewerEl);
    });
  } catch (error) {
    if (currentToken !== epubRenderToken) return;
    epubViewerEl.innerHTML = "";
    const errorEl = document.createElement("div");
    errorEl.className = "pdfjs-loading";
    errorEl.textContent = `Failed to open EPUB: ${String(error)}`;
    epubViewerEl.appendChild(errorEl);
  }
}

export function initEpubFocusGuard() {
  // When the EPUB viewer is active, prevent keyboard focus from being
  // captured by the epub.js iframe.  If the window loses focus to one of
  // those iframes, return focus to the window so that the global keydown
  // handler above keeps working.
  // Deferred with setTimeout(0) so the focus steal happens after any click
  // sequence (mousedown → mouseup → click) completes — otherwise stealing
  // focus during mousedown would suppress the click event in the iframe.
  window.addEventListener("blur", () => {
    if (!appState.activeEpubRendition) return;
    const epubViewerEl = document.querySelector("#epub-viewer");
    const active = document.activeElement;
    if (active instanceof HTMLIFrameElement && epubViewerEl?.contains(active)) {
      setTimeout(() => {
        if (appState.activeEpubRendition) window.focus();
      }, 0);
    }
  });
}
