import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { GlobalWorkerOptions, TextLayer, getDocument } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import { mountNoteEditor, type NoteEditorHandle } from "./note-editor";

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
  pdfRenderer: "native" | "pdfjs";
};

type NoteDocument = {
  filePath: string;
  format: string;
  content: string;
  updatedAt: number | null;
};

type ViewerState = {
  books: BookSummary[];
  currentBook: BookSummary | null;
  activeDirectory: string | null;
  searchQuery: string;
  expandedDirectories: Set<string>;
  sidebarCollapsed: boolean;
};

type ViewerSettings = {
  pageMode: "single" | "spread";
  bindingDirection: "left" | "right";
  zoomMode: "fit-width" | "fit-height" | "original";
  treatFirstPageAsCover: boolean;
  isSettingsOpen: boolean;
};

type NoteState = {
  isOpen: boolean;
  isLoading: boolean;
  isSaving: boolean;
  activeFilePath: string | null;
  currentContent: string;
  savedContent: string;
  statusMessage: string;
  x: number | null;
  y: number | null;
  width: number;
  height: number;
};

type NoteInteractionState = {
  mode: "drag" | "resize" | null;
  edge: string | null;
  startX: number;
  startY: number;
  startLeft: number;
  startTop: number;
  startWidth: number;
  startHeight: number;
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

const viewerSettings: ViewerSettings = {
  pageMode: "spread",
  bindingDirection: "left",
  zoomMode: "fit-width",
  treatFirstPageAsCover: true,
  isSettingsOpen: false,
};

let lastSnapshot: LibrarySnapshot | null = null;
const thumbnailUrls = new Map<string, string>();
let thumbnailObserver: IntersectionObserver | null = null;
let noteEditor: NoteEditorHandle | null = null;
let noteSaveTimer: number | null = null;
let noteLoadToken = 0;
let pdfRenderToken = 0;
let pdfRenderResizeTimer: number | null = null;

GlobalWorkerOptions.workerSrc = workerUrl;

const noteState: NoteState = {
  isOpen: true,
  isLoading: false,
  isSaving: false,
  activeFilePath: null,
  currentContent: "",
  savedContent: "",
  statusMessage: "ノートは自動保存されます。",
  x: null,
  y: null,
  width: 420,
  height: 540,
};

const noteInteractionState: NoteInteractionState = {
  mode: null,
  edge: null,
  startX: 0,
  startY: 0,
  startLeft: 0,
  startTop: 0,
  startWidth: 0,
  startHeight: 0,
};

const MIN_NOTE_WIDTH = 280;
const MIN_NOTE_HEIGHT = 220;

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

function renderPdfJsLinks(
  container: HTMLElement,
  viewport: { convertToViewportRectangle: (rect: number[]) => number[] },
  annotations: Array<Record<string, unknown>>,
) {
  for (const annotation of annotations) {
    if (annotation.subtype !== "Link" || !Array.isArray(annotation.rect)) {
      continue;
    }

    const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(annotation.rect);
    const left = Math.min(x1, x2);
    const top = Math.min(y1, y2);
    const width = Math.abs(x2 - x1);
    const height = Math.abs(y2 - y1);

    if (width < 2 || height < 2) {
      continue;
    }

    const sectionEl = document.createElement("section");
    sectionEl.className = "linkAnnotation";
    sectionEl.style.left = `${left}px`;
    sectionEl.style.top = `${top}px`;
    sectionEl.style.width = `${width}px`;
    sectionEl.style.height = `${height}px`;

    const linkEl = document.createElement("a");

    const maybeUrl =
      typeof annotation.url === "string"
        ? annotation.url
        : typeof annotation.unsafeUrl === "string"
          ? annotation.unsafeUrl
          : null;

    if (maybeUrl) {
      linkEl.href = maybeUrl;
      linkEl.target = "_blank";
      linkEl.rel = "noreferrer noopener";
      linkEl.title = maybeUrl;
    } else {
      linkEl.href = "#";
      linkEl.addEventListener("click", (event) => {
        event.preventDefault();
      });
    }

    sectionEl.appendChild(linkEl);
    container.appendChild(sectionEl);
  }
}

function buildPageGroups(totalPages: number) {
  const groups: number[][] = [];

  if (viewerSettings.pageMode === "single") {
    for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
      groups.push([pageNumber]);
    }
    return groups;
  }

  let pageNumber = 1;

  if (viewerSettings.treatFirstPageAsCover && totalPages > 0) {
    groups.push([1]);
    pageNumber = 2;
  }

  while (pageNumber <= totalPages) {
    if (pageNumber === totalPages) {
      groups.push([pageNumber]);
      break;
    }

    groups.push([pageNumber, pageNumber + 1]);
    pageNumber += 2;
  }

  return groups;
}

