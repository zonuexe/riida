// App-level navigation stack mirrored into window history. Applying an entry
// is navigation-apply.ts's job; this module reaches it through the app shell.

import { invoke } from "@tauri-apps/api/core";
import {
  buildNavigationUrl,
  navigationStateSignature,
  parsePdfPageQueryParam,
} from "../navigation-utils";
import { applyNavigationState, renderApp } from "./shell";
import { appState, viewerState } from "./state";
import type { LibrarySnapshot, NavigationState } from "./types";

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
    pdfPage:
      isPdf || appState.activeImageEpub
        ? (appState.activeReadingPosition?.pageNumber ?? null)
        : null,
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
