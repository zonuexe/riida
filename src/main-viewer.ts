// Entry point for the standalone viewer window (v0.6.0 work-in-progress).
//
// The viewer window currently supports a minimal PDF rendering path so the
// multi-window plumbing can be exercised end-to-end. EPUB, viewer settings,
// notes, search, spread layout, lazy paging, and reading-position
// persistence will be migrated out of src/main.ts in follow-up commits.

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import "./vendor/fontawesome/css/fontawesome.min.css";
import "./vendor/fontawesome/css/solid.min.css";
import { applyAppTheme, loadPersistedAppTheme } from "./app-theme";
import { loadEpubJs } from "./epub-runtime";
import type { NoteEditorHandle } from "./note-editor";
import {
  clampNoteWindowPosition,
  ensureNoteWindowPlacement as ensureNoteWindowPlacementForViewport,
  preserveNoteWindowBottomRightOffset,
} from "./note-window-utils";
import { detectPdfBindingDirection } from "./pdf-binding-detect";
import { loadPdfJsRuntime, TauriBinaryDataFactory } from "./pdf-runtime";
import {
  clampReadingPositionOffsetRatio,
  computePageOffsetRatio,
  loadCachedReadingPosition,
  saveCachedReadingPosition,
  selectAnchorPageIndex,
} from "./reading-position-utils";
import {
  buildPageGroups,
  getVisualPageOrder,
  type ViewerLayoutSettings,
} from "./viewer-layout-utils";

type ViewerLaunchParams = {
  filePath: string | null;
  source: string | null;
};

// The Rust open_viewer_window command injects an initialization script that
// sets this global on the new window before any other script runs. It is the
// authoritative source of spawn-time parameters; the query-string fallback is
// for tests and direct URL access during local development.
type InjectedLaunchParams = {
  filePath?: unknown;
  source?: unknown;
};

declare global {
  interface Window {
    __RIIDA_LAUNCH_PARAMS__?: InjectedLaunchParams;
  }
}

function coerceLaunchString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readLaunchParams(
  search: string,
  injected: InjectedLaunchParams | undefined = undefined,
): ViewerLaunchParams {
  if (injected) {
    return {
      filePath: coerceLaunchString(injected.filePath),
      source: coerceLaunchString(injected.source),
    };
  }
  const params = new URLSearchParams(search);
  return {
    filePath: coerceLaunchString(params.get("file")),
    source: coerceLaunchString(params.get("source")),
  };
}

function setStatus(message: string | null): void {
  const statusEl = document.querySelector<HTMLElement>("#viewer-window-status");
  const targetEl = document.querySelector<HTMLElement>("#viewer-window-target");
  if (!statusEl || !targetEl) return;
  if (message === null) {
    statusEl.hidden = true;
    targetEl.textContent = "";
    return;
  }
  statusEl.hidden = false;
  targetEl.textContent = message;
}

type PdfDocumentLike = Awaited<
  ReturnType<Awaited<ReturnType<typeof loadPdfJsRuntime>>["getDocument"]>["promise"]
>;
type PdfPage = Awaited<ReturnType<PdfDocumentLike["getPage"]>>;

// Pick a backing-buffer resolution that stays crisp when CSS upscales it to
// fit a large window. The viewer window can be maximized after the canvases
// are rendered, so we give ourselves headroom and let CSS handle the actual
// display size.
const CANVAS_RENDER_SCALE = 2.0;

