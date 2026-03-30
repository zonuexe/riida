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
  excludedDirNames: string[];
  excludedFileSuffixes: string[];
};

type ViewerState = {
  books: BookSummary[];
  currentBook: BookSummary | null;
  activeDirectory: string | null;
  searchQuery: string;
  expandedDirectories: Set<string>;
  sidebarCollapsed: boolean;
};

type DirectoryNode = {
  id: string;
  label: string;
  path: string;
  depth: number;
  count: number;
  parentPath: string | null;
  hasChildren: boolean;
};

const viewerState: ViewerState = {
  books: [],
  currentBook: null,
  activeDirectory: null,
  searchQuery: "",
  expandedDirectories: new Set<string>(),
  sidebarCollapsed: false,
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

function deriveDirectories(snapshot: LibrarySnapshot): DirectoryNode[] {
  const counts = new Map<string, number>();
  const watchRoot = snapshot.watchRoot.replace(/\/+$/, "");

  for (const book of snapshot.books) {
    const relative = book.filePath.startsWith(`${watchRoot}/`)
      ? book.filePath.slice(watchRoot.length + 1)
      : book.filePath;
    const parts = relative.split("/").slice(0, -1);
    let current = "";

    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      counts.set(current, (counts.get(current) ?? 0) + 1);
    }
  }

  const paths = [...counts.keys()];

  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b, "ja"))
    .map(([path, count]) => ({
      id: path,
      label: path.split("/")[path.split("/").length - 1] ?? path,
      path,
      depth: path.split("/").length - 1,
      count,
      parentPath: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null,
      hasChildren: paths.some((candidate) => candidate.startsWith(`${path}/`)),
    }));
}

function ensureExpandedPath(path: string | null) {
  if (!path) {
    return;
  }

  const parts = path.split("/");
  let current = "";

  for (const part of parts.slice(0, -1)) {
    current = current ? `${current}/${part}` : part;
    viewerState.expandedDirectories.add(current);
  }
}

function isNodeVisible(node: DirectoryNode) {
  if (node.depth === 0) {
    return true;
  }

  return node.parentPath ? viewerState.expandedDirectories.has(node.parentPath) : true;
}

function normalizeSearchText(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("ja")
    .replace(/[\s\-_.\/]+/g, "");
}

function visibleBooks(snapshot: LibrarySnapshot) {
  return snapshot.books.filter((book) => {
    if (viewerState.activeDirectory) {
      const directory = viewerState.activeDirectory.replace(/\/+$/, "");
      const watchRoot = snapshot.watchRoot.replace(/\/+$/, "");
      const prefix = `${watchRoot}/${directory}/`;

      if (!book.filePath.startsWith(prefix)) {
        return false;
      }
    }

    if (!viewerState.searchQuery) {
      return true;
    }

    const query = normalizeSearchText(viewerState.searchQuery);
    const normalizedName = normalizeSearchText(book.fileName);
    const normalizedPath = normalizeSearchText(book.filePath);

    return (
      normalizedName.includes(query) ||
      normalizedPath.includes(query)
    );
  });
}

function currentSectionTitle() {
  if (viewerState.currentBook) {
    return "PDF ビューア";
  }

  if (viewerState.searchQuery) {
    return "検索結果";
  }

  if (viewerState.activeDirectory) {
    const segments = viewerState.activeDirectory.split("/");
    return segments[segments.length - 1] ?? viewerState.activeDirectory;
  }

  return "ホーム";
}

function currentSectionDescription(snapshot: LibrarySnapshot, books: BookSummary[]) {
  if (viewerState.currentBook) {
    return viewerState.currentBook.fileName;
  }

  if (viewerState.searchQuery) {
    return `「${viewerState.searchQuery}」に一致する ${books.length} 件`;
  }

  if (viewerState.activeDirectory) {
    return `${viewerState.activeDirectory} 配下の ${books.length} 件`;
  }

  const dirRules = snapshot.excludedDirNames.map((rule) => `dir:${rule}`);
  const fileRules = snapshot.excludedFileSuffixes.map((rule) => `file:*${rule}`);
  return `監視: ${snapshot.watchRoot} / 除外: ${[...dirRules, ...fileRules].join(" / ")}`;
}

async function renderCurrentPage() {
  const frame = document.querySelector<HTMLIFrameElement>("#pdf-frame");

  if (!frame || !viewerState.currentBook) {
    return;
  }

  frame.src = convertFileSrc(viewerState.currentBook.filePath);
}

