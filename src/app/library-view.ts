// Main-pane library view: header, sorting, bulk selection, and the empty and
// welcome states.

import { deriveDirectories, deriveTags, shouldShowLibraryWelcome } from "../library-utils";
import {
  getLibraryViewMode,
  hideBookGridPopup,
  renderBookList,
  setLibraryViewMode,
} from "./book-list";
import { destroyEpubBook } from "./epub-viewer";
import { renderFulltextResults } from "./fulltext";
import { destroyImageEpub } from "./image-epub-viewer";
import { hasActiveLibraryFilter, renderApp, visibleBooks } from "./library";
import { loadNoteForCurrentBook, noteState, syncNoteUi } from "./notes";
import { appState, viewerState } from "./state";
import type { BookSummary, LibrarySnapshot } from "./types";
import { syncViewerSettingsUi } from "./viewer-settings";
import { renderCurrentPage, syncViewerPageJumpUi, viewerNeedsRender } from "./viewer";
import { openBookMetadataEditorForBooks, openTagEditorForBooks } from "../main";

type ListSortKey =
  | "default"
  | "title-asc"
  | "title-desc"
  | "last-read"
  | "file-size"
  | "added-desc"
  | "added-asc";
let currentListSort: ListSortKey = "default";

export function resetListSort() {
  currentListSort = "default";
  const el = document.querySelector<HTMLSelectElement>("#library-sort");
  if (el) el.value = "default";
}