async function renderPdfPageCanvas(
  page: PdfPage,
  pageNumber: number,
  devicePixelRatio: number,
): Promise<HTMLElement> {
  const viewport = page.getViewport({ scale: CANVAS_RENDER_SCALE });

  const pageEl = document.createElement("div");
  pageEl.className = "pdfjs-page";
  pageEl.dataset.pageNumber = String(pageNumber);
  // Aspect ratio drives the CSS layout in the standalone viewer window. Width
  // and height are left for CSS to compute so the page resizes with the
  // window without re-rendering the canvas.
  pageEl.style.aspectRatio = `${viewport.width} / ${viewport.height}`;

  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width * devicePixelRatio);
  canvas.height = Math.floor(viewport.height * devicePixelRatio);
  // Intentionally do not set canvas.style.width / .style.height; CSS in the
  // viewer-window scope sizes the canvas via max-height / max-width.
  pageEl.appendChild(canvas);

  const ctx = canvas.getContext("2d");
  if (ctx) {
    await page.render({
      canvas,
      canvasContext: ctx,
      viewport,
      transform:
        devicePixelRatio === 1 ? undefined : [devicePixelRatio, 0, 0, devicePixelRatio, 0, 0],
    }).promise;
  }
  return pageEl;
}

type SpreadIndexEntry = {
  spreadEl: HTMLElement;
  pageNumbers: readonly number[];
};

type RenderedPdf = {
  spreadIndex: SpreadIndexEntry[];
  bindingDirection: "left" | "right";
};

function findSpreadForPage(
  spreadIndex: readonly SpreadIndexEntry[],
  pageNumber: number,
): SpreadIndexEntry | null {
  let fallback: SpreadIndexEntry | null = null;
  for (const entry of spreadIndex) {
    if (entry.pageNumbers.includes(pageNumber)) {
      return entry;
    }
    if (entry.pageNumbers.some((p) => p > pageNumber)) {
      // pages are in document order; remember the first spread past the
      // target so we can fall back when the saved page number no longer
      // exists in the current document.
      fallback ??= entry;
    }
  }
  return fallback ?? spreadIndex[spreadIndex.length - 1] ?? null;
}

function restoreReadingPosition(
  filePath: string,
  scrollEl: HTMLElement,
  spreadIndex: readonly SpreadIndexEntry[],
): void {
  if (spreadIndex.length === 0) return;
  const cached = loadCachedReadingPosition(filePath);
  if (!cached) return;
  const target = findSpreadForPage(spreadIndex, cached.pageNumber);
  if (!target) return;
  const ratio = clampReadingPositionOffsetRatio(cached.pageOffsetRatio);
  scrollEl.scrollTop = target.spreadEl.offsetTop + ratio * target.spreadEl.offsetHeight;
}

function capturePositionFromScroll(
  filePath: string,
  scrollEl: HTMLElement,
  spreadIndex: readonly SpreadIndexEntry[],
): void {
  if (spreadIndex.length === 0) return;
  const anchorLine = scrollEl.scrollTop + 24;
  const anchorIndex = selectAnchorPageIndex(
    spreadIndex.map((entry) => entry.spreadEl.offsetTop),
    anchorLine,
  );
  const anchor = spreadIndex[anchorIndex] ?? spreadIndex[0];
  if (!anchor) return;
  // Multiple page numbers share a spread; use the smallest one so switching
  // from spread to single-page would land on the head-side page.
  const headPageNumber = anchor.pageNumbers.reduce(
    (best, candidate) => (candidate > 0 && candidate < best ? candidate : best),
    anchor.pageNumbers[0] ?? 1,
  );
  const pageOffsetRatio = computePageOffsetRatio(
    scrollEl.scrollTop,
    anchor.spreadEl.offsetTop,
    anchor.spreadEl.offsetHeight,
  );
  saveCachedReadingPosition({
    filePath,
    pageNumber: headPageNumber,
    pageOffsetRatio,
    cfi: null,
    updatedAt: Date.now(),
  });
}

function findCurrentSpreadIndex(
  scrollEl: HTMLElement,
  spreadIndex: readonly SpreadIndexEntry[],
): number {
  if (spreadIndex.length === 0) return -1;
  const anchorLine = scrollEl.scrollTop + 24;
  return selectAnchorPageIndex(
    spreadIndex.map((entry) => entry.spreadEl.offsetTop),
    anchorLine,
  );
}