function getVisualPageOrder(group: number[]) {
  if (group.length < 2 || viewerSettings.bindingDirection === "left") {
    return group;
  }

  return [...group].reverse();
}

function normalizeSearchText(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("ja")
    .replace(/[\s\-_.\/]+/g, "");
}

function clampNoteWindow() {
  const maxLeft = Math.max(12, window.innerWidth - noteState.width - 12);
  const maxTop = Math.max(12, window.innerHeight - noteState.height - 12);

  noteState.x = Math.min(Math.max(noteState.x ?? maxLeft, 12), maxLeft);
  noteState.y = Math.min(Math.max(noteState.y ?? maxTop, 12), maxTop);
}

function ensureNoteWindowPlacement() {
  if (noteState.x === null || noteState.y === null) {
    noteState.x = Math.max(12, window.innerWidth - noteState.width - 24);
    noteState.y = Math.max(12, window.innerHeight - noteState.height - 24);
  }

  clampNoteWindow();
}

function syncNoteUi() {
  const noteToggleEl = document.querySelector<HTMLButtonElement>("#note-toggle");
  const notePanelEl = document.querySelector<HTMLElement>("#note-panel");
  const noteEditorEl = document.querySelector<HTMLElement>("#note-editor");

  const hasBook = Boolean(viewerState.currentBook);

  if (noteToggleEl) {
    noteToggleEl.hidden = !hasBook || noteState.isOpen;
    noteToggleEl.textContent = "ノート";
  }

  if (notePanelEl) {
    notePanelEl.hidden = !hasBook || !noteState.isOpen;
    if (!notePanelEl.hidden) {
      ensureNoteWindowPlacement();
      notePanelEl.style.left = `${noteState.x}px`;
      notePanelEl.style.top = `${noteState.y}px`;
      notePanelEl.style.width = `${noteState.width}px`;
      notePanelEl.style.height = `${noteState.height}px`;
    }
  }

  if (noteEditorEl) {
    noteEditorEl.dataset.empty = noteState.currentContent ? "false" : "true";
  }
}

function syncViewerSettingsUi() {
  const settingsToggleEl = document.querySelector<HTMLButtonElement>("#viewer-settings-toggle");
  const settingsPanelEl = document.querySelector<HTMLElement>("#viewer-settings-panel");
  const pageModeEl = document.querySelector<HTMLSelectElement>("#viewer-page-mode");
  const bindingEl = document.querySelector<HTMLSelectElement>("#viewer-binding-direction");
  const zoomModeEl = document.querySelector<HTMLSelectElement>("#viewer-zoom-mode");
  const coverModeEl = document.querySelector<HTMLInputElement>("#viewer-cover-mode");
  const isPdfJs = lastSnapshot?.pdfRenderer === "pdfjs" && Boolean(viewerState.currentBook);

  if (settingsToggleEl) {
    settingsToggleEl.hidden = !isPdfJs;
    settingsToggleEl.setAttribute("aria-expanded", String(viewerSettings.isSettingsOpen));
  }

  if (settingsPanelEl) {
    settingsPanelEl.hidden = !isPdfJs || !viewerSettings.isSettingsOpen;
  }

  if (pageModeEl) {
    pageModeEl.value = viewerSettings.pageMode;
  }

  if (bindingEl) {
    bindingEl.value = viewerSettings.bindingDirection;
  }

  if (zoomModeEl) {
    zoomModeEl.value = viewerSettings.zoomMode;
  }

  if (coverModeEl) {
    coverModeEl.checked = viewerSettings.treatFirstPageAsCover;
  }
}

async function destroyNoteEditor() {
  if (!noteEditor) {
    return;
  }

  await noteEditor.destroy();
  noteEditor = null;
}

