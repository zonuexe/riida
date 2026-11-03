// Capture, persist and restore the reading position of the open book.

import { invoke } from "@tauri-apps/api/core";
import {
  clampReadingPositionOffsetRatio,
  computePageOffsetRatio,
  loadCachedReadingPosition as loadCachedReadingPositionFromStorage,
  saveCachedReadingPosition,
  selectAnchorPageIndex,
  selectHeadSidePageInSpread,
} from "../reading-position-utils";
import { activeImageEpub } from "./image-epub-viewer";
import { pdfRenderInProgress } from "./pdf-viewer";
import { appState, viewerState } from "./state";
import type { ReadingPosition } from "./types";
import { currentViewerStage, syncViewerPageJumpUi } from "./viewer";
import { noteSaveTimer } from "../main";

let readingPositionSaveTimer: number | null = null;

export function captureReadingPositionFromViewer(): ReadingPosition | null {
  const currentBook = viewerState.currentBook;
  const stageEl = currentViewerStage();
  const pdfjsViewerEl = document.querySelector<HTMLElement>("#pdfjs-viewer");

  if (
    !currentBook ||
    !stageEl ||
    !pdfjsViewerEl ||
    appState.lastSnapshot?.pdfRenderer !== "pdfjs" ||
    pdfjsViewerEl.dataset.filePath !== currentBook.filePath
  ) {
    return appState.activeReadingPosition;
  }

  const pageEls = Array.from(
    document.querySelectorAll<HTMLElement>(".pdfjs-page[data-page-number]"),
  );

  if (pageEls.length === 0) {
    return appState.activeReadingPosition;
  }

  const anchorLine = stageEl.scrollTop + 24;
  const anchorIndex = selectAnchorPageIndex(
    pageEls.map((el) => el.offsetTop),
    anchorLine,
  );
  const anchorPageEl = pageEls[anchorIndex] ?? pageEls[0]!;

  const candidates = pageEls.map((el) => ({
    pageNumber: Number(el.dataset.pageNumber ?? "0"),
    offsetTop: el.offsetTop,
    offsetHeight: el.offsetHeight,
    el,
  }));
  const anchorCandidate = {
    pageNumber: Number(anchorPageEl.dataset.pageNumber ?? "1"),
    offsetTop: anchorPageEl.offsetTop,
    offsetHeight: anchorPageEl.offsetHeight,
    el: anchorPageEl,
  };
  const representative = selectHeadSidePageInSpread(anchorCandidate, candidates);

  const pageNumber = representative.pageNumber;
  const pageOffsetRatio = computePageOffsetRatio(
    stageEl.scrollTop,
    representative.offsetTop,
    representative.offsetHeight,
  );

  return {
    filePath: currentBook.filePath,
    pageNumber,
    pageOffsetRatio,
    updatedAt: appState.activeReadingPosition?.updatedAt ?? null,
  };
}

export function cacheReadingPosition(position: ReadingPosition | null) {
  if (!position) {
    return;
  }
  saveCachedReadingPosition(position);
}

function loadCachedReadingPosition(filePath: string): ReadingPosition | null {
  return loadCachedReadingPositionFromStorage(filePath);
}

export async function flushReadingPositionSave() {
  if (readingPositionSaveTimer !== null) {
    window.clearTimeout(readingPositionSaveTimer);
    readingPositionSaveTimer = null;
  }

  if (
    !appState.activeReadingPosition ||
    appState.activeReadingPosition.filePath !== viewerState.currentBook?.filePath
  ) {
    return;
  }

  const sourceType = viewerState.currentBook?.sourceType;

  try {
    if (sourceType === "epub" && activeImageEpub) {
      // Image EPUBs have no CFI; persist the page number like a PDF.
      appState.activeReadingPosition = await invoke<ReadingPosition>("save_reading_position", {
        filePath: appState.activeReadingPosition.filePath,
        pageNumber: appState.activeReadingPosition.pageNumber,
        pageOffsetRatio: appState.activeReadingPosition.pageOffsetRatio,
      });
    } else if (sourceType === "epub" && appState.activeReadingPosition.cfi) {
      await invoke("save_epub_position", {
        filePath: appState.activeReadingPosition.filePath,
        cfi: appState.activeReadingPosition.cfi,
      });
    } else if (sourceType !== "epub") {
      appState.activeReadingPosition = await invoke<ReadingPosition>("save_reading_position", {
        filePath: appState.activeReadingPosition.filePath,
        pageNumber: appState.activeReadingPosition.pageNumber,
        pageOffsetRatio: appState.activeReadingPosition.pageOffsetRatio,
      });
    }
  } catch (error) {
    console.error("Failed to save reading position:", error);
  }
}