function scrollToSpread(
  scrollEl: HTMLElement,
  spreadIndex: readonly SpreadIndexEntry[],
  index: number,
): void {
  const clamped = Math.max(0, Math.min(index, spreadIndex.length - 1));
  const target = spreadIndex[clamped];
  if (!target) return;
  scrollEl.scrollTo({ top: target.spreadEl.offsetTop, behavior: "smooth" });
}

function installSpreadKeyboardNavigation(
  scrollEl: HTMLElement,
  spreadIndex: readonly SpreadIndexEntry[],
  bindingDirection: "left" | "right",
): void {
  if (spreadIndex.length === 0) return;
  // For right-bound (typically Japanese tategaki) books, the reader advances
  // toward the left of the spread, so horizontal arrow semantics flip.
  const horizontalNext = bindingDirection === "right" ? "ArrowLeft" : "ArrowRight";
  const horizontalPrev = bindingDirection === "right" ? "ArrowRight" : "ArrowLeft";
  window.addEventListener("keydown", (event) => {
    if (event.defaultPrevented) return;
    // Let the OS / browser handle Cmd-, Ctrl-, and Alt-combinations
    // (Spotlight on Cmd+Space, window cycling on Cmd+`, etc.) so we never
    // accidentally swallow a system shortcut. Shift is allowed because
    // Shift+Space is our own "previous spread" binding.
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    if (target && (target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName))) {
      return;
    }
    const isNext =
      event.key === "PageDown" ||
      (event.key === " " && !event.shiftKey) ||
      event.key === "ArrowDown" ||
      event.key === horizontalNext;
    const isPrev =
      event.key === "PageUp" ||
      (event.key === " " && event.shiftKey) ||
      event.key === "ArrowUp" ||
      event.key === horizontalPrev;
    const isHome = event.key === "Home";
    const isEnd = event.key === "End";
    if (!isNext && !isPrev && !isHome && !isEnd) return;
    event.preventDefault();
    const current = findCurrentSpreadIndex(scrollEl, spreadIndex);
    if (isHome) {
      scrollToSpread(scrollEl, spreadIndex, 0);
    } else if (isEnd) {
      scrollToSpread(scrollEl, spreadIndex, spreadIndex.length - 1);
    } else if (isNext) {
      scrollToSpread(scrollEl, spreadIndex, current + 1);
    } else {
      scrollToSpread(scrollEl, spreadIndex, current - 1);
    }
  });
}

function installReadingPositionPersistence(
  filePath: string,
  scrollEl: HTMLElement,
  spreadIndex: readonly SpreadIndexEntry[],
): void {
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const SAVE_DEBOUNCE_MS = 600;

  const scheduleSave = () => {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      capturePositionFromScroll(filePath, scrollEl, spreadIndex);
    }, SAVE_DEBOUNCE_MS);
  };

  scrollEl.addEventListener("scroll", scheduleSave, { passive: true });
  window.addEventListener("beforeunload", () => {
    if (saveTimer !== null) clearTimeout(saveTimer);
    capturePositionFromScroll(filePath, scrollEl, spreadIndex);
  });
}

