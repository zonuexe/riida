import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";

GlobalWorkerOptions.workerSrc = workerUrl;

type BookSummary = {
  fileName: string;
  filePath: string;
  fileSize: number;
  lastPage?: number | null;
};

type LibrarySnapshot = {
  watchRoot: string;
  indexedCount: number;
  books: BookSummary[];
};

type ViewerState = {
  books: BookSummary[];
  currentBook: BookSummary | null;
  pdf: PDFDocumentProxy | null;
  currentPage: number;
};

const viewerState: ViewerState = {
  books: [],
  currentBook: null,
  pdf: null,
  currentPage: 1,
};

let lastSnapshot: LibrarySnapshot | null = null;

let saveProgressTimer: number | null = null;

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

function queueSaveReadingProgress() {
  if (!viewerState.currentBook) {
    return;
  }

  if (saveProgressTimer) {
    window.clearTimeout(saveProgressTimer);
  }

  saveProgressTimer = window.setTimeout(() => {
    if (!viewerState.currentBook) {
      return;
    }

    void invoke("save_reading_progress", {
      payload: {
        filePath: viewerState.currentBook.filePath,
        lastPage: viewerState.currentPage,
      },
    });
  }, 250);
}

async function renderCurrentPage() {
  const canvas = document.querySelector<HTMLCanvasElement>("#pdf-canvas");
  const pageIndicatorEl = document.querySelector<HTMLElement>("#page-indicator");
  const viewerStatusEl = document.querySelector<HTMLElement>("#viewer-status");

  if (!canvas || !viewerState.pdf) {
    return;
  }

  const page = await viewerState.pdf.getPage(viewerState.currentPage);
  const viewport = page.getViewport({ scale: 1.15 });
  const context = canvas.getContext("2d");

  if (!context) {
    return;
  }

  canvas.width = viewport.width;
  canvas.height = viewport.height;

  await page.render({
    canvas,
    canvasContext: context,
    viewport,
  }).promise;

  if (pageIndicatorEl) {
    pageIndicatorEl.textContent = `${viewerState.currentPage} / ${viewerState.pdf.numPages}`;
  }

  if (viewerStatusEl && viewerState.currentBook) {
    viewerStatusEl.textContent = `${viewerState.currentBook.fileName} を表示中です。`;
  }

  queueSaveReadingProgress();
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

  if (viewerState.pdf) {
    await viewerState.pdf.destroy();
  }

  viewerState.currentBook = book;
  viewerState.currentPage = Math.max(1, book.lastPage ?? 1);
  syncSelectedBookHighlight();

  const pdfUrl = convertFileSrc(book.filePath);
  viewerState.pdf = await getDocument(pdfUrl).promise;
  viewerState.currentPage = Math.min(viewerState.currentPage, viewerState.pdf.numPages);
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

      const pathEl = document.createElement("span");
      pathEl.textContent = book.filePath;

      const metaEl = document.createElement("small");
      metaEl.className = "book-meta";
      metaEl.textContent = formatFileSize(book.fileSize);

      if (book.lastPage && book.lastPage > 1) {
        const progressEl = document.createElement("small");
        progressEl.className = "book-progress";
        progressEl.textContent = `${book.lastPage} ページまで読了`;
        itemEl.appendChild(progressEl);
      }

      itemEl.appendChild(titleEl);
      itemEl.appendChild(pathEl);
      itemEl.appendChild(metaEl);
      itemEl.addEventListener("click", () => {
        void openBook(book);
      });
      itemEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          void openBook(book);
        }
      });
      recentBooksEl.appendChild(itemEl);
    }
  }

  syncSelectedBookHighlight();
}

window.addEventListener("DOMContentLoaded", async () => {
  const statusEl = document.querySelector<HTMLElement>("#scan-status");
  const prevPageButton = document.querySelector<HTMLButtonElement>("#prev-page");
  const nextPageButton = document.querySelector<HTMLButtonElement>("#next-page");
  const searchInput = document.querySelector<HTMLInputElement>("#library-search");

  prevPageButton?.addEventListener("click", () => {
    if (!viewerState.pdf || viewerState.currentPage <= 1) {
      return;
    }

    viewerState.currentPage -= 1;
    void renderCurrentPage();
  });

  nextPageButton?.addEventListener("click", () => {
    if (!viewerState.pdf || viewerState.currentPage >= viewerState.pdf.numPages) {
      return;
    }

    viewerState.currentPage += 1;
    void renderCurrentPage();
  });

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

  invoke<LibrarySnapshot>("library_snapshot")
    .then((snapshot) => {
      renderSnapshot(snapshot);

      if (viewerState.currentBook) {
        void openBook(viewerState.currentBook);
      } else if (snapshot.books.length > 0) {
        void openBook(snapshot.books[0]);
      }
    })
    .catch((error) => {
      if (statusEl) {
        statusEl.textContent = `起動時スキャンに失敗しました: ${error}`;
      }
    });
});
