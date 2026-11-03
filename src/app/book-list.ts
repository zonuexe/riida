// Book rows and grid tiles of the library view, their thumbnails, and the
// grid hover popup.

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  formatAuthorByline,
  formatBookLocation,
  formatBookMetaLine,
  formatFileSize,
  formatReleaseYear,
} from "../library-utils";
import { bulkSelectState, syncBulkActionBar } from "./bulk-selection";
import { cachedHomeDir } from "./home-path";
import { describeCurrentEmptyLibraryState } from "./library-data";
import { openBookMetadataEditor } from "./metadata-editor";
import { navigateToState } from "./navigation";
import { appState, viewerState } from "./state";
import { openTagEditor } from "./tag-editor";
import type { BookSummary } from "./types";

const thumbnailUrls = new Map<string, string>();
let thumbnailObserver: IntersectionObserver | null = null;
const thumbnailBookByImage = new WeakMap<HTMLImageElement, BookSummary>();

function applyThumbnail(filePath: string, thumbnailPath: string) {
  const thumbnailUrl = convertFileSrc(thumbnailPath);
  thumbnailUrls.set(filePath, thumbnailUrl);

  const imageEls = document.querySelectorAll<HTMLImageElement>(
    `.book-thumb[data-file-path="${CSS.escape(filePath)}"]`,
  );

  for (const imageEl of imageEls) {
    imageEl.src = thumbnailUrl;
    imageEl.dataset.loaded = "true";
  }
}

async function loadThumbnail(book: BookSummary, imageEl: HTMLImageElement) {
  if (book.coverUrl) {
    imageEl.src = book.coverUrl;
    imageEl.dataset.loaded = "true";
    return;
  }

  if (book.sourceType !== "pdf") {
    imageEl.dataset.loaded = "true";
    return;
  }

  if (thumbnailUrls.has(book.filePath)) {
    imageEl.src = thumbnailUrls.get(book.filePath) ?? "";
    imageEl.dataset.loaded = "true";
    return;
  }

  const thumbnailPath = await invoke<string | null>("book_thumbnail", {
    filePath: book.filePath,
  });

  if (!thumbnailPath) {
    return;
  }

  applyThumbnail(book.filePath, thumbnailPath);
}

function ensureThumbnailObserver() {
  if (thumbnailObserver) {
    return thumbnailObserver;
  }

  thumbnailObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) {
          continue;
        }

        const imageEl = entry.target as HTMLImageElement;
        const book = thumbnailBookByImage.get(imageEl);

        if (book && imageEl.dataset.loaded !== "true") {
          void loadThumbnail(book, imageEl);
        }

        thumbnailObserver?.unobserve(imageEl);
      }
    },
    {
      rootMargin: "120px 0px",
    },
  );

  return thumbnailObserver;
}

type LibraryViewMode = "list" | "grid";

export function getLibraryViewMode(): LibraryViewMode {
  return localStorage.getItem("riida.libraryViewMode") === "grid" ? "grid" : "list";
}

export function setLibraryViewMode(mode: LibraryViewMode) {
  localStorage.setItem("riida.libraryViewMode", mode);
}

let bookGridPopupEl: HTMLElement | null = null;
let bookGridPopupHideTimer: ReturnType<typeof setTimeout> | null = null;

function ensureBookGridPopup(): HTMLElement {
  if (!bookGridPopupEl) {
    const el = document.createElement("div");
    el.className = "book-grid-popup";
    document.body.appendChild(el);
    bookGridPopupEl = el;
  }
  return bookGridPopupEl;
}