async function saveNoteNow() {
  if (!noteState.activeFilePath) {
    return;
  }

  noteSaveTimer = null;
  noteState.isSaving = true;
  noteState.statusMessage = "ノートを保存中...";
  syncNoteUi();

  try {
    const note = await invoke<NoteDocument>("save_note", {
      filePath: noteState.activeFilePath,
      content: noteState.currentContent,
    });

    noteState.savedContent = note.content;
    noteState.statusMessage = "自動保存済み";
  } catch (error) {
    noteState.statusMessage = `保存に失敗しました: ${String(error)}`;
  } finally {
    noteState.isSaving = false;
    syncNoteUi();
  }
}

function scheduleNoteSave(markdown: string) {
  noteState.currentContent = markdown;
  noteState.statusMessage = "保存待ち...";
  syncNoteUi();

  if (noteSaveTimer !== null) {
    window.clearTimeout(noteSaveTimer);
  }

  noteSaveTimer = window.setTimeout(() => {
    void saveNoteNow();
  }, 900);
}

async function flushPendingNoteSave() {
  if (noteSaveTimer === null || noteState.currentContent === noteState.savedContent) {
    return;
  }

  window.clearTimeout(noteSaveTimer);
  await saveNoteNow();
}

async function loadNoteForCurrentBook() {
  const noteRootEl = document.querySelector<HTMLElement>("#note-editor");
  const currentBook = viewerState.currentBook;

  if (!currentBook || !noteState.isOpen || !noteRootEl) {
    return;
  }

  if (noteState.activeFilePath === currentBook.filePath && noteEditor) {
    return;
  }

  await flushPendingNoteSave();
  await destroyNoteEditor();

  noteLoadToken += 1;
  const currentToken = noteLoadToken;
  noteState.isLoading = true;
  noteState.activeFilePath = currentBook.filePath;
  noteState.currentContent = "";
  noteState.savedContent = "";
  noteState.statusMessage = "ノートを読み込み中...";
  syncNoteUi();

  try {
    const note = await invoke<NoteDocument>("load_note", {
      filePath: currentBook.filePath,
    });

    if (currentToken !== noteLoadToken) {
      return;
    }

    noteState.activeFilePath = note.filePath;
    noteState.currentContent = note.content;
    noteState.savedContent = note.content;
    noteState.statusMessage = note.updatedAt ? "自動保存済み" : "ノートは自動保存されます。";

    noteEditor = await mountNoteEditor({
      root: noteRootEl,
      initialMarkdown: note.content,
      onMarkdownChange: (markdown) => {
        scheduleNoteSave(markdown);
      },
    });
  } catch (error) {
    noteState.statusMessage = `ノートの読み込みに失敗しました: ${String(error)}`;
  } finally {
    if (currentToken === noteLoadToken) {
      noteState.isLoading = false;
      syncNoteUi();
    }
  }
}

async function clearCurrentBookSelection() {
  await flushPendingNoteSave();
  await destroyNoteEditor();
  noteState.activeFilePath = null;
  noteState.currentContent = "";
  noteState.savedContent = "";
  noteState.statusMessage = "ノートは自動保存されます。";
  viewerState.currentBook = null;
  syncNoteUi();
}

function beginNoteDrag(event: PointerEvent) {
  const target = event.target as HTMLElement | null;
  if (!target || target.closest("#note-close")) {
    return;
  }

  event.preventDefault();
  ensureNoteWindowPlacement();

  noteInteractionState.mode = "drag";
  noteInteractionState.edge = null;
  noteInteractionState.startX = event.clientX;
  noteInteractionState.startY = event.clientY;
  noteInteractionState.startLeft = noteState.x ?? 0;
  noteInteractionState.startTop = noteState.y ?? 0;
}

function beginNoteResize(event: PointerEvent, edge: string) {
  event.preventDefault();
  ensureNoteWindowPlacement();

  noteInteractionState.mode = "resize";
  noteInteractionState.edge = edge;
  noteInteractionState.startX = event.clientX;
  noteInteractionState.startY = event.clientY;
  noteInteractionState.startLeft = noteState.x ?? 0;
  noteInteractionState.startTop = noteState.y ?? 0;
  noteInteractionState.startWidth = noteState.width;
  noteInteractionState.startHeight = noteState.height;
}

