// App-level navigation stack mirrored into window history.

import { invoke } from "@tauri-apps/api/core";
import {
  buildNavigationUrl,
  navigationStateSignature,
  parsePdfPageQueryParam,
} from "../navigation-utils";
import { activeEpubRendition } from "./epub-viewer";
import { activeImageEpub, goToImagePage } from "./image-epub-viewer";
import { bulkSelectState, resetListSort, syncBulkActionBar } from "./library-view";
import { renderApp } from "./library";
import { activePdfRenderSession } from "./pdf-viewer";
import { ensureExpandedPath, ensureExpandedTag } from "./sidebar";
import { appState, viewerState } from "./state";
import type { LibrarySnapshot, NavigationState } from "./types";
import { clearCurrentBookSelection, navigateViewerToPage, openBook } from "./viewer";

let suppressHistoryUpdates = false;
let navigationHistoryIndex = 0;
let navigationHistoryMax = 0;
let navigationEntries: NavigationState[] = [];

function currentNavigationState(): NavigationState {
  const currentBook = viewerState.currentBook;
  const isPdf = currentBook?.sourceType === "pdf";
  return {
    historyIndex: navigationHistoryIndex,
    bookFilePath: currentBook?.filePath ?? null,
    epubCfi: appState.activeReadingPosition?.cfi ?? null,
    // pdfPage carries the page number for any paged viewer (PDF or image EPUB).
    pdfPage: isPdf || activeImageEpub ? (appState.activeReadingPosition?.pageNumber ?? null) : null,
    activeDirectory: viewerState.activeDirectory,
    activeTag: viewerState.activeTag,
    activeExternalSource: viewerState.activeExternalSource,
    activeShelf: viewerState.activeShelf,
    activeTagDirectOnly: viewerState.activeTagDirectOnly,
    searchQuery: viewerState.searchQuery,
  };
}

export function syncNavigationHistory(mode: "push" | "replace") {
  if (suppressHistoryUpdates) {
    return;
  }

  syncNavigationHistoryState(currentNavigationState(), mode);
}

function syncNavigationHistoryState(state: NavigationState, mode: "push" | "replace") {
  if (suppressHistoryUpdates) {
    return;
  }

  const normalizedState = {
    ...state,
    historyIndex: navigationHistoryIndex,
  };

  if (mode === "push") {
    const currentState = navigationEntries[navigationHistoryIndex];
    if (
      currentState &&
      navigationStateSignature(currentState) === navigationStateSignature(normalizedState)
    ) {
      syncNavigationControlsUi();
      return;
    }

    navigationEntries = navigationEntries.slice(0, navigationHistoryIndex + 1);
    navigationEntries.push({
      ...normalizedState,
      historyIndex: navigationHistoryIndex + 1,
    });
    navigationHistoryIndex = navigationEntries.length - 1;
  } else if (navigationEntries.length === 0) {
    navigationEntries = [{ ...normalizedState, historyIndex: 0 }];
    navigationHistoryIndex = 0;
  } else {
    navigationEntries[navigationHistoryIndex] = {
      ...normalizedState,
      historyIndex: navigationHistoryIndex,
    };
  }

  navigationHistoryMax = Math.max(0, navigationEntries.length - 1);
  const historyState = navigationEntries[navigationHistoryIndex];
  if (!historyState) return;
  const url = buildNavigationUrl(historyState);

  if (mode === "push") {
    window.history.pushState(historyState, "", url);
  } else {
    window.history.replaceState(historyState, "", url);
  }

  syncNavigationControlsUi();
}

export async function navigateToState(
  state: Omit<NavigationState, "historyIndex">,
  mode: "push" | "replace",
) {
  const nextState: NavigationState = {
    historyIndex: navigationHistoryIndex,
    ...state,
  };

  syncNavigationHistoryState(nextState, mode);
  await applyNavigationState({
    ...nextState,
    historyIndex: navigationHistoryIndex,
  });
}

async function applyNavigationState(state: NavigationState) {
  const snapshot = appState.lastSnapshot;

  if (!snapshot) {
    return;
  }

  const prevDirectory = viewerState.activeDirectory;
  const prevTag = viewerState.activeTag;
  const prevExternalSource = viewerState.activeExternalSource;
  const prevShelf = viewerState.activeShelf;

  viewerState.searchQuery = state.searchQuery;
  viewerState.activeDirectory = state.activeDirectory;
  viewerState.activeTag = state.activeTag;
  viewerState.activeExternalSource = state.activeExternalSource;
  viewerState.activeShelf = state.activeShelf;
  viewerState.activeTagDirectOnly = state.activeTagDirectOnly;

  if (
    prevDirectory !== viewerState.activeDirectory ||
    prevTag !== viewerState.activeTag ||
    prevExternalSource !== viewerState.activeExternalSource ||
    prevShelf !== viewerState.activeShelf
  ) {
    resetListSort();
    bulkSelectState.selectedFilePaths.clear();
    syncBulkActionBar();
  }

  const nextBook = state.bookFilePath
    ? (snapshot.books.find((book) => book.filePath === state.bookFilePath) ?? null)
    : null;

  ensureExpandedPath(state.activeDirectory);
  ensureExpandedTag(state.activeTag);

  // A non-openable (external) book has nothing to render; never hand its
  // synthetic `kindle:` path to the PDF or EPUB viewer.
  if (nextBook?.isOpenable) {
    // Fast path: same EPUB book already rendered — jump directly via CFI
    // to avoid destroying and re-creating the rendition.
    if (
      state.epubCfi &&
      nextBook.filePath === viewerState.currentBook?.filePath &&
      nextBook.sourceType === "epub" &&
      activeEpubRendition
    ) {
      await activeEpubRendition.display(state.epubCfi);
      return;
    }

    // Fast path: same PDF book already rendered — jump directly to the page
    // without rebuilding the render session.
    if (
      state.pdfPage &&
      nextBook.filePath === viewerState.currentBook?.filePath &&
      nextBook.sourceType === "pdf" &&
      activePdfRenderSession
    ) {
      navigateViewerToPage(state.pdfPage, { pushHistory: false });
      return;
    }

    // Fast path: same image EPUB already rendered — jump directly to the page.
    if (
      state.pdfPage &&
      nextBook.filePath === viewerState.currentBook?.filePath &&
      nextBook.sourceType === "epub" &&
      activeImageEpub
    ) {
      goToImagePage(state.pdfPage, { pushHistory: false });
      return;
    }

    await openBook(nextBook, { updateHistory: "none" });
    return;
  }

  await clearCurrentBookSelection();
  renderApp();
}