function showBookGridPopup(
  anchorEl: HTMLElement,
  book: BookSummary,
  onTagClick: (tag: string) => void,
  onEditTags: () => void,
  onEditMetadata: () => void,
  onClickBook: () => void,
  onOpenUrl: ((url: string) => void) | null,
) {
  if (bookGridPopupHideTimer !== null) {
    clearTimeout(bookGridPopupHideTimer);
    bookGridPopupHideTimer = null;
  }

  const popup = ensureBookGridPopup();

  const copyEl = document.createElement("div");
  copyEl.className = "book-copy";

  const titleEl = document.createElement("strong");
  titleEl.textContent = book.title ?? book.fileName;
  titleEl.style.cursor = "pointer";
  titleEl.addEventListener("click", onClickBook);

  const byline = formatAuthorByline(book.authors);
  let bylineEl: HTMLElement | null = null;
  if (byline) {
    bylineEl = document.createElement("span");
    bylineEl.className = "book-byline";
    bylineEl.textContent = byline;
  }

  const metaEl = document.createElement("small");
  metaEl.className = "book-meta";
  metaEl.textContent = formatBookMetaLine([
    book.publisher,
    formatReleaseYear(book.releaseDate),
    book.sourceType === "pdf" ? formatFileSize(book.fileSize) : null,
  ]);

  const tagsRowEl = document.createElement("div");
  tagsRowEl.className = "book-tags-row";

  const tagsEl = document.createElement("div");
  tagsEl.className = "book-tag-list";
  const actionsEl = document.createElement("div");
  actionsEl.className = "book-action-list";

  if (book.tags.length === 0) {
    tagsEl.hidden = true;
  } else {
    for (const tag of book.tags) {
      const tagEl = document.createElement("button");
      tagEl.type = "button";
      tagEl.className = "book-tag";
      tagEl.innerHTML = `<i class="fa-solid fa-tag" aria-hidden="true"></i><span>${tag}</span>`;
      tagEl.addEventListener("click", (e) => {
        e.stopPropagation();
        hideBookGridPopup(true);
        onTagClick(tag);
      });
      tagsEl.appendChild(tagEl);
    }
  }

  const editTagsEl = document.createElement("button");
  editTagsEl.type = "button";
  editTagsEl.className = "book-tags-edit";
  editTagsEl.textContent = book.tags.length > 0 ? "Edit tags" : "Add tags";
  editTagsEl.addEventListener("click", (e) => {
    e.stopPropagation();
    hideBookGridPopup(true);
    onEditTags();
  });

  const editMetadataEl = document.createElement("button");
  editMetadataEl.type = "button";
  editMetadataEl.className = "book-tags-edit";
  editMetadataEl.textContent = "Edit metadata";
  editMetadataEl.addEventListener("click", (e) => {
    e.stopPropagation();
    hideBookGridPopup(true);
    onEditMetadata();
  });

  tagsRowEl.appendChild(tagsEl);
  actionsEl.appendChild(editMetadataEl);
  actionsEl.appendChild(editTagsEl);
  tagsRowEl.appendChild(actionsEl);

  copyEl.appendChild(titleEl);
  if (bylineEl) {
    copyEl.appendChild(bylineEl);
  }
  if (metaEl.textContent) {
    copyEl.appendChild(metaEl);
  }
  copyEl.appendChild(tagsRowEl);

  if (book.asin || book.url) {
    const linksEl = document.createElement("div");
    linksEl.className = "book-links";
    if (book.asin) {
      const amazonEl = document.createElement("button");
      amazonEl.type = "button";
      amazonEl.className = "book-link";
      amazonEl.innerHTML = `<i class="fa-brands fa-amazon" aria-hidden="true"></i><span>Amazon</span>`;
      amazonEl.addEventListener("click", (e) => {
        e.stopPropagation();
        void openUrl(`https://www.amazon.co.jp/dp/${book.asin}`);
      });
      linksEl.appendChild(amazonEl);
    }
    if (book.url && onOpenUrl) {
      let label: string;
      try {
        label = new URL(book.url).hostname;
      } catch {
        label = book.url;
      }
      const urlEl = document.createElement("button");
      urlEl.type = "button";
      urlEl.className = "book-link";
      urlEl.innerHTML = `<i class="fa-solid fa-globe" aria-hidden="true"></i><span>${label}</span>`;
      urlEl.addEventListener("click", (e) => {
        e.stopPropagation();
        onOpenUrl(book.url!);
      });
      linksEl.appendChild(urlEl);
    }
    copyEl.appendChild(linksEl);
  }

  popup.innerHTML = "";
  popup.appendChild(copyEl);

  const rect = anchorEl.getBoundingClientRect();
  const popupWidth = 420;
  const margin = 8;
  let left = rect.right + margin;
  if (left + popupWidth > window.innerWidth - margin) {
    left = rect.left - popupWidth - margin;
  }
  if (left < margin) {
    left = margin;
  }
  let top = rect.top;
  popup.style.left = `${left}px`;
  popup.style.top = `${top}px`;
  popup.style.width = `${popupWidth}px`;

  popup.classList.add("is-visible");

  popup.onmouseenter = () => {
    if (bookGridPopupHideTimer !== null) {
      clearTimeout(bookGridPopupHideTimer);
      bookGridPopupHideTimer = null;
    }
  };
  popup.onmouseleave = () => {
    hideBookGridPopup(false);
  };
}

