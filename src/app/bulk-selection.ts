// Multi-book selection in the library list and the bulk action bar that edits
// the selected books' tags or metadata.

import { renderApp } from "./library";
import { visibleBooks } from "./library-data";
import { openBookMetadataEditorForBooks } from "./metadata-editor";
import { appState, viewerState } from "./state";
import { openTagEditorForBooks } from "./tag-editor";
export const bulkSelectState = {
  selectedFilePaths: new Set<string>(),
};

export function syncBulkActionBar() {
  const barEl = document.querySelector<HTMLElement>("#bulk-action-bar");
  const countEl = document.querySelector<HTMLElement>("#bulk-select-count");
  const shelfEl = document.querySelector<HTMLElement>("#book-results");
  const selectAllEl = document.querySelector<HTMLElement>("#bulk-select-all");
  const n = bulkSelectState.selectedFilePaths.size;
  if (barEl) barEl.hidden = n === 0;
  if (countEl) countEl.textContent = `${n} book${n === 1 ? "" : "s"} selected`;
  shelfEl?.classList.toggle("has-selection", n > 0);
  if (selectAllEl) {
    const visible = appState.lastSnapshot ? visibleBooks(appState.lastSnapshot) : [];
    selectAllEl.hidden = visible.every((b) => bulkSelectState.selectedFilePaths.has(b.filePath));
  }
}

export function initBulkSelection() {
  const bulkSelectAllEl = document.querySelector<HTMLButtonElement>("#bulk-select-all");
  const bulkEditTagsEl = document.querySelector<HTMLButtonElement>("#bulk-edit-tags");
  const bulkEditMetadataEl = document.querySelector<HTMLButtonElement>("#bulk-edit-metadata");
  const bulkDeselectEl = document.querySelector<HTMLButtonElement>("#bulk-deselect");

  bulkSelectAllEl?.addEventListener("click", () => {
    const visible = appState.lastSnapshot ? visibleBooks(appState.lastSnapshot) : [];
    for (const book of visible) {
      bulkSelectState.selectedFilePaths.add(book.filePath);
    }
    syncBulkActionBar();
    renderApp();
  });

  bulkEditTagsEl?.addEventListener("click", () => {
    const selected = viewerState.books.filter((b) =>
      bulkSelectState.selectedFilePaths.has(b.filePath),
    );
    if (selected.length > 0) openTagEditorForBooks(selected);
  });

  bulkEditMetadataEl?.addEventListener("click", () => {
    const selected = viewerState.books.filter((b) =>
      bulkSelectState.selectedFilePaths.has(b.filePath),
    );
    if (selected.length > 0) void openBookMetadataEditorForBooks(selected);
  });

  bulkDeselectEl?.addEventListener("click", () => {
    bulkSelectState.selectedFilePaths.clear();
    syncBulkActionBar();
    renderApp();
  });
}
