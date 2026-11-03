// Library snapshot loading and the top-level render pass over sidebar and main
// pane.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { describeEmptyLibraryState, filterVisibleBooks } from "../library-utils";
import { renderMain, sortBooks } from "./library-view";
import { renderSidebar } from "./sidebar";
import { appState, viewerState } from "./state";
import type { BookSummary, LibrarySnapshot, Shelf } from "./types";
import { clearCurrentBookSelection } from "./viewer";
import { syncBookMetadataEditorUi, syncTagEditorUi } from "../main";

export function updateBookTagsInState(filePath: string, tags: string[]) {
  const apply = (book: BookSummary) =>
    book.filePath === filePath ? { ...book, tags: [...tags] } : book;

  viewerState.books = viewerState.books.map(apply);
  if (appState.lastSnapshot) {
    appState.lastSnapshot = {
      ...appState.lastSnapshot,
      books: appState.lastSnapshot.books.map(apply),
    };
  }
  if (viewerState.currentBook?.filePath === filePath) {
    viewerState.currentBook = { ...viewerState.currentBook, tags: [...tags] };
  }
}

export async function refreshSnapshot() {
  const snapshot = await invoke<LibrarySnapshot>("load_library_snapshot");
  appState.lastSnapshot = snapshot;
  viewerState.books = snapshot.books;
  viewerState.libraryErrorMessage = null;
  renderApp();
}

export async function refreshShelves() {
  try {
    viewerState.shelves = await invoke<Shelf[]>("list_shelves");
  } catch {
    viewerState.shelves = [];
  }
}

function activeShelfQuery(): string {
  if (!viewerState.activeShelf) return "";
  const shelf = viewerState.shelves.find((s) => s.id === viewerState.activeShelf);
  return shelf?.query ?? "";
}

export function visibleBooks(snapshot: LibrarySnapshot) {
  const shelfQuery = activeShelfQuery();
  const userQuery = viewerState.searchQuery.trim();
  const combinedQuery =
    shelfQuery && userQuery ? `(${shelfQuery}) AND (${userQuery})` : shelfQuery || userQuery;
  const filtered = filterVisibleBooks(
    snapshot.books,
    viewerState.activeDirectory,
    viewerState.activeTag,
    viewerState.activeExternalSource,
    viewerState.activeTagDirectOnly,
    combinedQuery,
  );
  return sortBooks(filtered);
}

export function hasActiveLibraryFilter() {
  return Boolean(
    viewerState.searchQuery ||
    viewerState.activeDirectory ||
    viewerState.activeTag ||
    viewerState.activeExternalSource ||
    viewerState.activeShelf,
  );
}

export function describeCurrentEmptyLibraryState(snapshot: LibrarySnapshot, books: BookSummary[]) {
  return describeEmptyLibraryState({
    libraryRoots: snapshot.libraryRoots,
    existingLibraryRoots: snapshot.existingLibraryRoots,
    missingLibraryRoots: snapshot.missingLibraryRoots,
    bookCount: books.length,
    hasFilter: hasActiveLibraryFilter(),
    libraryErrorMessage: viewerState.libraryErrorMessage,
  });
}

export function renderApp() {
  if (!appState.lastSnapshot) {
    return;
  }

  renderSidebar(appState.lastSnapshot);
  renderMain(appState.lastSnapshot);
  syncTagEditorUi();
  syncBookMetadataEditorUi();
}

export async function registerLibraryEvents() {
  await listen<LibrarySnapshot>("library-updated", (event) => {
    appState.lastSnapshot = event.payload;
    viewerState.libraryErrorMessage = null;
    viewerState.books = event.payload.books;
    if (
      viewerState.currentBook &&
      !event.payload.books.some((book) => book.filePath === viewerState.currentBook?.filePath)
    ) {
      void clearCurrentBookSelection().then(() => {
        renderApp();
      });
      return;
    }
    renderApp();
  });

  await listen<string>("library-watch-error", (event) => {
    console.error("library-watch-error", event.payload);
  });
}