async function openBook(book: BookSummary) {
  viewerState.currentBook = book;
  renderApp();
  await renderCurrentPage();
}

function renderSidebar(snapshot: LibrarySnapshot) {
  const navEl = document.querySelector<HTMLElement>("#sidebar-nav");
  if (!navEl) {
    return;
  }

  navEl.innerHTML = "";

  const homeButton = document.createElement("button");
  homeButton.type = "button";
  homeButton.className = "nav-link";
  homeButton.textContent = "ホーム";
  homeButton.classList.toggle(
    "is-active",
    viewerState.currentBook === null && viewerState.activeDirectory === null,
  );
  homeButton.addEventListener("click", () => {
    viewerState.currentBook = null;
    viewerState.activeDirectory = null;
    renderApp();
  });
  navEl.appendChild(homeButton);

  const directoryHeader = document.createElement("p");
  directoryHeader.className = "nav-section-title";
  directoryHeader.textContent = "ディレクトリ";
  navEl.appendChild(directoryHeader);

  for (const node of deriveDirectories(snapshot)) {
    if (!isNodeVisible(node)) {
      continue;
    }

    const row = document.createElement("div");
    row.className = "nav-tree-row";
    row.style.setProperty("--depth", String(node.depth));

    const button = document.createElement("button");
    button.type = "button";
    button.className = "nav-link nav-tree-link";
    button.classList.toggle("is-active", viewerState.activeDirectory === node.path);

    const labelEl = document.createElement("span");
    labelEl.textContent = node.label;

    const countEl = document.createElement("small");
    countEl.textContent = String(node.count);

    button.appendChild(labelEl);
    button.appendChild(countEl);
    button.addEventListener("click", () => {
      viewerState.currentBook = null;
      viewerState.activeDirectory = node.path;
      ensureExpandedPath(node.path);
      renderApp();
    });

    if (node.hasChildren) {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "nav-toggle";
      toggle.textContent = viewerState.expandedDirectories.has(node.path) ? "▾" : "▸";
      toggle.setAttribute("aria-label", `${node.label} を展開または折り畳み`);
      toggle.addEventListener("click", (event) => {
        event.stopPropagation();
        if (viewerState.expandedDirectories.has(node.path)) {
          viewerState.expandedDirectories.delete(node.path);
        } else {
          viewerState.expandedDirectories.add(node.path);
        }
        renderApp();
      });
      row.appendChild(toggle);
    } else {
      const spacer = document.createElement("span");
      spacer.className = "nav-toggle-spacer";
      spacer.setAttribute("aria-hidden", "true");
      row.appendChild(spacer);
    }

    row.appendChild(button);
    navEl.appendChild(row);
  }

  const futureHeader = document.createElement("p");
  futureHeader.className = "nav-section-title";
  futureHeader.textContent = "今後";
  navEl.appendChild(futureHeader);

  const futureTag = document.createElement("div");
  futureTag.className = "nav-placeholder";
  futureTag.textContent = "タグ";
  navEl.appendChild(futureTag);
}

function renderBookList(books: BookSummary[], container: HTMLElement) {
  container.innerHTML = "";

  if (books.length === 0) {
    const emptyEl = document.createElement("div");
    emptyEl.className = "empty-state";
    emptyEl.textContent =
      viewerState.searchQuery || viewerState.activeDirectory
        ? "条件に一致する PDF がありません。"
        : "まだ PDF が見つかっていません。";
    container.appendChild(emptyEl);
    return;
  }

  const listEl = document.createElement("ul");
  listEl.className = "books";

  for (const book of books) {
    const itemEl = document.createElement("li");
    itemEl.className = "book-item";
    itemEl.tabIndex = 0;
    itemEl.dataset.filePath = book.filePath;
    itemEl.classList.toggle("is-selected", viewerState.currentBook?.filePath === book.filePath);

    const thumbEl = document.createElement("img");
    thumbEl.className = "book-thumb";
    thumbEl.alt = `${book.fileName} cover thumbnail`;
    thumbEl.dataset.filePath = book.filePath;
    thumbEl.dataset.loaded = "false";

    const bodyEl = document.createElement("div");
    bodyEl.className = "book-copy";

    const titleEl = document.createElement("strong");
    titleEl.textContent = book.fileName;

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
      void openBook(book);
    });
    itemEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        void openBook(book);
      }
    });

    listEl.appendChild(itemEl);
    ensureThumbnailObserver().observe(thumbEl);
  }

  container.appendChild(listEl);
}

