// Document viewer entry points: opening a book, dispatching to the PDF/EPUB
// renderers, page jumps, and viewer chrome.

import { convertFileSrc } from "@tauri-apps/api/core";
import { clampEpubPageNumber, epubLocationIndexFromPageNumber } from "../epub-page-utils";
import { parseRequestedPageNumber } from "../page-jump-utils";
import { preserveNoteWindowBottomRightOffset } from "../note-window-utils";
import { DEFAULT_VIEWER_SETTINGS } from "../viewer-settings-utils";
import { captureEpubCfiForHistory, destroyEpubBook, renderEpubBook } from "./epub-viewer";
import { destroyImageEpub, fitImageEpubSpread, goToImagePage } from "./image-epub-viewer";
import { renderApp } from "./library";
import { openBookMetadataEditor } from "./metadata-editor";
import { syncNavigationHistory } from "./navigation";
import {
  clampNoteWindow,
  destroyNoteEditor,
  flushPendingNoteSave,
  loadNoteForCurrentBook,
  noteState,
  shouldAnchorNoteWindowToBottomRight,
  syncNoteUi,
} from "./notes";
import { closePdfSearch } from "./pdf-search-highlights";
import {
  findPdfRenderGroupIndexForPage,
  releaseActivePdfDocument,
  renderPdfJsBook,
  resetPdfZoomScaleForBook,
  schedulePdfRenderWindowUpdate,
} from "./pdf-viewer";
import {
  cacheReadingPosition,
  captureReadingPositionFromViewer,
  flushReadingPositionSave,
  loadReadingPositionForCurrentBook,
  scheduleReadingPositionRestore,
} from "./reading-position";
import { currentViewerStage } from "./dom";
import { appState, viewerSettings, viewerState } from "./state";
import { openTagEditor } from "./tag-editor";
import type { BookSummary, LibrarySnapshot } from "./types";
import {
  applyEpubViewerColors,
  applyPdfViewerBackground,
  applyViewerPreferences,
  loadViewerSettingsForCurrentBook,
  resizeEpubRendition,
  syncViewerSettingsUi,
} from "./viewer-settings";

type ViewerPageJumpState = {
  input: string;
};

let pdfRenderResizeTimer: number | null = null;

const viewerPageJumpState: ViewerPageJumpState = {
  input: "",
};

let lastViewportSize = {
  width: window.innerWidth,
  height: window.innerHeight,
};

function currentViewerPageNumber() {
  if (!viewerState.currentBook) {
    return null;
  }

  if (viewerState.currentBook.sourceType === "epub") {
    return appState.activeReadingPosition?.pageNumber ?? (appState.activeEpubTotalPages ? 1 : null);
  }

  return appState.activeReadingPosition?.pageNumber ?? 1;
}

export function currentViewerTotalPages() {
  const currentBook = viewerState.currentBook;
  if (!currentBook) {
    return null;
  }

  if (currentBook.sourceType === "epub") {
    return appState.activeEpubTotalPages;
  }

  return appState.activePdfRenderSession?.pdfDocument.numPages ?? null;
}

export function syncViewerPageJumpUi() {
  const pageJumpEl = document.querySelector<HTMLElement>("#viewer-page-jump");
  const formEl = document.querySelector<HTMLFormElement>("#viewer-page-jump-form");
  const inputEl = document.querySelector<HTMLInputElement>("#viewer-page-jump-input");
  const totalEl = document.querySelector<HTMLElement>("#viewer-page-jump-total");
  const currentPageNumber = currentViewerPageNumber();
  const totalPages = currentViewerTotalPages();

  if (!pageJumpEl || !formEl || !inputEl || !totalEl) {
    return;
  }

  const shouldShow = Boolean(viewerState.currentBook);
  pageJumpEl.hidden = !shouldShow;
  formEl.hidden = !shouldShow;

  if (!shouldShow || currentPageNumber === null) {
    totalEl.textContent = "";
    return;
  }

  totalEl.textContent = totalPages ? `/ ${totalPages}` : "";

  if (document.activeElement !== inputEl) {
    viewerPageJumpState.input = String(currentPageNumber);
    inputEl.value = viewerPageJumpState.input;
  } else if (inputEl.value !== viewerPageJumpState.input) {
    inputEl.value = viewerPageJumpState.input;
  }
}