function syncNavigationControlsUi() {
  const backButtonEl = document.querySelector<HTMLButtonElement>("#nav-back");
  const forwardButtonEl = document.querySelector<HTMLButtonElement>("#nav-forward");

  if (backButtonEl) {
    backButtonEl.disabled = navigationHistoryIndex <= 0;
  }

  if (forwardButtonEl) {
    forwardButtonEl.disabled = navigationHistoryIndex >= navigationHistoryMax;
  }
}

export function navigateBack() {
  if (navigationHistoryIndex <= 0) {
    return;
  }

  navigationHistoryIndex -= 1;
  const nextState = navigationEntries[navigationHistoryIndex];
  if (!nextState) return;
  window.history.replaceState(nextState, "", buildNavigationUrl(nextState));
  syncNavigationControlsUi();
  suppressHistoryUpdates = true;
  void applyNavigationState(nextState).finally(() => {
    suppressHistoryUpdates = false;
  });
}

export function navigateForward() {
  if (navigationHistoryIndex >= navigationHistoryMax) {
    return;
  }

  navigationHistoryIndex += 1;
  const nextState = navigationEntries[navigationHistoryIndex];
  if (!nextState) return;
  window.history.replaceState(nextState, "", buildNavigationUrl(nextState));
  syncNavigationControlsUi();
  suppressHistoryUpdates = true;
  void applyNavigationState(nextState).finally(() => {
    suppressHistoryUpdates = false;
  });
}

export function initNavigationControls() {
  const navBackEl = document.querySelector<HTMLButtonElement>("#nav-back");
  const navForwardEl = document.querySelector<HTMLButtonElement>("#nav-forward");

  navBackEl?.addEventListener("click", () => {
    navigateBack();
  });

  navForwardEl?.addEventListener("click", () => {
    navigateForward();
  });
}

export function initHistoryPopstate() {
  window.addEventListener("popstate", (event) => {
    const state = event.state as NavigationState | null;
    const fallbackParams = new URLSearchParams(window.location.search);
    const nextState: NavigationState = state ?? {
      historyIndex: 0,
      bookFilePath: fallbackParams.get("book"),
      pdfPage: parsePdfPageQueryParam(fallbackParams.get("page")),
      activeDirectory: fallbackParams.get("dir"),
      activeTag: fallbackParams.get("tag"),
      activeExternalSource: fallbackParams.get("source"),
      activeShelf: fallbackParams.get("shelf"),
      activeTagDirectOnly: fallbackParams.get("tagMode") === "direct",
      searchQuery: fallbackParams.get("q") ?? "",
    };

    if (navigationEntries.length === 0) {
      navigationEntries = [{ ...nextState, historyIndex: 0 }];
    }

    navigationHistoryIndex = Math.max(
      0,
      Math.min(nextState.historyIndex ?? 0, navigationEntries.length - 1),
    );
    navigationHistoryMax = Math.max(0, navigationEntries.length - 1);
    syncNavigationControlsUi();

    suppressHistoryUpdates = true;
    void applyNavigationState(nextState).finally(() => {
      suppressHistoryUpdates = false;
    });
  });
}

export function loadInitialLibraryState() {
  invoke<LibrarySnapshot>("library_snapshot")
    .then((snapshot) => {
      appState.lastSnapshot = snapshot;
      viewerState.libraryErrorMessage = null;
      viewerState.books = snapshot.books;
      const params = new URLSearchParams(window.location.search);
      const initialState: NavigationState = {
        historyIndex: 0,
        bookFilePath: params.get("book"),
        pdfPage: parsePdfPageQueryParam(params.get("page")),
        activeDirectory: params.get("dir"),
        activeTag: params.get("tag"),
        activeExternalSource: params.get("source"),
        activeShelf: params.get("shelf"),
        activeTagDirectOnly: params.get("tagMode") === "direct",
        searchQuery: params.get("q") ?? "",
      };

      navigationEntries = [{ ...initialState, historyIndex: 0 }];
      navigationHistoryIndex = 0;
      navigationHistoryMax = 0;
      syncNavigationControlsUi();
      suppressHistoryUpdates = true;
      void applyNavigationState(initialState).finally(() => {
        suppressHistoryUpdates = false;
        syncNavigationHistory("replace");
      });
    })
    .catch((error) => {
      viewerState.libraryErrorMessage = "Failed to load the library.";
      renderApp();
      console.error("failed to load library snapshot", error);
    });
}