export function scheduleEpubPositionSave() {
  if (readingPositionSaveTimer !== null) {
    window.clearTimeout(readingPositionSaveTimer);
  }
  readingPositionSaveTimer = window.setTimeout(() => {
    void flushReadingPositionSave();
  }, 1000);
}

export function scheduleReadingPositionSave() {
  if (pdfRenderInProgress) {
    return;
  }
  appState.activeReadingPosition = captureReadingPositionFromViewer();

  if (!appState.activeReadingPosition) {
    return;
  }

  cacheReadingPosition(appState.activeReadingPosition);
  syncViewerPageJumpUi();

  if (readingPositionSaveTimer !== null) {
    window.clearTimeout(readingPositionSaveTimer);
  }

  readingPositionSaveTimer = window.setTimeout(() => {
    void flushReadingPositionSave();
  }, 1000);
}

export async function loadReadingPositionForCurrentBook() {
  const currentBook = viewerState.currentBook;

  if (!currentBook) {
    appState.activeReadingPosition = null;
    syncViewerPageJumpUi();
    return;
  }

  try {
    appState.activeReadingPosition =
      loadCachedReadingPosition(currentBook.filePath) ??
      (await invoke<ReadingPosition | null>("load_reading_position", {
        filePath: currentBook.filePath,
      }));
    cacheReadingPosition(appState.activeReadingPosition);
    syncViewerPageJumpUi();
  } catch (error) {
    appState.activeReadingPosition = loadCachedReadingPosition(currentBook.filePath);
    syncViewerPageJumpUi();
    console.error("Failed to load reading position:", error);
  }
}

export function restoreReadingPositionAttempt() {
  const currentBook = viewerState.currentBook;
  const stageEl = currentViewerStage();

  if (!currentBook || !stageEl || !appState.activeReadingPosition) {
    return false;
  }

  if (appState.activeReadingPosition.filePath !== currentBook.filePath) {
    return false;
  }

  const pageEl = document.querySelector<HTMLElement>(
    `.pdfjs-page[data-page-number="${appState.activeReadingPosition.pageNumber}"]`,
  );

  if (!pageEl) {
    return false;
  }

  const stageRect = stageEl.getBoundingClientRect();
  const pageRect = pageEl.getBoundingClientRect();
  const pageOffsetRatio = clampReadingPositionOffsetRatio(
    appState.activeReadingPosition.pageOffsetRatio,
  );
  const pageTopInStage = stageEl.scrollTop + (pageRect.top - stageRect.top);
  const targetTop = pageTopInStage + pageEl.offsetHeight * pageOffsetRatio;

  stageEl.scrollTo({
    top: Math.max(targetTop, 0),
    behavior: "auto",
  });
  return true;
}

export function scheduleReadingPositionRestore() {
  let attempts = 0;
  const run = () => {
    attempts += 1;
    if (restoreReadingPositionAttempt() || attempts >= 5) {
      return;
    }

    window.requestAnimationFrame(run);
  };

  window.requestAnimationFrame(run);
}

export function initFlushOnUnload() {
  window.addEventListener("beforeunload", () => {
    appState.activeReadingPosition = captureReadingPositionFromViewer();
    void flushReadingPositionSave();
    if (noteSaveTimer !== null) {
      window.clearTimeout(noteSaveTimer);
    }
  });
}
