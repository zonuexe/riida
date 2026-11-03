// Applying a navigation state: the library filter it names and the book (and
// page) it opens. It sits at the top of the module layers; the history stack in
// navigation.ts reaches it through the app shell.

import { bulkSelectState, syncBulkActionBar } from "./bulk-selection";
import { goToImagePage } from "./image-epub-viewer";
import { renderApp } from "./library";
import { resetListSort } from "./library-data";
import { ensureExpandedPath, ensureExpandedTag } from "./sidebar";
import { appState, viewerState } from "./state";
import type { NavigationState } from "./types";
import { clearCurrentBookSelection, navigateViewerToPage, openBook } from "./viewer";
export async function applyNavigationState(state: NavigationState) {
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
      appState.activeEpubRendition
    ) {
      await appState.activeEpubRendition.display(state.epubCfi);
      return;
    }

    // Fast path: same PDF book already rendered — jump directly to the page
    // without rebuilding the render session.
    if (
      state.pdfPage &&
      nextBook.filePath === viewerState.currentBook?.filePath &&
      nextBook.sourceType === "pdf" &&
      appState.activePdfRenderSession
    ) {
      navigateViewerToPage(state.pdfPage, { pushHistory: false });
      return;
    }

    // Fast path: same image EPUB already rendered — jump directly to the page.
    if (
      state.pdfPage &&
      nextBook.filePath === viewerState.currentBook?.filePath &&
      nextBook.sourceType === "epub" &&
      appState.activeImageEpub
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
