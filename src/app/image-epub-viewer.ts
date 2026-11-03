// Native viewer for image-sequence fixed-layout EPUBs (comics, scans).

import { clampEpubPageNumber } from "../epub-page-utils";
import {
  buildImageSpreads,
  computeImageFit,
  firstPageNumberOfSpread,
  type ImagePage,
  type Progression as ImageProgression,
  type ImageSpread,
  normalizeImagePages,
  spreadIndexForPage,
  visualSpreadOrder,
} from "../epub-image-layout-utils";
import { viewerColorPaletteForMode } from "../viewer-settings-utils";
import { destroyEpubBook } from "./epub-viewer";
import { releaseActivePdfDocument } from "./pdf-viewer";
import { appState, viewerSettings, viewerState } from "./state";
import {
  cacheReadingPosition,
  currentAppTheme,
  scheduleEpubPositionSave,
  syncNavigationHistory,
  syncViewerPageJumpUi,
} from "../main";

// Raw payload from the `epub_image_layout` Rust command.
export type EpubImageLayoutPayload = {
  is_image_epub: boolean;
  progression: string;
  pages: Array<{
    index: number;
    image_entry: string | null;
    spread_side: string;
    width: number;
    height: number;
  }>;
};
// Active image-sequence fixed-layout EPUB session (rendered natively, not via
// epub.js). Null for reflowable / non-image EPUBs and all other source types.
type ImageEpubSession = {
  filePath: string;
  pages: ImagePage[];
  spreads: ImageSpread[];
  progression: ImageProgression;
  spreadIndex: number;
  /** Rendered <img> elements of the current spread, in on-screen order. */
  imgEls: HTMLImageElement[];
};
export let activeImageEpub: ImageEpubSession | null = null;
// Per-file cache of the parsed layout so detection does not re-parse the zip on
// every renderCurrentPage (settings changes, re-renders).
export const imageEpubLayoutCache = new Map<string, EpubImageLayoutPayload>();

// --- image-sequence fixed-layout EPUB viewer -------------------------------

// Facing pages of a spread touch, matching the PDF viewer's `.pdfjs-spread`
// (gap: 0); each page carries its own shadow so a gutter still reads.
const EPUB_IMAGE_SPREAD_GAP = 0;
// Margin (px per side) kept clear around the spread so the page shadow is not
// clipped by the viewer's overflow:hidden.
const EPUB_IMAGE_STAGE_INSET = 24;

function imageEpubViewerElement(): HTMLElement | null {
  return document.querySelector<HTMLElement>("#epub-image-viewer");
}

/** riida-epub URL for one zip image entry (served by the Rust URI scheme). */
function imageEntryUrl(filePath: string, entry: string): string {
  return `riida-epub://localhost/img?file=${encodeURIComponent(filePath)}&entry=${encodeURIComponent(entry)}`;
}

export function destroyImageEpub() {
  activeImageEpub = null;
  const el = imageEpubViewerElement();
  if (el) {
    el.innerHTML = "";
    el.hidden = true;
    el.dataset.filePath = "";
  }
}

/** Size the current spread's <img> elements so the whole spread is contained
    in the stage and (for a two-page spread) both pages share height. */
export function fitImageEpubSpread() {
  const session = activeImageEpub;
  const el = imageEpubViewerElement();
  if (!session || !el || session.imgEls.length === 0) {
    return;
  }
  const spread = session.spreads[session.spreadIndex];
  if (!spread) return;
  const pages = visualSpreadOrder(spread, session.progression);

  const dims = pages.map((page, i) => {
    if (page.width > 0 && page.height > 0) {
      return { width: page.width, height: page.height };
    }
    const img = session.imgEls[i];
    if (img && img.naturalWidth > 0 && img.naturalHeight > 0) {
      return { width: img.naturalWidth, height: img.naturalHeight };
    }
    return { width: 0, height: 0 };
  });

  // Inset the fit area so the page shadow renders into the margin instead of
  // being clipped by the viewer's overflow:hidden (the PDF viewer reserves
  // padding for the same reason).
  const inset = 2 * EPUB_IMAGE_STAGE_INSET;
  const boxes = computeImageFit(
    { width: el.clientWidth - inset, height: el.clientHeight - inset },
    dims,
    EPUB_IMAGE_SPREAD_GAP,
  );
  session.imgEls.forEach((img, i) => {
    const box = boxes[i];
    if (box && box.widthPx > 0 && box.heightPx > 0) {
      img.style.width = `${box.widthPx}px`;
      img.style.height = `${box.heightPx}px`;
    } else {
      // Unknown dimensions: fall back to CSS contain (see styles.css).
      img.style.removeProperty("width");
      img.style.removeProperty("height");
    }
  });
}

