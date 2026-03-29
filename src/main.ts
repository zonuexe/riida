import { invoke } from "@tauri-apps/api/core";

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

window.addEventListener("DOMContentLoaded", () => {
  const watchRootEl = document.querySelector<HTMLElement>("#watch-root");
  const indexedCountEl = document.querySelector<HTMLElement>("#indexed-count");
  const recentBooksEl = document.querySelector<HTMLElement>("#recent-books");
  const statusEl = document.querySelector<HTMLElement>("#scan-status");

  invoke<LibrarySnapshot>("library_snapshot")
    .then((snapshot) => {
      if (watchRootEl) {
        watchRootEl.textContent = snapshot.watchRoot;
      }

      if (indexedCountEl) {
        indexedCountEl.textContent = String(snapshot.indexedCount);
      }

      if (statusEl) {
        statusEl.textContent = "起動時スキャンが完了しました。";
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
    })
    .catch((error) => {
      if (watchRootEl) {
        watchRootEl.textContent = `監視対象の読込に失敗しました: ${error}`;
      }

      if (statusEl) {
        statusEl.textContent = "起動時スキャンに失敗しました。";
      }
    });
});