export function navigateViewerToPage(pageNumber: number, options: { pushHistory?: boolean } = {}) {
  const currentBook = viewerState.currentBook;

  if (!currentBook) {
    return;
  }

  const { pushHistory = true } = options;

  if (currentBook.sourceType === "epub") {
    if (appState.activeImageEpub) {
      goToImagePage(pageNumber, { pushHistory });
      void flushReadingPositionSave();
      return;
    }
    if (
      !appState.activeEpubBook ||
      !appState.activeEpubRendition ||
      !appState.activeEpubTotalPages
    ) {
      return;
    }

    const boundedPageNumber = clampEpubPageNumber(pageNumber, appState.activeEpubTotalPages);
    const cfi = appState.activeEpubBook.locations.cfiFromLocation(
      epubLocationIndexFromPageNumber(boundedPageNumber, appState.activeEpubTotalPages),
    );
    if (!cfi) {
      return;
    }

    if (pushHistory) {
      captureEpubCfiForHistory(appState.activeEpubRendition);
      syncNavigationHistory("replace");
    }

    appState.activeReadingPosition = {
      filePath: currentBook.filePath,
      pageNumber: boundedPageNumber,
      pageOffsetRatio: 0,
      cfi,
      updatedAt: appState.activeReadingPosition?.updatedAt ?? null,
    };
    cacheReadingPosition(appState.activeReadingPosition);

    if (pushHistory) {
      syncNavigationHistory("push");
    }

    syncViewerPageJumpUi();
    void appState.activeEpubRendition.display(cfi);
    void flushReadingPositionSave();
    return;
  }

  const maxPageNumber =
    appState.activePdfRenderSession?.pdfDocument.numPages ?? Number.POSITIVE_INFINITY;
  const boundedPageNumber = Math.min(Math.max(Math.trunc(pageNumber), 1), maxPageNumber);

  if (pushHistory) {
    const capturedPosition = captureReadingPositionFromViewer();
    if (capturedPosition) {
      appState.activeReadingPosition = capturedPosition;
    }
    syncNavigationHistory("replace");
  }

  appState.activeReadingPosition = {
    filePath: currentBook.filePath,
    pageNumber: boundedPageNumber,
    pageOffsetRatio: 0,
    updatedAt: appState.activeReadingPosition?.updatedAt ?? null,
  };
  cacheReadingPosition(appState.activeReadingPosition);

  if (pushHistory) {
    syncNavigationHistory("push");
  }

  syncViewerPageJumpUi();

  if (appState.lastSnapshot?.pdfRenderer === "pdfjs" && appState.activePdfRenderSession) {
    appState.activePdfRenderSession.restoreTargetPage = boundedPageNumber;
    const groupIndex = findPdfRenderGroupIndexForPage(
      appState.activePdfRenderSession,
      boundedPageNumber,
    );
    schedulePdfRenderWindowUpdate(
      appState.activePdfRenderSession,
      groupIndex >= 0 ? groupIndex : undefined,
    );
    scheduleReadingPositionRestore();
  } else {
    const frame = document.querySelector<HTMLIFrameElement>("#pdf-frame");
    if (frame) {
      const sourceUrl = convertFileSrc(currentBook.filePath);
      frame.src = `${sourceUrl}#page=${boundedPageNumber}`;
      frame.dataset.filePath = currentBook.filePath;
      frame.hidden = false;
    }
  }

  void flushReadingPositionSave();
}

export async function clearCurrentBookSelection() {
  appState.activeReadingPosition = captureReadingPositionFromViewer();
  await flushReadingPositionSave();
  await flushPendingNoteSave();
  await destroyNoteEditor();
  noteState.activeFilePath = null;
  noteState.currentContent = "";
  noteState.savedContent = "";
  noteState.statusMessage = "Notes are saved automatically.";
  viewerState.currentBook = null;
  applyPdfViewerBackground("inherit-theme");
  applyViewerPreferences(DEFAULT_VIEWER_SETTINGS, "global", false, "pdf");
  viewerSettings.globalDraft = { ...DEFAULT_VIEWER_SETTINGS };
  viewerSettings.fileDraft = { ...DEFAULT_VIEWER_SETTINGS };
  syncNoteUi();
  syncViewerSettingsUi();
}