// Minimal renderer: detect binding direction, build spread groups, and render
// every page at a fixed high-resolution backing buffer. CSS in the viewer-
// window scope handles the visible sizing via 100vh-based fit-height, so the
// canvases stay sharp when the window is resized. Lazy paging, text layers,
// search, and per-file viewer settings will follow.
async function renderPdfAllPages(filePath: string, viewerEl: HTMLElement): Promise<RenderedPdf> {
  const sourceUrl = convertFileSrc(filePath);
  const { getDocument } = await loadPdfJsRuntime();

  const documentTask = getDocument({
    url: sourceUrl,
    cMapUrl: "/pdfjs/cmaps/node_modules/pdfjs-dist/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/node_modules/pdfjs-dist/standard_fonts/",
    useSystemFonts: true,
    disableFontFace: false,
    BinaryDataFactory: TauriBinaryDataFactory,
    useWorkerFetch: false,
  });
  const pdfDocument = await documentTask.promise;

  const detectedBinding = (await detectPdfBindingDirection(pdfDocument, () => false)) ?? "left";

  const layoutSettings: ViewerLayoutSettings = {
    pageMode: "spread",
    bindingDirection: detectedBinding,
    treatFirstPageAsCover: true,
  };
  const pageGroups = buildPageGroups(pdfDocument.numPages, layoutSettings);

  viewerEl.innerHTML = "";
  viewerEl.dataset.filePath = filePath;
  viewerEl.hidden = false;

  const devicePixelRatio = window.devicePixelRatio || 1;
  const spreadIndex: SpreadIndexEntry[] = [];

  for (const group of pageGroups) {
    const visualOrder = getVisualPageOrder(group, layoutSettings);
    const spreadEl = document.createElement("div");
    spreadEl.className = "pdfjs-spread";
    spreadEl.dataset.pageCount = String(visualOrder.length);
    spreadEl.dataset.binding = detectedBinding;
    if (visualOrder.length === 1 && visualOrder[0] === 1) {
      spreadEl.dataset.cover = "true";
    }
    viewerEl.appendChild(spreadEl);

    for (const pageNumber of visualOrder) {
      const page = await pdfDocument.getPage(pageNumber);
      const pageEl = await renderPdfPageCanvas(page, pageNumber, devicePixelRatio);
      spreadEl.appendChild(pageEl);
    }

    // Record pages in document order so callers can match a saved page number
    // without caring about left/right binding.
    spreadIndex.push({ spreadEl, pageNumbers: [...group] });
  }
  return { spreadIndex, bindingDirection: detectedBinding };
}

type EpubRenderResult = {
  rendition: import("epubjs").Rendition;
  isRtl: boolean;
};

function looksLikeEpubPath(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(".epub");
}

async function renderEpubBook(filePath: string, viewerEl: HTMLElement): Promise<EpubRenderResult> {
  const sourceUrl = convertFileSrc(filePath);
  const EpubModule = await loadEpubJs();
  const Epub = EpubModule.default;
  const book = Epub(sourceUrl);
  await book.ready;

  // DPFJ guide §ページ進行方向の遵守: progression direction comes from the OPF
  // spine, not from writing-mode. In rtl books (typically Japanese tategaki)
  // ArrowLeft is "next" and ArrowRight is "previous".
  const bookInternal = book as unknown as {
    spine?: { direction?: string };
    package?: { metadata?: { direction?: string } };
  };
  const spineDirection =
    bookInternal.spine?.direction ?? bookInternal.package?.metadata?.direction ?? "ltr";
  const isRtl = spineDirection === "rtl";

  viewerEl.innerHTML = "";
  viewerEl.dataset.filePath = filePath;
  viewerEl.hidden = false;

  const rendition = book.renderTo(viewerEl, {
    width: "100%",
    height: "100%",
    spread: "auto",
    flow: "paginated",
    allowScriptedContent: true,
  });

  const cached = loadCachedReadingPosition(filePath);
  const restoreCfi = cached?.cfi ?? undefined;
  await rendition.display(restoreCfi);

  // WKWebView occasionally renders the first display at zero dimensions when
  // the iframe attaches before layout has settled. epub.js only re-displays
  // automatically when rendition.location is set; force a redisplay if that
  // window opens at 0x0.
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
  const iframeEl = viewerEl.querySelector<HTMLIFrameElement>("iframe");
  if (!iframeEl || iframeEl.clientWidth === 0 || iframeEl.clientHeight === 0) {
    try {
      await rendition.display(restoreCfi);
    } catch (err) {
      console.warn("[riida] epub redisplay after resize failed:", err);
    }
  }

  rendition.on("relocated", (location: import("epubjs").Location) => {
    const cfi = location.start.cfi;
    if (!cfi) return;
    // Reuse the shared reading-position cache. pageNumber and offsetRatio are
    // unused for EPUB restore (the cfi field drives navigation), but the
    // schema requires them.
    saveCachedReadingPosition({
      filePath,
      pageNumber: 1,
      pageOffsetRatio: 0,
      cfi,
      updatedAt: Date.now(),
    });
  });

  return { rendition, isRtl };
}