/** Render the DOM for the session's current spread. */
function renderImageSpreadDom(session: ImageEpubSession) {
  const el = imageEpubViewerElement();
  if (!el) return;
  const spread = session.spreads[session.spreadIndex];
  if (!spread) return;
  const pages = visualSpreadOrder(spread, session.progression);

  const container = document.createElement("div");
  container.className = "epub-image-spread";
  container.style.setProperty("--epub-image-gap", `${EPUB_IMAGE_SPREAD_GAP}px`);

  session.imgEls = pages.map((page) => {
    const img = document.createElement("img");
    img.className = "epub-image-page";
    img.decoding = "async";
    img.draggable = false;
    if (page.imageEntry) {
      img.src = imageEntryUrl(session.filePath, page.imageEntry);
    }
    // Re-fit once natural dimensions are known (covers pages with no OPF dims).
    img.addEventListener("load", () => {
      if (activeImageEpub === session) {
        fitImageEpubSpread();
      }
    });
    container.appendChild(img);
    return img;
  });

  el.replaceChildren(container);
  fitImageEpubSpread();
}

/** Switch the active image EPUB to the spread at `index`. */
function showImageSpread(
  session: ImageEpubSession,
  index: number,
  options: { pushHistory?: boolean; save?: boolean } = {},
) {
  const { pushHistory = false, save = true } = options;
  if (session.spreads.length === 0) return;
  const clamped = Math.min(Math.max(index, 0), session.spreads.length - 1);
  session.spreadIndex = clamped;
  renderImageSpreadDom(session);

  const pageNumber = firstPageNumberOfSpread(session.spreads[clamped]!);

  if (pushHistory) {
    syncNavigationHistory("replace");
  }
  appState.activeReadingPosition = {
    filePath: session.filePath,
    pageNumber,
    pageOffsetRatio: 0,
    cfi: null,
    updatedAt: appState.activeReadingPosition?.updatedAt ?? null,
  };
  cacheReadingPosition(appState.activeReadingPosition);
  if (pushHistory) {
    syncNavigationHistory("push");
  }

  syncViewerPageJumpUi();
  if (save) {
    scheduleEpubPositionSave();
  }
}

/** Rebuild the active image EPUB's spreads for the current page-mode and
    re-apply the viewer background, keeping the reader on the current page.
    Called when viewer settings change. No-op unless an image EPUB is active. */
export function rebuildImageEpub() {
  const session = activeImageEpub;
  if (!session) return;
  const el = imageEpubViewerElement();
  if (el) {
    const palette = viewerColorPaletteForMode(viewerSettings.backgroundMode, currentAppTheme());
    el.style.backgroundColor = palette.background;
  }
  const currentPage = appState.activeReadingPosition?.pageNumber ?? 1;
  session.spreads = buildImageSpreads(session.pages, session.progression, viewerSettings.pageMode);
  goToImagePage(currentPage, { pushHistory: false });
}

/** Advance the active image EPUB by `delta` spreads (reading order). */
export function goToImageSpread(delta: number) {
  const session = activeImageEpub;
  if (!session) return;
  showImageSpread(session, session.spreadIndex + delta);
}

/** Jump the active image EPUB to the spread containing a 1-based page number. */
export function goToImagePage(pageNumber: number, options: { pushHistory?: boolean } = {}) {
  const session = activeImageEpub;
  if (!session) return;
  const pageIndex = clampEpubPageNumber(pageNumber, session.pages.length) - 1;
  const index = spreadIndexForPage(session.spreads, pageIndex);
  showImageSpread(session, index, { pushHistory: options.pushHistory });
}

/** Set up and render an image-sequence fixed-layout EPUB from the layout payload. */
export function renderImageEpub(payload: EpubImageLayoutPayload) {
  const currentBook = viewerState.currentBook;
  const el = imageEpubViewerElement();
  if (!currentBook || !el) return;

  // Tear down any epub.js / PDF viewer state and switch containers.
  destroyEpubBook();
  releaseActivePdfDocument();
  appState.activePdfOutline = null;
  const frame = document.querySelector<HTMLIFrameElement>("#pdf-frame");
  if (frame) {
    frame.hidden = true;
    frame.src = "about:blank";
    frame.dataset.filePath = "";
  }
  const pdfjsViewerEl = document.querySelector<HTMLElement>("#pdfjs-viewer");
  if (pdfjsViewerEl) {
    pdfjsViewerEl.hidden = true;
    pdfjsViewerEl.innerHTML = "";
    pdfjsViewerEl.dataset.filePath = "";
  }

  const progression: ImageProgression = payload.progression === "rtl" ? "rtl" : "ltr";
  const pages = normalizeImagePages(payload.pages);
  const spreads = buildImageSpreads(pages, progression, viewerSettings.pageMode);

  appState.activeEpubTotalPages = Math.max(pages.length, 1);
  appState.activeEpubIsRtl = progression === "rtl";

  const session: ImageEpubSession = {
    filePath: currentBook.filePath,
    pages,
    spreads,
    progression,
    spreadIndex: 0,
    imgEls: [],
  };
  activeImageEpub = session;

  el.hidden = false;
  el.dataset.filePath = currentBook.filePath;
  const palette = viewerColorPaletteForMode(viewerSettings.backgroundMode, currentAppTheme());
  el.style.backgroundColor = palette.background;

  // Restore to the saved page (or page 1). Stale CFI-only positions saved by the
  // old epub.js path have page_number 0, so clamp up to 1.
  const restorePage = Math.max(appState.activeReadingPosition?.pageNumber ?? 1, 1);
  goToImagePage(restorePage, { pushHistory: false });
  // Persist the normalized page-based position for this opening.
  scheduleEpubPositionSave();
}
