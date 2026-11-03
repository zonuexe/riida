// The top-level render pass over sidebar and main pane, and the backend's
// library-change events that trigger it.

import { listen } from "@tauri-apps/api/event";
import { renderMain } from "./library-view";
import { syncBookMetadataEditorUi } from "./metadata-editor";
import { renderSidebar } from "./sidebar";
import { appState, viewerState } from "./state";
import { syncTagEditorUi } from "./tag-editor";
import type { LibrarySnapshot } from "./types";
import { clearCurrentBookSelection } from "./viewer";

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