function installEpubKeyboardNavigation(
  rendition: import("epubjs").Rendition,
  isRtl: boolean,
): void {
  const horizontalNext = isRtl ? "ArrowLeft" : "ArrowRight";
  const horizontalPrev = isRtl ? "ArrowRight" : "ArrowLeft";
  window.addEventListener("keydown", (event) => {
    if (event.defaultPrevented) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    if (target && (target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName))) {
      return;
    }
    const isNext =
      event.key === "PageDown" ||
      (event.key === " " && !event.shiftKey) ||
      event.key === "ArrowDown" ||
      event.key === horizontalNext;
    const isPrev =
      event.key === "PageUp" ||
      (event.key === " " && event.shiftKey) ||
      event.key === "ArrowUp" ||
      event.key === horizontalPrev;
    if (!isNext && !isPrev) return;
    event.preventDefault();
    if (isNext) {
      void rendition.next();
    } else {
      void rendition.prev();
    }
  });
}

type NoteDocument = {
  filePath: string;
  format: string;
  content: string;
  updatedAt: number | null;
};

type NoteState = {
  isOpen: boolean;
  isLoading: boolean;
  activeFilePath: string | null;
  currentContent: string;
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

const NOTE_MIN_WIDTH = 280;
const NOTE_MIN_HEIGHT = 220;
const NOTE_SAVE_DEBOUNCE_MS = 800;

const noteState: NoteState = {
  isOpen: false,
  isLoading: false,
  activeFilePath: null,
  currentContent: "",
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

let noteEditor: NoteEditorHandle | null = null;
let noteEditorModulePromise: Promise<typeof import("./note-editor")> | null = null;
let noteSaveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingNoteSave: { filePath: string; content: string } | null = null;
let activeBookFilePath: string | null = null;
let lastNoteViewport: { width: number; height: number } | null = null;

async function loadNoteEditorModule() {
  noteEditorModulePromise ??= import("./note-editor");
  return noteEditorModulePromise;
}

function clampNoteWindow(): void {
  const next = clampNoteWindowPosition(noteState, {
    width: window.innerWidth,
    height: window.innerHeight,
  });
  noteState.x = next.x;
  noteState.y = next.y;
}

function ensureNoteWindowPlacement(): void {
  const next = ensureNoteWindowPlacementForViewport(noteState, {
    width: window.innerWidth,
    height: window.innerHeight,
  });
  noteState.x = next.x;
  noteState.y = next.y;
}

function syncNoteUi(): void {
  const noteToggleEl = document.querySelector<HTMLButtonElement>("#note-toggle");
  const notePanelEl = document.querySelector<HTMLElement>("#note-panel");
  const hasBook = activeBookFilePath !== null;

  if (noteToggleEl) {
    noteToggleEl.hidden = !hasBook || noteState.isOpen;
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
}

async function saveNoteNow(): Promise<void> {
  if (!pendingNoteSave) return;
  const payload = pendingNoteSave;
  pendingNoteSave = null;
  try {
    await invoke<NoteDocument>("save_note", {
      filePath: payload.filePath,
      content: payload.content,
    });
  } catch (error) {
    console.error("[riida] failed to save note:", error);
  }
}

function scheduleNoteSave(markdown: string): void {
  if (!noteState.activeFilePath) return;
  noteState.currentContent = markdown;
  pendingNoteSave = { filePath: noteState.activeFilePath, content: markdown };
  if (noteSaveTimer !== null) {
    clearTimeout(noteSaveTimer);
  }
  noteSaveTimer = setTimeout(() => {
    noteSaveTimer = null;
    void saveNoteNow();
  }, NOTE_SAVE_DEBOUNCE_MS);
}

async function flushPendingNoteSave(): Promise<void> {
  if (noteSaveTimer !== null) {
    clearTimeout(noteSaveTimer);
    noteSaveTimer = null;
  }
  await saveNoteNow();
}

async function destroyNoteEditor(): Promise<void> {
  if (!noteEditor) return;
  const editor = noteEditor;
  noteEditor = null;
  try {
    await editor.destroy();
  } catch (error) {
    console.warn("[riida] failed to destroy note editor:", error);
  }
}

async function loadNoteForBook(filePath: string): Promise<void> {
  const noteRootEl = document.querySelector<HTMLElement>("#note-editor");
  if (!noteRootEl) return;
  if (noteState.activeFilePath === filePath && noteEditor) return;

  await flushPendingNoteSave();
  await destroyNoteEditor();

  noteState.isLoading = true;
  noteState.activeFilePath = filePath;
  noteState.currentContent = "";
  syncNoteUi();

  try {
    const note = await invoke<NoteDocument>("load_note", { filePath });
    noteState.activeFilePath = note.filePath;
    noteState.currentContent = note.content;

    const { mountNoteEditor } = await loadNoteEditorModule();
    noteEditor = await mountNoteEditor({
      root: noteRootEl,
      initialMarkdown: note.content,
      onMarkdownChange: (markdown) => {
        scheduleNoteSave(markdown);
      },
    });
  } catch (error) {
    console.error("[riida] failed to load note:", error);
  } finally {
    noteState.isLoading = false;
    syncNoteUi();
  }
}

function beginNoteDrag(event: PointerEvent): void {
  const target = event.target as HTMLElement | null;
  if (!target || target.closest("#note-close")) return;
  event.preventDefault();
  ensureNoteWindowPlacement();
  noteInteractionState.mode = "drag";
  noteInteractionState.edge = null;
  noteInteractionState.startX = event.clientX;
  noteInteractionState.startY = event.clientY;
  noteInteractionState.startLeft = noteState.x ?? 0;
  noteInteractionState.startTop = noteState.y ?? 0;
}

function beginNoteResize(event: PointerEvent, edge: string): void {
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

function updateNoteInteraction(event: PointerEvent): void {
  if (!noteInteractionState.mode) return;
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
    nextWidth = Math.max(NOTE_MIN_WIDTH, noteInteractionState.startWidth + dx);
  }
  if (edge.includes("s")) {
    nextHeight = Math.max(NOTE_MIN_HEIGHT, noteInteractionState.startHeight + dy);
  }
  if (edge.includes("w")) {
    nextWidth = Math.max(NOTE_MIN_WIDTH, noteInteractionState.startWidth - dx);
    nextLeft = noteInteractionState.startLeft + dx;
    if (nextWidth === NOTE_MIN_WIDTH) {
      nextLeft =
        noteInteractionState.startLeft + (noteInteractionState.startWidth - NOTE_MIN_WIDTH);
    }
  }
  if (edge.includes("n")) {
    nextHeight = Math.max(NOTE_MIN_HEIGHT, noteInteractionState.startHeight - dy);
    nextTop = noteInteractionState.startTop + dy;
    if (nextHeight === NOTE_MIN_HEIGHT) {
      nextTop =
        noteInteractionState.startTop + (noteInteractionState.startHeight - NOTE_MIN_HEIGHT);
    }
  }

  noteState.width = Math.min(nextWidth, window.innerWidth - 24);
  noteState.height = Math.min(nextHeight, window.innerHeight - 24);
  noteState.x = nextLeft;
  noteState.y = nextTop;
  clampNoteWindow();
  syncNoteUi();
}

function endNoteInteraction(): void {
  noteInteractionState.mode = null;
  noteInteractionState.edge = null;
}

function attachNotePanelInteractions(): void {
  const noteToggleEl = document.querySelector<HTMLButtonElement>("#note-toggle");
  const noteCloseEl = document.querySelector<HTMLButtonElement>("#note-close");
  const noteDragHandleEl = document.querySelector<HTMLElement>("#note-drag-handle");
  const notePanelEl = document.querySelector<HTMLElement>("#note-panel");

  noteToggleEl?.addEventListener("click", () => {
    if (!activeBookFilePath) return;
    noteState.isOpen = true;
    ensureNoteWindowPlacement();
    syncNoteUi();
    void loadNoteForBook(activeBookFilePath);
  });

  noteCloseEl?.addEventListener("click", () => {
    noteState.isOpen = false;
    void flushPendingNoteSave();
    syncNoteUi();
  });

  noteDragHandleEl?.addEventListener("pointerdown", (event) => {
    beginNoteDrag(event);
  });

  notePanelEl?.querySelectorAll<HTMLElement>(".note-resize-handle").forEach((handleEl) => {
    handleEl.addEventListener("pointerdown", (event) => {
      const edge = handleEl.dataset.resize ?? "";
      if (!edge) return;
      beginNoteResize(event, edge);
    });
  });

  window.addEventListener("pointermove", (event) => {
    updateNoteInteraction(event);
  });

  window.addEventListener("pointerup", () => {
    endNoteInteraction();
  });

  lastNoteViewport = { width: window.innerWidth, height: window.innerHeight };
  window.addEventListener("resize", () => {
    const next = { width: window.innerWidth, height: window.innerHeight };
    if (lastNoteViewport) {
      const moved = preserveNoteWindowBottomRightOffset(noteState, lastNoteViewport, next);
      noteState.x = moved.x;
      noteState.y = moved.y;
    }
    lastNoteViewport = next;
    clampNoteWindow();
    syncNoteUi();
  });

  window.addEventListener("beforeunload", () => {
    void flushPendingNoteSave();
  });
}

async function boot(): Promise<void> {
  const cachedTheme = loadPersistedAppTheme();
  if (cachedTheme) {
    applyAppTheme(cachedTheme);
  }

  const { filePath, source } = readLaunchParams(
    window.location.search,
    window.__RIIDA_LAUNCH_PARAMS__,
  );

  document.body.dataset.startup = "ready";

  if (!filePath) {
    setStatus("No file specified.");
    return;
  }

  setStatus(`Loading ${source ? `${filePath} (source: ${source})` : filePath}...`);

  const scrollEl = document.querySelector<HTMLElement>("#main-pane");
  if (!scrollEl) {
    setStatus("Viewer container is missing from the document.");
    return;
  }

  attachNotePanelInteractions();

  if (looksLikeEpubPath(filePath)) {
    const epubViewerEl = document.querySelector<HTMLElement>("#epub-viewer");
    if (!epubViewerEl) {
      setStatus("EPUB viewer container is missing from the document.");
      return;
    }
    try {
      const { rendition, isRtl } = await renderEpubBook(filePath, epubViewerEl);
      setStatus(null);
      installEpubKeyboardNavigation(rendition, isRtl);
      activeBookFilePath = filePath;
      syncNoteUi();
    } catch (error) {
      console.error("[riida] viewer window: failed to render EPUB:", error);
      setStatus(`Failed to render EPUB: ${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }

  const viewerEl = document.querySelector<HTMLElement>("#pdfjs-viewer");
  if (!viewerEl) {
    setStatus("Viewer container is missing from the document.");
    return;
  }

  try {
    const { spreadIndex, bindingDirection } = await renderPdfAllPages(filePath, viewerEl);
    setStatus(null);
    restoreReadingPosition(filePath, scrollEl, spreadIndex);
    installReadingPositionPersistence(filePath, scrollEl, spreadIndex);
    installSpreadKeyboardNavigation(scrollEl, spreadIndex, bindingDirection);
    activeBookFilePath = filePath;
    syncNoteUi();
  } catch (error) {
    console.error("[riida] viewer window: failed to render PDF:", error);
    setStatus(`Failed to render PDF: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => void boot(), { once: true });
  } else {
    void boot();
  }
}

export const __testables = { readLaunchParams };