function updateNoteInteraction(event: PointerEvent) {
  if (!noteInteractionState.mode) {
    return;
  }

  const dx = event.clientX - noteInteractionState.startX;
  const dy = event.clientY - noteInteractionState.startY;

  if (noteInteractionState.mode === "drag") {
    noteState.x = noteInteractionState.startLeft + dx;
    noteState.y = noteInteractionState.startTop + dy;
    clampNoteWindow();
    syncNoteUi();
    return;
  }

  const edge = noteInteractionState.edge ?? "";
  let nextLeft = noteInteractionState.startLeft;
  let nextTop = noteInteractionState.startTop;
  let nextWidth = noteInteractionState.startWidth;
  let nextHeight = noteInteractionState.startHeight;

  if (edge.includes("e")) {
    nextWidth = Math.max(MIN_NOTE_WIDTH, noteInteractionState.startWidth + dx);
  }

  if (edge.includes("s")) {
    nextHeight = Math.max(MIN_NOTE_HEIGHT, noteInteractionState.startHeight + dy);
  }

  if (edge.includes("w")) {
    nextWidth = Math.max(MIN_NOTE_WIDTH, noteInteractionState.startWidth - dx);
    nextLeft = noteInteractionState.startLeft + dx;
    if (nextWidth === MIN_NOTE_WIDTH) {
      nextLeft = noteInteractionState.startLeft + (noteInteractionState.startWidth - MIN_NOTE_WIDTH);
    }
  }

  if (edge.includes("n")) {
    nextHeight = Math.max(MIN_NOTE_HEIGHT, noteInteractionState.startHeight - dy);
    nextTop = noteInteractionState.startTop + dy;
    if (nextHeight === MIN_NOTE_HEIGHT) {
      nextTop = noteInteractionState.startTop + (noteInteractionState.startHeight - MIN_NOTE_HEIGHT);
    }
  }

  noteState.width = Math.min(nextWidth, window.innerWidth - 24);
  noteState.height = Math.min(nextHeight, window.innerHeight - 24);
  noteState.x = nextLeft;
  noteState.y = nextTop;
  clampNoteWindow();
  syncNoteUi();
}

