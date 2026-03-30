import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type BookSummary = {
  fileName: string;
  filePath: string;
  fileSize: number;
};

type LibrarySnapshot = {
  watchRoot: string;
  indexedCount: number;
  books: BookSummary[];
};

type ViewerState = {
  books: BookSummary[];
  currentBook: BookSummary | null;
};

const viewerState: ViewerState = {
  books: [],
  currentBook: null,
};

let lastSnapshot: LibrarySnapshot | null = null;
const thumbnailUrls = new Map<string, string>();
let thumbnailObserver: IntersectionObserver | null = null;

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

function syncSelectedBookHighlight() {
  const bookItems = document.querySelectorAll<HTMLLIElement>(".book-item");

  for (const itemEl of bookItems) {
    const isSelected = itemEl.dataset.filePath === viewerState.currentBook?.filePath;
    itemEl.classList.toggle("is-selected", isSelected);
  }
}

function formatFileSize(fileSize: number) {
  const units = ["B", "KB", "MB", "GB"];
  let size = fileSize;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

async function loadThumbnail(book: BookSummary, imageEl: HTMLImageElement) {
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
        const filePath = imageEl.dataset.filePath;
        const book = viewerState.books.find((candidate) => candidate.filePath === filePath);

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

function filteredBooks() {
  const searchInput = document.querySelector<HTMLInputElement>("#library-search");
  const query = searchInput?.value.trim().toLowerCase() ?? "";

  if (!query) {
    return viewerState.books;
  }

  return viewerState.books.filter((book) => {
    const name = book.fileName.toLowerCase();
    const path = book.filePath.toLowerCase();
    return name.includes(query) || path.includes(query);
  });
}

async function renderCurrentPage() {
  const frame = document.querySelector<HTMLIFrameElement>("#pdf-frame");
  const viewerStatusEl = document.querySelector<HTMLElement>("#viewer-status");

  if (!frame || !viewerState.currentBook) {
    return;
  }
  frame.src = convertFileSrc(viewerState.currentBook.filePath);

  if (viewerStatusEl && viewerState.currentBook) {
    viewerStatusEl.textContent = `${viewerState.currentBook.fileName} をネイティブビューアで表示中です。`;
  }
}

async function openBook(book: BookSummary) {
  const viewerTitleEl = document.querySelector<HTMLElement>("#viewer-title");
  const viewerStatusEl = document.querySelector<HTMLElement>("#viewer-status");

  if (viewerTitleEl) {
    viewerTitleEl.textContent = book.fileName;
  }

  if (viewerStatusEl) {
    viewerStatusEl.textContent = "PDF を読み込み中...";
  }

  viewerState.currentBook = book;
  syncSelectedBookHighlight();
  await renderCurrentPage();
}

function renderSnapshot(snapshot: LibrarySnapshot) {
  const watchRootEl = document.querySelector<HTMLElement>("#watch-root");
  const indexedCountEl = document.querySelector<HTMLElement>("#indexed-count");
  const recentBooksEl = document.querySelector<HTMLElement>("#recent-books");
  const statusEl = document.querySelector<HTMLElement>("#scan-status");

  const previousFilePath = viewerState.currentBook?.filePath;
  viewerState.books = snapshot.books;
  viewerState.currentBook =
    viewerState.books.find((book) => book.filePath === previousFilePath) ?? null;
  lastSnapshot = snapshot;

  if (watchRootEl) {
    watchRootEl.textContent = snapshot.watchRoot;
  }

  if (indexedCountEl) {
    indexedCountEl.textContent = String(snapshot.indexedCount);
  }

  if (statusEl) {
    statusEl.textContent = "蔵書一覧は最新です。";
  }

  if (recentBooksEl) {
    recentBooksEl.innerHTML = "";

    const books = filteredBooks();

    if (books.length === 0) {
      const emptyEl = document.createElement("li");
      emptyEl.textContent =
        viewerState.books.length === 0
          ? "まだ PDF が見つかっていません。"
          : "検索条件に一致する PDF がありません。";
      recentBooksEl.appendChild(emptyEl);
      return;
    }

    for (const book of books) {
      const itemEl = document.createElement("li");
      itemEl.className = "book-item";
      itemEl.tabIndex = 0;
      itemEl.dataset.filePath = book.filePath;

      const titleEl = document.createElement("strong");
      titleEl.textContent = book.fileName;

      const thumbEl = document.createElement("img");
      thumbEl.className = "book-thumb";
      thumbEl.alt = `${book.fileName} cover thumbnail`;
      thumbEl.dataset.filePath = book.filePath;
      thumbEl.dataset.loaded = "false";

      const bodyEl = document.createElement("div");
      bodyEl.className = "book-copy";

      const pathEl = document.createElement("span");
      pathEl.textContent = book.filePath;

      const metaEl = document.createElement("small");
      metaEl.className = "book-meta";
      metaEl.textContent = formatFileSize(book.fileSize);

      bodyEl.appendChild(titleEl);
      bodyEl.appendChild(pathEl);
      bodyEl.appendChild(metaEl);

      itemEl.appendChild(thumbEl);
      itemEl.appendChild(bodyEl);
      itemEl.addEventListener("click", () => {
        void openBook(book).catch((error) => {
          const viewerStatusEl = document.querySelector<HTMLElement>("#viewer-status");
          if (viewerStatusEl) {
            viewerStatusEl.textContent = `PDF の表示に失敗しました: ${String(error)}`;
          }
        });
      });
      itemEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          void openBook(book).catch((error) => {
            const viewerStatusEl = document.querySelector<HTMLElement>("#viewer-status");
            if (viewerStatusEl) {
              viewerStatusEl.textContent = `PDF の表示に失敗しました: ${String(error)}`;
            }
          });
        }
      });
      recentBooksEl.appendChild(itemEl);
      ensureThumbnailObserver().observe(thumbEl);
    }
  }

  syncSelectedBookHighlight();
}

window.addEventListener("DOMContentLoaded", async () => {
  const statusEl = document.querySelector<HTMLElement>("#scan-status");
  const searchInput = document.querySelector<HTMLInputElement>("#library-search");

  searchInput?.addEventListener("input", () => {
    if (lastSnapshot) {
      renderSnapshot(lastSnapshot);
    }
  });

  await listen<LibrarySnapshot>("library-updated", (event) => {
    renderSnapshot(event.payload);
  });

  await listen<string>("library-watch-error", (event) => {
    if (statusEl) {
      statusEl.textContent = `監視エラー: ${event.payload}`;
    }
  });

  await listen<{ filePath: string; thumbnailPath: string }>("thumbnail-ready", (event) => {
    applyThumbnail(event.payload.filePath, event.payload.thumbnailPath);
  });

  invoke<LibrarySnapshot>("library_snapshot")
    .then((snapshot) => {
      renderSnapshot(snapshot);

      if (viewerState.currentBook) {
        void openBook(viewerState.currentBook).catch((error) => {
          if (statusEl) {
            statusEl.textContent = `PDF の初期表示に失敗しました: ${String(error)}`;
          }
        });
      } else if (snapshot.books.length > 0) {
        void openBook(snapshot.books[0]).catch((error) => {
          if (statusEl) {
            statusEl.textContent = `PDF の初期表示に失敗しました: ${String(error)}`;
          }
        });
      }
    })
    .catch((error) => {
      if (statusEl) {
        statusEl.textContent = `起動時スキャンに失敗しました: ${error}`;
      }
    });
});