function renderMain(snapshot: LibrarySnapshot) {
  const appShellEl = document.querySelector<HTMLElement>(".two-pane");
  const sidebarToggleEl = document.querySelector<HTMLButtonElement>("#sidebar-toggle");
  const mainHeaderEl = document.querySelector<HTMLElement>(".main-header");
  const sectionTitleEl = document.querySelector<HTMLElement>("#main-title");
  const sectionDescriptionEl = document.querySelector<HTMLElement>("#main-description");
  const statusEl = document.querySelector<HTMLElement>("#scan-status");
  const homeViewEl = document.querySelector<HTMLElement>("#home-view");
  const pdfViewEl = document.querySelector<HTMLElement>("#pdf-view");
  const shelfEl = document.querySelector<HTMLElement>("#book-results");
  const searchInput = document.querySelector<HTMLInputElement>("#library-search");
  const homeCountEl = document.querySelector<HTMLElement>("#indexed-count");
  const watchRootEl = document.querySelector<HTMLElement>("#watch-root");
  const excludedRulesEl = document.querySelector<HTMLElement>("#excluded-rules");

  const books = visibleBooks(snapshot);

  appShellEl?.classList.toggle("sidebar-collapsed", viewerState.sidebarCollapsed);
  if (sidebarToggleEl) {
    sidebarToggleEl.textContent = viewerState.sidebarCollapsed ? "≫" : "≪";
    sidebarToggleEl.setAttribute(
      "aria-label",
      viewerState.sidebarCollapsed ? "サイドバーを表示" : "サイドバーを隠す",
    );
    sidebarToggleEl.setAttribute("aria-expanded", String(!viewerState.sidebarCollapsed));
  }

  if (searchInput && searchInput.value !== viewerState.searchQuery) {
    searchInput.value = viewerState.searchQuery;
  }

  if (sectionTitleEl) {
    sectionTitleEl.textContent = currentSectionTitle();
  }

  if (sectionDescriptionEl) {
    sectionDescriptionEl.textContent = currentSectionDescription(snapshot, books);
  }

  if (watchRootEl) {
    watchRootEl.textContent = snapshot.watchRoot;
  }

  if (excludedRulesEl) {
    const dirRules = snapshot.excludedDirNames.map((rule) => `dir:${rule}`);
    const fileRules = snapshot.excludedFileSuffixes.map((rule) => `file:*${rule}`);
    excludedRulesEl.textContent = [...dirRules, ...fileRules].join(" / ");
  }

  if (homeCountEl) {
    homeCountEl.textContent = String(snapshot.indexedCount);
  }

  if (statusEl) {
    statusEl.textContent = "蔵書一覧は最新です。";
  }

  if (viewerState.currentBook) {
    mainHeaderEl?.setAttribute("hidden", "true");
    homeViewEl?.setAttribute("hidden", "true");
    pdfViewEl?.removeAttribute("hidden");
    void renderCurrentPage();
  } else {
    mainHeaderEl?.removeAttribute("hidden");
    pdfViewEl?.setAttribute("hidden", "true");
    homeViewEl?.removeAttribute("hidden");
    if (shelfEl) {
      renderBookList(books, shelfEl);
    }
  }
}

function renderApp() {
  if (!lastSnapshot) {
    return;
  }

  renderSidebar(lastSnapshot);
  renderMain(lastSnapshot);
}

window.addEventListener("DOMContentLoaded", async () => {
  const statusEl = document.querySelector<HTMLElement>("#scan-status");
  const searchInput = document.querySelector<HTMLInputElement>("#library-search");
  const sidebarToggleEl = document.querySelector<HTMLButtonElement>("#sidebar-toggle");

  searchInput?.addEventListener("input", () => {
    viewerState.searchQuery = searchInput.value.trim();
    viewerState.currentBook = null;
    viewerState.activeDirectory = null;
    renderApp();
  });

  sidebarToggleEl?.addEventListener("click", () => {
    viewerState.sidebarCollapsed = !viewerState.sidebarCollapsed;
    renderApp();
  });

  await listen<LibrarySnapshot>("library-updated", (event) => {
    lastSnapshot = event.payload;
    viewerState.books = event.payload.books;
    if (
      viewerState.currentBook &&
      !event.payload.books.some((book) => book.filePath === viewerState.currentBook?.filePath)
    ) {
      viewerState.currentBook = null;
    }
    renderApp();
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
      lastSnapshot = snapshot;
      viewerState.books = snapshot.books;
      renderApp();
    })
    .catch((error) => {
      if (statusEl) {
        statusEl.textContent = `起動時スキャンに失敗しました: ${error}`;
      }
    });
});