export async function renderCurrentPage() {
  const frame = document.querySelector<HTMLIFrameElement>("#pdf-frame");
  const viewerStageEl = currentViewerStage();
  const pdfjsViewerEl = document.querySelector<HTMLElement>("#pdfjs-viewer");
  const epubViewerEl = document.querySelector<HTMLElement>("#epub-viewer");
  const snapshot = appState.lastSnapshot;

  if (
    !frame ||
    !viewerStageEl ||
    !pdfjsViewerEl ||
    !epubViewerEl ||
    !viewerState.currentBook ||
    !snapshot
  ) {
    return;
  }

  const previousFilePath = pdfjsViewerEl.dataset.filePath;
  if (previousFilePath && previousFilePath === viewerState.currentBook.filePath) {
    appState.activeReadingPosition = captureReadingPositionFromViewer();
  }

  const sourceUrl = convertFileSrc(viewerState.currentBook.filePath);

  if (viewerState.currentBook.sourceType === "epub") {
    await renderEpubBook(frame, pdfjsViewerEl, epubViewerEl, sourceUrl);
    return;
  }

  destroyEpubBook();
  destroyImageEpub();

  if (snapshot.pdfRenderer === "pdfjs") {
    await renderPdfJsBook(frame, viewerStageEl, pdfjsViewerEl, sourceUrl);
    return;
  }

  closePdfSearch();
  releaseActivePdfDocument();
  appState.activePdfOutline = null;
  applyEpubViewerColors("inherit-theme");
  applyPdfViewerBackground("inherit-theme");
  pdfjsViewerEl.hidden = true;
  pdfjsViewerEl.innerHTML = "";
  pdfjsViewerEl.dataset.filePath = "";
  frame.hidden = false;
  frame.dataset.filePath = viewerState.currentBook.filePath;
  frame.src = appState.activeReadingPosition?.pageNumber
    ? `${sourceUrl}#page=${appState.activeReadingPosition.pageNumber}`
    : sourceUrl;
}

export function viewerNeedsRender(snapshot: LibrarySnapshot) {
  const frame = document.querySelector<HTMLIFrameElement>("#pdf-frame");
  const pdfjsViewerEl = document.querySelector<HTMLElement>("#pdfjs-viewer");
  const epubViewerEl = document.querySelector<HTMLElement>("#epub-viewer");
  const currentBook = viewerState.currentBook;

  if (!frame || !pdfjsViewerEl || !epubViewerEl || !currentBook) {
    return false;
  }

  if (currentBook.sourceType === "epub") {
    return (
      epubViewerEl.hidden ||
      epubViewerEl.dataset.filePath !== currentBook.filePath ||
      appState.activeEpubBook === null
    );
  }

  if (snapshot.pdfRenderer === "pdfjs") {
    return (
      pdfjsViewerEl.hidden ||
      pdfjsViewerEl.dataset.filePath !== currentBook.filePath ||
      pdfjsViewerEl.childElementCount === 0
    );
  }

  return frame.hidden || frame.dataset.filePath !== currentBook.filePath;
}

export async function openBook(
  book: BookSummary,
  options: { updateHistory?: "push" | "replace" | "none" } = {},
) {
  const { updateHistory = "none" } = options;

  if (viewerState.currentBook?.filePath !== book.filePath) {
    appState.activeReadingPosition = captureReadingPositionFromViewer();
    await flushReadingPositionSave();
    await flushPendingNoteSave();
    await destroyNoteEditor();
    resetPdfZoomScaleForBook();
  }

  viewerState.currentBook = book;

  if (updateHistory !== "none") {
    syncNavigationHistory(updateHistory);
  }

  await loadReadingPositionForCurrentBook();
  applyPendingViewerJump(book);
  await loadViewerSettingsForCurrentBook();
  renderApp();
  await loadNoteForCurrentBook();
}