function endNoteInteraction() {
  noteInteractionState.mode = null;
  noteInteractionState.edge = null;
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

async function renderCurrentPage() {
  const frame = document.querySelector<HTMLIFrameElement>("#pdf-frame");
  const pdfjsViewerEl = document.querySelector<HTMLElement>("#pdfjs-viewer");
  const snapshot = lastSnapshot;

  if (!frame || !pdfjsViewerEl || !viewerState.currentBook || !snapshot) {
    return;
  }

  const sourceUrl = convertFileSrc(viewerState.currentBook.filePath);

  if (snapshot.pdfRenderer === "pdfjs") {
    frame.hidden = true;
    frame.src = "about:blank";
    pdfjsViewerEl.hidden = false;
    pdfjsViewerEl.innerHTML = "";

    pdfRenderToken += 1;
    const currentToken = pdfRenderToken;
    const loadingEl = document.createElement("div");
    loadingEl.className = "pdfjs-loading";
    loadingEl.textContent = "PDF を描画中...";
    pdfjsViewerEl.appendChild(loadingEl);

    try {
      const documentTask = getDocument({
        url: sourceUrl,
        cMapUrl: "/pdfjs/cmaps/node_modules/pdfjs-dist/cmaps/",
        cMapPacked: true,
        standardFontDataUrl: "/pdfjs/standard_fonts/node_modules/pdfjs-dist/standard_fonts/",
        useSystemFonts: true,
        disableFontFace: true,
      });
      const pdfDocument = await documentTask.promise;

      if (currentToken !== pdfRenderToken) {
        return;
      }

      pdfjsViewerEl.innerHTML = "";
      const pageGroups = buildPageGroups(pdfDocument.numPages);
      const pageGap = viewerSettings.pageMode === "spread" ? 6 : 0;
      const viewerWidth = Math.max(pdfjsViewerEl.clientWidth, 720);
      const viewerHeight = Math.max(pdfjsViewerEl.clientHeight, 600);
      const maxColumns = viewerSettings.pageMode === "spread" ? 2 : 1;
      const availableWidth = viewerWidth - pageGap * (maxColumns - 1) - 32;

      for (const group of pageGroups) {
        const visualOrder = getVisualPageOrder(group);
        const spreadEl = document.createElement("section");
        spreadEl.className = "pdfjs-spread";
        spreadEl.dataset.pageCount = String(visualOrder.length);
        spreadEl.dataset.binding = viewerSettings.bindingDirection;
        spreadEl.dataset.cover = String(group.length === 1);
        pdfjsViewerEl.appendChild(spreadEl);

        const samplePage = await pdfDocument.getPage(group[0]);
        const sampleViewport = samplePage.getViewport({ scale: 1 });
        const targetWidth =
          viewerSettings.pageMode === "spread"
            ? Math.max(220, Math.floor(availableWidth / Math.max(visualOrder.length, 1)))
            : Math.max(320, availableWidth);
        const targetHeight = Math.max(260, viewerHeight - 56);

        let baseScale = 1;
        if (viewerSettings.zoomMode === "fit-width") {
          baseScale = targetWidth / Math.max(sampleViewport.width, 1);
        } else if (viewerSettings.zoomMode === "fit-height") {
          baseScale = targetHeight / Math.max(sampleViewport.height, 1);
        }

        pdfjsViewerEl.style.setProperty("--scale-factor", String(baseScale));

        for (const pageNumber of visualOrder) {
        const page = await pdfDocument.getPage(pageNumber);
          const viewport = page.getViewport({ scale: baseScale });

          const pageEl = document.createElement("section");
          pageEl.className = "pdfjs-page page";
          pageEl.style.width = `${viewport.width}px`;
          pageEl.style.height = `${viewport.height}px`;

          const canvasWrapperEl = document.createElement("div");
          canvasWrapperEl.className = "canvasWrapper";
          const canvas = document.createElement("canvas");
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          canvasWrapperEl.appendChild(canvas);
          pageEl.appendChild(canvasWrapperEl);

          const textLayerEl = document.createElement("div");
          textLayerEl.className = "textLayer";
          pageEl.appendChild(textLayerEl);

          const linkLayerEl = document.createElement("div");
          linkLayerEl.className = "annotationLayer";
          pageEl.appendChild(linkLayerEl);
          spreadEl.appendChild(pageEl);

          const context = canvas.getContext("2d");
          if (!context) {
            continue;
          }

          await page.render({
            canvas,
            canvasContext: context,
            viewport,
          }).promise;

          const textLayer = new TextLayer({
            textContentSource: page.streamTextContent(),
            container: textLayerEl,
            viewport,
          });
          await textLayer.render();

          const annotations = await page.getAnnotations();
          renderPdfJsLinks(linkLayerEl, viewport, annotations as Array<Record<string, unknown>>);

          if (currentToken !== pdfRenderToken) {
            return;
          }
        }
      }
    } catch (error) {
      pdfjsViewerEl.innerHTML = "";
      const errorEl = document.createElement("div");
      errorEl.className = "pdfjs-loading";
      errorEl.textContent = `PDF.js での表示に失敗しました: ${String(error)}`;
      pdfjsViewerEl.appendChild(errorEl);
    }

    return;
  }

  pdfRenderToken += 1;
  pdfjsViewerEl.hidden = true;
  pdfjsViewerEl.innerHTML = "";
  frame.hidden = false;
  frame.src = sourceUrl;
}

async function openBook(book: BookSummary) {
  if (viewerState.currentBook?.filePath !== book.filePath) {
    await flushPendingNoteSave();
    await destroyNoteEditor();
  }

  viewerState.currentBook = book;
  renderApp();
  await renderCurrentPage();
  await loadNoteForCurrentBook();
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
    void clearCurrentBookSelection().then(() => {
      viewerState.activeDirectory = null;
      renderApp();
    });
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
      void clearCurrentBookSelection().then(() => {
        viewerState.activeDirectory = node.path;
        ensureExpandedPath(node.path);
        renderApp();
      });
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
  syncViewerSettingsUi();

  if (searchInput && searchInput.value !== viewerState.searchQuery) {
    searchInput.value = viewerState.searchQuery;
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
    homeViewEl?.setAttribute("hidden", "true");
    pdfViewEl?.removeAttribute("hidden");
    void renderCurrentPage();
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
    }
    if (pdfjsViewerEl) {
      pdfjsViewerEl.innerHTML = "";
      pdfjsViewerEl.hidden = true;
    }
    syncNoteUi();
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
  const noteToggleEl = document.querySelector<HTMLButtonElement>("#note-toggle");
  const noteCloseEl = document.querySelector<HTMLButtonElement>("#note-close");
  const viewerSettingsToggleEl = document.querySelector<HTMLButtonElement>("#viewer-settings-toggle");
  const viewerSettingsPanelEl = document.querySelector<HTMLElement>("#viewer-settings-panel");
  const viewerPageModeEl = document.querySelector<HTMLSelectElement>("#viewer-page-mode");
  const viewerBindingEl = document.querySelector<HTMLSelectElement>("#viewer-binding-direction");
  const viewerZoomModeEl = document.querySelector<HTMLSelectElement>("#viewer-zoom-mode");
  const viewerCoverModeEl = document.querySelector<HTMLInputElement>("#viewer-cover-mode");
  const noteDragHandleEl = document.querySelector<HTMLElement>("#note-drag-handle");
  const noteResizeEls = document.querySelectorAll<HTMLElement>(".note-resize-handle");

  searchInput?.addEventListener("input", () => {
    viewerState.searchQuery = searchInput.value.trim();
    void clearCurrentBookSelection().then(() => {
      viewerState.activeDirectory = null;
      renderApp();
    });
  });

  sidebarToggleEl?.addEventListener("click", () => {
    viewerState.sidebarCollapsed = !viewerState.sidebarCollapsed;
    renderApp();
  });

  viewerSettingsToggleEl?.addEventListener("click", () => {
    viewerSettings.isSettingsOpen = !viewerSettings.isSettingsOpen;
    syncViewerSettingsUi();
  });

  const rerenderPdfJs = () => {
    syncViewerSettingsUi();
    if (lastSnapshot?.pdfRenderer === "pdfjs" && viewerState.currentBook) {
      void renderCurrentPage();
    }
  };

  viewerPageModeEl?.addEventListener("change", () => {
    viewerSettings.pageMode = viewerPageModeEl.value as ViewerSettings["pageMode"];
    rerenderPdfJs();
  });

  viewerBindingEl?.addEventListener("change", () => {
    viewerSettings.bindingDirection = viewerBindingEl.value as ViewerSettings["bindingDirection"];
    rerenderPdfJs();
  });

  viewerZoomModeEl?.addEventListener("change", () => {
    viewerSettings.zoomMode = viewerZoomModeEl.value as ViewerSettings["zoomMode"];
    rerenderPdfJs();
  });

  viewerCoverModeEl?.addEventListener("change", () => {
    viewerSettings.treatFirstPageAsCover = viewerCoverModeEl.checked;
    rerenderPdfJs();
  });

  noteToggleEl?.addEventListener("click", () => {
    noteState.isOpen = !noteState.isOpen;
    renderApp();
    if (noteState.isOpen) {
      void loadNoteForCurrentBook();
    }
  });

  noteCloseEl?.addEventListener("click", () => {
    noteState.isOpen = false;
    renderApp();
  });

  noteDragHandleEl?.addEventListener("pointerdown", (event) => {
    beginNoteDrag(event);
  });

  for (const resizeEl of noteResizeEls) {
    resizeEl.addEventListener("pointerdown", (event) => {
      const edge = resizeEl.dataset.resize;
      if (!edge) {
        return;
      }

      beginNoteResize(event, edge);
    });
  }

  window.addEventListener("pointermove", (event) => {
    updateNoteInteraction(event);
  });

  window.addEventListener("pointerup", () => {
    endNoteInteraction();
  });

  window.addEventListener("click", (event) => {
    const target = event.target as Node | null;
    if (
      viewerSettings.isSettingsOpen &&
      target &&
      !viewerSettingsPanelEl?.contains(target) &&
      !viewerSettingsToggleEl?.contains(target)
    ) {
      viewerSettings.isSettingsOpen = false;
      syncViewerSettingsUi();
    }
  });

  window.addEventListener("resize", () => {
    clampNoteWindow();
    syncNoteUi();

    if (pdfRenderResizeTimer !== null) {
      window.clearTimeout(pdfRenderResizeTimer);
    }

    if (lastSnapshot?.pdfRenderer === "pdfjs" && viewerState.currentBook) {
      pdfRenderResizeTimer = window.setTimeout(() => {
        void renderCurrentPage();
      }, 120);
    }
  });

  window.addEventListener("beforeunload", () => {
    if (noteSaveTimer !== null) {
      window.clearTimeout(noteSaveTimer);
    }
  });

  await listen<LibrarySnapshot>("library-updated", (event) => {
    lastSnapshot = event.payload;
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