export function sortBooks(books: BookSummary[]): BookSummary[] {
  switch (currentListSort) {
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

export function renderMain(snapshot: LibrarySnapshot) {
  const appShellEl = document.querySelector<HTMLElement>(".two-pane");
  const sidebarToggleEl = document.querySelector<HTMLButtonElement>("#sidebar-toggle");
  const sidebarHomeOpenEl = document.querySelector<HTMLButtonElement>("#sidebar-home-open");
  const homeViewEl = document.querySelector<HTMLElement>("#home-view");
  const pdfViewEl = document.querySelector<HTMLElement>("#pdf-view");
  const shelfEl = document.querySelector<HTMLElement>("#book-results");
  const searchInput = document.querySelector<HTMLInputElement>("#library-search");
  const homeCountEl = document.querySelector<HTMLElement>("#indexed-count");
  const tagDirectFilterEl = document.querySelector<HTMLElement>("#tag-direct-filter");
  const tagDirectOnlyEl = document.querySelector<HTMLInputElement>("#tag-direct-only");
  const viewerOverlayControlsEl = document.querySelector<HTMLElement>("#viewer-overlay-controls");

  const books = visibleBooks(snapshot);
  const directoryNodes = deriveDirectories({
    libraryRoots: snapshot.libraryRoots,
    books: snapshot.books,
  });
  const selectedDirectoryNode = viewerState.activeDirectory
    ? (directoryNodes.find((node) => node.path === viewerState.activeDirectory) ?? null)
    : null;
  const tagNodes = deriveTags(snapshot.books);
  const selectedTagNode = viewerState.activeTag
    ? (tagNodes.find((tag) => tag.id === viewerState.activeTag) ?? null)
    : null;
  const displayedBookCount = viewerState.searchQuery
    ? books.length
    : viewerState.activeTag
      ? viewerState.activeTagDirectOnly
        ? books.length
        : (selectedTagNode?.count ?? books.length)
      : viewerState.activeExternalSource
        ? books.length
        : viewerState.activeDirectory
          ? (selectedDirectoryNode?.count ?? books.length)
          : snapshot.indexedCount;

  appShellEl?.classList.toggle("sidebar-collapsed", viewerState.sidebarCollapsed);
  if (sidebarToggleEl) {
    sidebarToggleEl.textContent = viewerState.sidebarCollapsed ? "≫" : "≪";
    sidebarToggleEl.setAttribute(
      "aria-label",
      viewerState.sidebarCollapsed ? "Show sidebar" : "Hide sidebar",
    );
    sidebarToggleEl.setAttribute("aria-expanded", String(!viewerState.sidebarCollapsed));
  }
  sidebarHomeOpenEl?.classList.toggle(
    "is-active",
    viewerState.currentBook === null &&
      viewerState.activeDirectory === null &&
      viewerState.activeTag === null &&
      viewerState.activeExternalSource === null &&
      viewerState.searchQuery === "",
  );
  syncViewerSettingsUi();
  syncViewerPageJumpUi();

  if (searchInput && searchInput.value !== viewerState.searchQuery) {
    searchInput.value = viewerState.searchQuery;
  }

  const searchActionsEl = document.querySelector<HTMLElement>("#sidebar-search-actions");
  if (searchActionsEl) {
    searchActionsEl.hidden = viewerState.searchQuery.trim().length === 0;
  }

  if (tagDirectFilterEl && tagDirectOnlyEl) {
    const shouldShow = Boolean(viewerState.activeTag && selectedTagNode?.hasChildren);
    tagDirectFilterEl.hidden = !shouldShow;
    tagDirectOnlyEl.checked = viewerState.activeTagDirectOnly;
  }

  const libraryAddKindleEl = document.querySelector<HTMLButtonElement>("#library-add-kindle");
  if (libraryAddKindleEl) {
    libraryAddKindleEl.hidden = viewerState.activeExternalSource !== "kindle";
  }
  const libraryAddCustomEl = document.querySelector<HTMLButtonElement>("#library-add-custom");
  if (libraryAddCustomEl) {
    const activeCustomSource =
      viewerState.activeExternalSource && viewerState.activeExternalSource !== "kindle"
        ? ((appState.lastSnapshot?.customSources ?? []).find(
            (s) => s.id === viewerState.activeExternalSource,
          ) ?? null)
        : null;
    libraryAddCustomEl.hidden = !activeCustomSource;
    if (activeCustomSource) {
      libraryAddCustomEl.textContent = `Add book to ${activeCustomSource.name}`;
    }
  }

  if (viewerOverlayControlsEl) {
    viewerOverlayControlsEl.hidden = !viewerState.currentBook;
  }

  // Opening a book or narrowing the library leaves a requested welcome screen.
  if (viewerState.currentBook || hasActiveLibraryFilter()) {
    viewerState.isLibraryWelcomeRequested = false;
  }
  const isFirstRun = shouldShowLibraryWelcome({
    libraryRoots: snapshot.libraryRoots,
    totalBookCount: snapshot.books.length,
    hasFilter: hasActiveLibraryFilter(),
    libraryErrorMessage: viewerState.libraryErrorMessage,
  });
  const showWelcome = isFirstRun || viewerState.isLibraryWelcomeRequested;
  const welcomeEl = document.querySelector<HTMLElement>("#library-welcome");
  const welcomeCloseEl = document.querySelector<HTMLElement>("#library-welcome-close");
  const libraryHomeEl = document.querySelector<HTMLElement>("#library-home");
  if (welcomeEl) {
    welcomeEl.hidden = !showWelcome;
  }
  if (welcomeCloseEl) {
    welcomeCloseEl.hidden = isFirstRun;
  }
  if (libraryHomeEl) {
    libraryHomeEl.hidden = showWelcome;
  }

  if (homeCountEl) {
    homeCountEl.textContent = String(displayedBookCount);
  }

  if (viewerState.currentBook) {
    homeViewEl?.setAttribute("hidden", "true");
    pdfViewEl?.removeAttribute("hidden");
    if (viewerNeedsRender(snapshot)) {
      void renderCurrentPage();
    }
    syncNoteUi();
    if (noteState.isOpen) {
      void loadNoteForCurrentBook();
    }
  } else {
    pdfViewEl?.setAttribute("hidden", "true");
    homeViewEl?.removeAttribute("hidden");
    const frame = document.querySelector<HTMLIFrameElement>("#pdf-frame");
    const pdfjsViewerEl = document.querySelector<HTMLElement>("#pdfjs-viewer");
    if (frame) {
      frame.src = "about:blank";
      frame.hidden = false;
      frame.dataset.filePath = "";
    }
    if (pdfjsViewerEl) {
      pdfjsViewerEl.innerHTML = "";
      pdfjsViewerEl.hidden = true;
    }
    destroyEpubBook();
    destroyImageEpub();
    syncNoteUi();
    if (shelfEl) {
      renderBookList(books, shelfEl);
    }
    void renderFulltextResults(viewerState.searchQuery);
    syncBulkActionBar();
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

export function initLibraryViewControls() {
  const librarySortEl = document.querySelector<HTMLSelectElement>("#library-sort");
  const libraryViewToggleEl = document.querySelector<HTMLButtonElement>("#library-view-toggle");
  if (librarySortEl) {
    librarySortEl.addEventListener("change", () => {
      currentListSort = (librarySortEl.value as ListSortKey) ?? "default";
      if (appState.lastSnapshot) {
        renderApp();
      }
    });
  }
  if (libraryViewToggleEl) {
    const updateToggleState = () => {
      const mode = getLibraryViewMode();
      libraryViewToggleEl.classList.toggle("is-active", mode === "grid");
      libraryViewToggleEl.setAttribute(
        "aria-label",
        mode === "grid" ? "リスト表示に切り替え" : "グリッド表示に切り替え",
      );
      libraryViewToggleEl.innerHTML =
        mode === "grid"
          ? `<i class="fa-solid fa-list" aria-hidden="true"></i>`
          : `<i class="fa-solid fa-table-cells-large" aria-hidden="true"></i>`;
    };
    updateToggleState();
    libraryViewToggleEl.addEventListener("click", () => {
      const next = getLibraryViewMode() === "grid" ? "list" : "grid";
      setLibraryViewMode(next);
      updateToggleState();
      hideBookGridPopup(true);
      if (appState.lastSnapshot) {
        renderApp();
      }
    });
  }
}