// When a full-text hit opens a book, override the just-restored reading position
// so the viewer lands on the matched page (PDF) or section (EPUB) instead.
function applyPendingViewerJump(book: BookSummary) {
  if (!appState.pendingViewerJump || appState.pendingViewerJump.filePath !== book.filePath) {
    return;
  }
  const jump = appState.pendingViewerJump;
  appState.pendingViewerJump = null;
  if (book.sourceType === "epub" && jump.cfi) {
    appState.activeReadingPosition = {
      filePath: book.filePath,
      pageNumber: 1,
      pageOffsetRatio: 0,
      cfi: jump.cfi,
      updatedAt: null,
    };
  } else if (typeof jump.page === "number") {
    appState.activeReadingPosition = {
      filePath: book.filePath,
      pageNumber: jump.page,
      pageOffsetRatio: 0,
      cfi: null,
      updatedAt: null,
    };
  }
  syncViewerPageJumpUi();
}

export function initViewerPageJump() {
  const viewerPageJumpFormEl = document.querySelector<HTMLFormElement>("#viewer-page-jump-form");
  const viewerPageJumpInputEl = document.querySelector<HTMLInputElement>("#viewer-page-jump-input");

  viewerPageJumpInputEl?.addEventListener("input", () => {
    viewerPageJumpState.input = viewerPageJumpInputEl.value;
  });

  viewerPageJumpInputEl?.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      const currentPageNumber = currentViewerPageNumber();
      viewerPageJumpState.input = currentPageNumber === null ? "" : String(currentPageNumber);
      syncViewerPageJumpUi();
      viewerPageJumpInputEl.blur();
    }
  });

  viewerPageJumpInputEl?.addEventListener("focus", () => {
    viewerPageJumpInputEl.select();
  });

  viewerPageJumpInputEl?.addEventListener("blur", () => {
    const currentPageNumber = currentViewerPageNumber();
    viewerPageJumpState.input = currentPageNumber === null ? "" : String(currentPageNumber);
    syncViewerPageJumpUi();
  });

  viewerPageJumpFormEl?.addEventListener("submit", (event) => {
    event.preventDefault();
    const pageNumber = parseRequestedPageNumber(viewerPageJumpState.input);
    if (pageNumber === null) {
      const currentPageNumber = currentViewerPageNumber();
      viewerPageJumpState.input = currentPageNumber === null ? "" : String(currentPageNumber);
      syncViewerPageJumpUi();
      return;
    }

    navigateViewerToPage(pageNumber);
    viewerPageJumpInputEl?.blur();
  });
}

export function initViewerEditorButtons() {
  const viewerTagsOpenEl = document.querySelector<HTMLButtonElement>("#viewer-tags-open");
  const viewerMetadataOpenEl = document.querySelector<HTMLButtonElement>("#viewer-metadata-open");

  viewerTagsOpenEl?.addEventListener("click", () => {
    if (viewerState.currentBook) {
      openTagEditor(viewerState.currentBook);
    }
  });

  viewerMetadataOpenEl?.addEventListener("click", () => {
    if (viewerState.currentBook) {
      void openBookMetadataEditor(viewerState.currentBook);
    }
  });
}

export function initViewerResize() {
  window.addEventListener("resize", () => {
    if (shouldAnchorNoteWindowToBottomRight()) {
      const nextState = preserveNoteWindowBottomRightOffset(noteState, lastViewportSize, {
        width: window.innerWidth,
        height: window.innerHeight,
      });
      noteState.x = nextState.x;
      noteState.y = nextState.y;
    }

    clampNoteWindow();
    syncNoteUi();
    lastViewportSize = {
      width: window.innerWidth,
      height: window.innerHeight,
    };

    if (pdfRenderResizeTimer !== null) {
      window.clearTimeout(pdfRenderResizeTimer);
    }

    if (appState.lastSnapshot?.pdfRenderer === "pdfjs" && viewerState.currentBook) {
      pdfRenderResizeTimer = window.setTimeout(() => {
        void renderCurrentPage();
      }, 120);
    }

    resizeEpubRendition();
    fitImageEpubSpread();
  });

  // When the sidebar opens or closes the CSS grid transition changes the
  // right-pane width.  Call resize() once the transition finishes so
  // epub.js recalculates its column layout for the new dimensions.
  document.querySelector(".two-pane")?.addEventListener("transitionend", (e) => {
    if ((e as TransitionEvent).propertyName === "grid-template-columns") {
      resizeEpubRendition();
      fitImageEpubSpread();
    }
  });
}
