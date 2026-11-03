// The page-jump field in the viewer chrome: showing the current page and total,
// and jumping to the page the reader types.

import { parseRequestedPageNumber } from "../page-jump-utils";
import { navigateViewerToPage } from "./shell";
import { appState, viewerState } from "./state";
type ViewerPageJumpState = {
  input: string;
};

const viewerPageJumpState: ViewerPageJumpState = {
  input: "",
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