export function hideBookGridPopup(immediate: boolean) {
  if (bookGridPopupHideTimer !== null) {
    clearTimeout(bookGridPopupHideTimer);
    bookGridPopupHideTimer = null;
  }
  if (immediate) {
    bookGridPopupEl?.classList.remove("is-visible");
    return;
  }
  bookGridPopupHideTimer = setTimeout(() => {
    bookGridPopupEl?.classList.remove("is-visible");
    bookGridPopupHideTimer = null;
  }, 160);
}

export function renderBookList(books: BookSummary[], container: HTMLElement) {
  container.innerHTML = "";

  if (books.length === 0) {
    const snapshot = appState.lastSnapshot;
    const emptyEl = document.createElement("div");
    emptyEl.className = "empty-state";
    const state = snapshot
      ? describeCurrentEmptyLibraryState(snapshot, books)
      : { message: "Loading library...", detail: null as string | null };
    const messageEl = document.createElement("p");
    messageEl.textContent = state.message;
    emptyEl.appendChild(messageEl);

    if (state.detail) {
      const detailEl = document.createElement("p");
      detailEl.className = "empty-state-detail";
      detailEl.textContent = state.detail;
      emptyEl.appendChild(detailEl);
    }

    container.appendChild(emptyEl);
    return;
  }

  const viewMode = getLibraryViewMode();
  const listEl = document.createElement("ul");
  listEl.className = viewMode === "grid" ? "books grid-view" : "books";

  for (const book of books) {
    const itemEl = document.createElement("li");
    itemEl.className = "book-item";
    itemEl.tabIndex = 0;
    itemEl.dataset.filePath = book.filePath;
    itemEl.classList.toggle("is-selected", viewerState.currentBook?.filePath === book.filePath);
    itemEl.classList.toggle(
      "is-bulk-selected",
      bulkSelectState.selectedFilePaths.has(book.filePath),
    );

    const checkboxEl = document.createElement("input");
    checkboxEl.type = "checkbox";
    checkboxEl.className = "book-select-checkbox";
    checkboxEl.checked = bulkSelectState.selectedFilePaths.has(book.filePath);
    checkboxEl.setAttribute("aria-label", `Select ${book.title ?? book.fileName}`);
    checkboxEl.addEventListener("click", (event) => {
      event.stopPropagation();
    });
    checkboxEl.addEventListener("change", () => {
      if (checkboxEl.checked) {
        bulkSelectState.selectedFilePaths.add(book.filePath);
        itemEl.classList.add("is-bulk-selected");
      } else {
        bulkSelectState.selectedFilePaths.delete(book.filePath);
        itemEl.classList.remove("is-bulk-selected");
      }
      syncBulkActionBar();
    });

    const thumbEl = document.createElement("img");
    thumbEl.className = "book-thumb";
    thumbEl.alt = `${book.fileName} cover thumbnail`;
    thumbEl.dataset.filePath = book.filePath;
    thumbEl.dataset.loaded = "false";
    thumbEl.width = 72;
    thumbEl.height = 102;
    thumbEl.decoding = "async";
    thumbEl.loading = "lazy";

    const bodyEl = document.createElement("div");
    bodyEl.className = "book-copy";

    const titleEl = document.createElement("strong");
    titleEl.textContent = book.title ?? book.fileName;

    const byline = formatAuthorByline(book.authors);
    let bylineEl: HTMLElement | null = null;
    if (byline) {
      bylineEl = document.createElement("span");
      bylineEl.className = "book-byline";
      bylineEl.textContent = byline;
    }

    const locationLabel = book.locationLabel ?? formatBookLocation(book.filePath, cachedHomeDir);
    const metaEl = document.createElement("small");
    metaEl.className = "book-meta";
    metaEl.textContent = formatBookMetaLine([
      book.publisher,
      formatReleaseYear(book.releaseDate),
      locationLabel,
      book.sourceType === "pdf" ? formatFileSize(book.fileSize) : null,
    ]);

    const tagsRowEl = document.createElement("div");
    tagsRowEl.className = "book-tags-row";

    const tagsEl = document.createElement("div");
    tagsEl.className = "book-tag-list";
    const actionsEl = document.createElement("div");
    actionsEl.className = "book-action-list";
    if (book.tags.length === 0) {
      tagsEl.hidden = true;
    } else {
      for (const tag of book.tags) {
        const tagEl = document.createElement("button");
        tagEl.type = "button";
        tagEl.className = "book-tag";
        tagEl.innerHTML = `<i class="fa-solid fa-tag" aria-hidden="true"></i><span>${tag}</span>`;
        tagEl.addEventListener("click", (event) => {
          event.stopPropagation();
          void navigateToState(
            {
              bookFilePath: null,
              activeDirectory: null,
              activeTag: tag,
              activeExternalSource: null,
              activeShelf: null,
              activeTagDirectOnly: false,
              searchQuery: viewerState.searchQuery,
            },
            "push",
          );
        });
        tagsEl.appendChild(tagEl);
      }
    }

    const editTagsEl = document.createElement("button");
    editTagsEl.type = "button";
    editTagsEl.className = "book-tags-edit";
    editTagsEl.textContent = book.tags.length > 0 ? "Edit tags" : "Add tags";
    editTagsEl.addEventListener("click", (event) => {
      event.stopPropagation();
      openTagEditor(book);
    });

    const editMetadataEl = document.createElement("button");
    editMetadataEl.type = "button";
    editMetadataEl.className = "book-tags-edit";
    editMetadataEl.textContent = "Edit metadata";
    editMetadataEl.addEventListener("click", (event) => {
      event.stopPropagation();
      void openBookMetadataEditor(book);
    });

    bodyEl.appendChild(titleEl);
    if (bylineEl) {
      bodyEl.appendChild(bylineEl);
    }
    bodyEl.appendChild(metaEl);
    tagsRowEl.appendChild(tagsEl);
    actionsEl.appendChild(editMetadataEl);
    actionsEl.appendChild(editTagsEl);
    tagsRowEl.appendChild(actionsEl);
    bodyEl.appendChild(tagsRowEl);

    if (book.asin || book.url) {
      const linksEl = document.createElement("div");
      linksEl.className = "book-links";
      if (book.asin) {
        const amazonEl = document.createElement("button");
        amazonEl.type = "button";
        amazonEl.className = "book-link";
        amazonEl.innerHTML = `<i class="fa-brands fa-amazon" aria-hidden="true"></i><span>Amazon</span>`;
        amazonEl.addEventListener("click", (e) => {
          e.stopPropagation();
          void openUrl(`https://www.amazon.co.jp/dp/${book.asin}`);
        });
        linksEl.appendChild(amazonEl);
      }
      if (book.url) {
        let label: string;
        try {
          label = new URL(book.url).hostname;
        } catch {
          label = book.url;
        }
        const urlEl = document.createElement("button");
        urlEl.type = "button";
        urlEl.className = "book-link";
        urlEl.innerHTML = `<i class="fa-solid fa-globe" aria-hidden="true"></i><span>${label}</span>`;
        urlEl.addEventListener("click", (e) => {
          e.stopPropagation();
          void openUrl(book.url!);
        });
        linksEl.appendChild(urlEl);
      }
      bodyEl.appendChild(linksEl);
    }
    itemEl.appendChild(checkboxEl);
    itemEl.appendChild(thumbEl);
    itemEl.appendChild(bodyEl);

    if (book.sourceType === "pdf" || book.sourceType === "epub") {
      const revealEl = document.createElement("button");
      revealEl.type = "button";
      revealEl.className = "book-reveal-btn";
      revealEl.title = navigator.platform.startsWith("Win") ? "Show in Explorer" : "Show in Finder";
      revealEl.innerHTML = `<i class="fa-solid fa-folder" aria-hidden="true"></i>`;
      revealEl.addEventListener("mouseenter", () => {
        revealEl.innerHTML = `<i class="fa-solid fa-folder-open" aria-hidden="true"></i>`;
      });
      revealEl.addEventListener("mouseleave", () => {
        revealEl.innerHTML = `<i class="fa-solid fa-folder" aria-hidden="true"></i>`;
      });
      revealEl.addEventListener("click", (event) => {
        event.stopPropagation();
        void revealItemInDir(book.filePath);
      });
      itemEl.appendChild(revealEl);
    }

    if (viewMode === "grid") {
      const gridTitleEl = document.createElement("span");
      gridTitleEl.className = "book-item-grid-title";
      gridTitleEl.textContent = book.title ?? book.fileName;
      itemEl.appendChild(gridTitleEl);

      const openBook = () => {
        if (!book.isOpenable) {
          void openBookMetadataEditor(book);
          return;
        }
        void navigateToState(
          {
            bookFilePath: book.filePath,
            activeDirectory: viewerState.activeDirectory,
            activeTag: viewerState.activeTag,
            activeExternalSource: viewerState.activeExternalSource,
            activeShelf: viewerState.activeShelf,
            activeTagDirectOnly: viewerState.activeTagDirectOnly,
            searchQuery: viewerState.searchQuery,
          },
          "push",
        );
      };

      itemEl.addEventListener("mouseenter", () => {
        showBookGridPopup(
          itemEl,
          book,
          (tag) => {
            void navigateToState(
              {
                bookFilePath: null,
                activeDirectory: null,
                activeTag: tag,
                activeExternalSource: null,
                activeShelf: null,
                activeTagDirectOnly: false,
                searchQuery: viewerState.searchQuery,
              },
              "push",
            );
          },
          () => openTagEditor(book),
          () => void openBookMetadataEditor(book),
          openBook,
          book.url ? (url) => void openUrl(url) : null,
        );
      });
      itemEl.addEventListener("mouseleave", () => {
        hideBookGridPopup(false);
      });
    }

    const openBookInNewWindow = () => {
      void invoke("open_viewer_window", {
        filePath: book.filePath,
        source: viewerState.activeExternalSource ?? null,
      }).catch((error: unknown) => {
        console.error("Failed to open viewer window:", error);
      });
    };
    const openBookInPlace = () => {
      void navigateToState(
        {
          bookFilePath: book.filePath,
          activeDirectory: viewerState.activeDirectory,
          activeTag: viewerState.activeTag,
          activeExternalSource: viewerState.activeExternalSource,
          activeShelf: viewerState.activeShelf,
          activeTagDirectOnly: viewerState.activeTagDirectOnly,
          searchQuery: viewerState.searchQuery,
        },
        "push",
      );
    };
    // Use the platform-conventional modifier for "open in new window": Cmd
    // on macOS, Ctrl elsewhere. Ctrl on macOS is reserved for the system
    // context menu so we must not treat it as a new-window trigger.
    const isMacPlatform = navigator.platform.toUpperCase().includes("MAC");
    const wantsNewWindow = (event: MouseEvent | KeyboardEvent): boolean =>
      isMacPlatform ? event.metaKey : event.ctrlKey;

    itemEl.addEventListener("click", (event) => {
      if (!book.isOpenable) {
        void openBookMetadataEditor(book);
        return;
      }
      if (wantsNewWindow(event)) {
        openBookInNewWindow();
        return;
      }
      openBookInPlace();
    });
    itemEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        if (!book.isOpenable) {
          void openBookMetadataEditor(book);
          return;
        }
        if (wantsNewWindow(event)) {
          openBookInNewWindow();
          return;
        }
        openBookInPlace();
      }
    });
    itemEl.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      if (!book.isOpenable) {
        void openBookMetadataEditor(book);
      }
    });

    listEl.appendChild(itemEl);
    thumbnailBookByImage.set(thumbEl, book);
    ensureThumbnailObserver().observe(thumbEl);
  }

  container.appendChild(listEl);
}

export async function registerThumbnailEvents() {
  await listen<{ filePath: string; thumbnailPath: string }>("thumbnail-ready", (event) => {
    applyThumbnail(event.payload.filePath, event.payload.thumbnailPath);
  });
}
