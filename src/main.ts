import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type BookSummary = {
  fileName: string;
  filePath: string;
  fileSize: number;
};

type LibrarySnapshot = {
  watchRoot: string;
  indexedCount: number;
  recentBooks: BookSummary[];
};

function renderSnapshot(snapshot: LibrarySnapshot) {
  const watchRootEl = document.querySelector<HTMLElement>("#watch-root");
  const indexedCountEl = document.querySelector<HTMLElement>("#indexed-count");
  const recentBooksEl = document.querySelector<HTMLElement>("#recent-books");
  const statusEl = document.querySelector<HTMLElement>("#scan-status");

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

    if (snapshot.recentBooks.length === 0) {
      const emptyEl = document.createElement("li");
      emptyEl.textContent = "まだ PDF が見つかっていません。";
      recentBooksEl.appendChild(emptyEl);
      return;
    }

    for (const book of snapshot.recentBooks) {
      const itemEl = document.createElement("li");
      itemEl.className = "book-item";

      const titleEl = document.createElement("strong");
      titleEl.textContent = book.fileName;

      const pathEl = document.createElement("span");
      pathEl.textContent = book.filePath;

      itemEl.appendChild(titleEl);
      itemEl.appendChild(pathEl);
      recentBooksEl.appendChild(itemEl);
    }
  }
}

window.addEventListener("DOMContentLoaded", async () => {
  const statusEl = document.querySelector<HTMLElement>("#scan-status");

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
    })
    .catch((error) => {
      if (statusEl) {
        statusEl.textContent = `起動時スキャンに失敗しました: ${error}`;
      }
    });
});
