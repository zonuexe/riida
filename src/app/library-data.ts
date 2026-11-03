// The library snapshot and the shelf list: refreshing them from the backend,
// patching them in place, and the filtered, sorted view the main pane shows.

import { invoke } from "@tauri-apps/api/core";
import { describeEmptyLibraryState, filterVisibleBooks } from "../library-utils";
import { renderApp } from "./shell";
import { appState, viewerState } from "./state";
import type { BookSummary, LibrarySnapshot, Shelf } from "./types";
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

export function resetListSort() {
  appState.listSort = "default";
  const el = document.querySelector<HTMLSelectElement>("#library-sort");
  if (el) el.value = "default";
}

function sortBooks(books: BookSummary[]): BookSummary[] {
  switch (appState.listSort) {
    case "title-asc":
      return [...books].sort((a, b) =>
        (a.title ?? a.fileName).localeCompare(b.title ?? b.fileName, "ja"),
      );
    case "title-desc":
      return [...books].sort((a, b) =>
        (b.title ?? b.fileName).localeCompare(a.title ?? a.fileName, "ja"),
      );
    case "last-read":
      return [...books].sort((a, b) => (b.lastReadAt ?? 0) - (a.lastReadAt ?? 0));
    case "file-size":
      return [...books].sort((a, b) => b.fileSize - a.fileSize);
    case "added-desc":
      return [...books].sort((a, b) => b.indexedAt - a.indexedAt);
    case "added-asc":
      return [...books].sort((a, b) => a.indexedAt - b.indexedAt);
    default:
      return books;
  }
}
