import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getName, getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { homeDir } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import "./vendor/fontawesome/css/fontawesome.min.css";
import "./vendor/fontawesome/css/brands.min.css";
import "./vendor/fontawesome/css/solid.min.css";
import type { NoteEditorHandle } from "./note-editor";
import { addLibraryRoot, buildAppConfigDraft } from "./app-config-utils";
import {
  applyBookMetadataImport,
  BOOK_METADATA_IMPORT_EXAMPLE,
  joinMetadataAuthors,
  normalizeMetadataAuthorsText,
  parseBookMetadataImport,
  validateBookMetadataDraft,
} from "./book-metadata-utils";
import {
  deriveDirectories,
  deriveTags,
  filterVisibleBooks,
  formatBookLocation,
  formatFileSize,
  type DirectoryNode,
} from "./library-utils";
import { buildNavigationUrl, navigationStateSignature } from "./navigation-utils";
import { isNavigationBackShortcut, isNavigationForwardShortcut } from "./navigation-shortcuts";
import { suggestTagCompletions } from "./tag-suggestions";
import { validateTagValue } from "./tag-utils";
import {
  clampReadingPositionOffsetRatio,
  parseCachedReadingPosition,
  readingPositionStorageKey,
} from "./reading-position-utils";
import { parseRequestedPageNumber } from "./page-jump-utils";
import { resolvePdfLinkTarget, type PdfAnnotationRecord } from "./pdf-link-utils";
import {
  clampNoteWindowPosition,
  ensureNoteWindowPlacement as ensureNoteWindowPlacementForViewport,
  preserveNoteWindowBottomRightOffset,
} from "./note-window-utils";
import { buildPageGroups, getVisualPageOrder } from "./viewer-layout-utils";
import { buildPdfRenderWindowPlan } from "./pdf-render-window-utils";
import {
  applyViewerSettingsPayloadToState,
  switchViewerSettingsScopeInState,
} from "./viewer-settings-utils";

type BookSummary = {
  fileName: string;
  filePath: string;
  fileSize: number;
  tags: string[];
  authors: string[];
  sourceType: "pdf" | "kindle";
  coverUrl: string | null;
  locationLabel: string | null;
  isOpenable: boolean;
};

type LibrarySnapshot = {
  libraryRoots: string[];
  existingLibraryRoots: string[];
  missingLibraryRoots: string[];
  indexedCount: number;
  books: BookSummary[];
  excludedPatterns: string[];
  pdfRenderer: "native" | "pdfjs";
};

type NoteDocument = {
  filePath: string;
  format: string;
  content: string;
  updatedAt: number | null;
};

type BookMetadataPayload = {
  filePath: string;
  title: string;
  authors: string[];
  description: string;
  publisher: string;
  releaseDate: string;
  language: string;
  url: string;
  asin: string;
  coverUrl: string;
  updatedAt: number | null;
};

type ReadingPosition = {
  filePath: string;
  pageNumber: number;
  pageOffsetRatio: number;
  updatedAt: number | null;
};

type ViewerState = {
  books: BookSummary[];
  currentBook: BookSummary | null;
  activeDirectory: string | null;
  activeTag: string | null;
  activeExternalSource: string | null;
  activeTagDirectOnly: boolean;
  searchQuery: string;
  expandedDirectories: Set<string>;
  expandedTags: Set<string>;
  sidebarCollapsed: boolean;
  isAppSettingsOpen: boolean;
  isAboutOpen: boolean;
  libraryErrorMessage: string | null;
};

type AppConfigPayload = {
  configPath: string;
  configExists: boolean;
  libraryRoots: string[];
  excludedPatterns: string[];
  pdfRenderer: "native" | "pdfjs";
};

type ViewerSettings = {
  pageMode: "single" | "spread";
  bindingDirection: "left" | "right";
  zoomMode: "fit-width" | "fit-height" | "original";
  alignMode: "left" | "center" | "right";
  verticalGapMode: "wide" | "compact" | "none";
  treatFirstPageAsCover: boolean;
};

type ViewerSettingsPayload = {
  global: ViewerSettings;
  file: ViewerSettings | null;
  effective: ViewerSettings;
  usesFileOverride: boolean;
};

type ViewerSettingsScope = "global" | "file";

type ViewerSettingsState = ViewerSettings & {
  globalDraft: ViewerSettings;
  fileDraft: ViewerSettings;
  scope: ViewerSettingsScope;
  hasFileOverride: boolean;
  isSettingsOpen: boolean;
};

type NavigationState = {
  historyIndex: number;
  bookFilePath: string | null;
  activeDirectory: string | null;
  activeTag: string | null;
  activeExternalSource: string | null;
  activeTagDirectOnly: boolean;
  searchQuery: string;
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

type BookTagsPayload = {
  filePath: string;
  tags: string[];
};

type TagEditorState = {
  isOpen: boolean;
  filePath: string | null;
  bookTitle: string;
  tags: string[];
  input: string;
  statusMessage: string;
};

type BookMetadataEditorState = {
  isOpen: boolean;
  filePath: string | null;
  bookTitle: string;
  sourceType: "pdf" | "kindle";
  title: string;
  authorsText: string;
  description: string;
  publisher: string;
  releaseDate: string;
  language: string;
  url: string;
  asin: string;
  coverUrl: string;
  importText: string;
  statusMessage: string;
  loadToken: number;
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

type ViewerPageJumpState = {
  input: string;
};

type PdfRenderPlan = {
  groupIndex: number;
  visualOrder: number[];
  spreadEl: HTMLElement;
  pageSlots: Map<number, HTMLElement>;
  baseScale: number;
};

type PdfRenderSession = {
  token: number;
  pdfDocument: {
    numPages: number;
    getPage: (pageNumber: number) => Promise<any>;
    getDestination?: (destinationId: string) => Promise<unknown>;
    getPageIndex?: (pageRef: any) => Promise<number>;
  };
  viewerEl: HTMLElement;
  stageEl: HTMLElement;
  plans: PdfRenderPlan[];
  restoreTargetPage: number | null;
  updateScheduled: boolean;
  isUpdating: boolean;
  pendingFocusGroupIndex: number | null;
};

type PdfJsRuntime = {
  TextLayer: typeof import("pdfjs-dist").TextLayer;
  getDocument: typeof import("pdfjs-dist").getDocument;
};

const viewerState: ViewerState = {
  books: [],
  currentBook: null,
  activeDirectory: null,
  activeTag: null,
  activeExternalSource: null,
  activeTagDirectOnly: false,
  searchQuery: "",
  expandedDirectories: new Set<string>(),
  expandedTags: new Set<string>(),
  sidebarCollapsed: false,
  isAppSettingsOpen: false,
  isAboutOpen: false,
  libraryErrorMessage: null,
};

const DEFAULT_VIEWER_SETTINGS: ViewerSettings = {
  pageMode: "spread",
  bindingDirection: "left",
  zoomMode: "fit-height",
  alignMode: "center",
  verticalGapMode: "compact",
  treatFirstPageAsCover: true,
};

const viewerSettings: ViewerSettingsState = {
  ...DEFAULT_VIEWER_SETTINGS,
  globalDraft: { ...DEFAULT_VIEWER_SETTINGS },
  fileDraft: { ...DEFAULT_VIEWER_SETTINGS },
  scope: "file",
  hasFileOverride: false,
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
let activePdfRenderSession: PdfRenderSession | null = null;
let viewerSettingsLoadToken = 0;
let readingPositionSaveTimer: number | null = null;
let suppressHistoryUpdates = false;
let navigationHistoryIndex = 0;
let navigationHistoryMax = 0;
let navigationEntries: NavigationState[] = [];
let activeReadingPosition: ReadingPosition | null = null;
let lastAppConfig: AppConfigPayload | null = null;
let cachedHomeDir: string | null = null;
let cachedAppName = "riida";
let cachedAppVersion = "0.1.1";
const buildDate = __BUILD_DATE__;
let cachedLicenseText = "Loading license text...";
let cachedThirdPartyRustText = "Loading Rust notices...";
let cachedThirdPartyJsText = "Loading JavaScript notices...";
let isTagEditorComposing = false;
let pdfJsRuntimePromise: Promise<PdfJsRuntime> | null = null;
let noteEditorModulePromise: Promise<typeof import("./note-editor")> | null = null;
const viewerPageJumpState: ViewerPageJumpState = {
  input: "",
};
const tagEditorState: TagEditorState = {
  isOpen: false,
  filePath: null,
  bookTitle: "",
  tags: [],
  input: "",
  statusMessage: "",
};
const bookMetadataEditorState: BookMetadataEditorState = {
  isOpen: false,
  filePath: null,
  bookTitle: "",
  sourceType: "pdf",
  title: "",
  authorsText: "",
  description: "",
  publisher: "",
  releaseDate: "",
  language: "",
  url: "",
  asin: "",
  coverUrl: "",
  importText: "",
  statusMessage: "",
  loadToken: 0,
};
const PDF_RENDER_RADIUS = 2;
const PDF_KEEP_RADIUS = 3;
let lastViewportSize = {
  width: window.innerWidth,
  height: window.innerHeight,
};

async function collapseHomePath(path: string) {
  if (!cachedHomeDir) {
    try {
      cachedHomeDir = (await homeDir()).replace(/\/+$/, "");
    } catch {
      cachedHomeDir = "";
    }
  }

  if (!cachedHomeDir) {
    return path;
  }

  if (path === cachedHomeDir) {
    return "~";
  }

  if (path.startsWith(`${cachedHomeDir}/`)) {
    return `~/${path.slice(cachedHomeDir.length + 1)}`;
  }

  return path;
}

async function primeHomeDirCache() {
  if (cachedHomeDir !== null) {
    return;
  }

  try {
    cachedHomeDir = (await homeDir()).replace(/\/+$/, "");
  } catch {
    cachedHomeDir = "";
  }
}

async function loadPdfJsRuntime() {
  pdfJsRuntimePromise ??= Promise.all([
    import("pdfjs-dist/build/pdf.min.mjs"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]).then(([runtime, workerModule]) => {
    runtime.GlobalWorkerOptions.workerSrc = workerModule.default;

    return {
      TextLayer: runtime.TextLayer,
      getDocument: runtime.getDocument,
    };
  });

  return pdfJsRuntimePromise;
}

async function loadNoteEditorModule() {
  noteEditorModulePromise ??= import("./note-editor");
  return noteEditorModulePromise;
}

const noteState: NoteState = {
  isOpen: false,
  isLoading: false,
  isSaving: false,
  activeFilePath: null,
  currentContent: "",
  savedContent: "",
  statusMessage: "Notes are saved automatically.",
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

function ensureExpandedPath(path: string | null) {
  if (!path) {
    return;
  }

  let currentPath = path;
  while (true) {
    const separator = currentPath.lastIndexOf("/");
    if (separator <= 0) {
      break;
    }

    currentPath = currentPath.slice(0, separator);
    viewerState.expandedDirectories.add(currentPath);
  }
}

function isNodeVisible(node: DirectoryNode) {
  if (node.depth === 0) {
    return true;
  }

  return node.parentPath ? viewerState.expandedDirectories.has(node.parentPath) : true;
}

function parentTagId(tagId: string) {
  const separator = tagId.lastIndexOf("/");
  return separator >= 0 ? tagId.slice(0, separator) : null;
}

function ensureExpandedTag(tagId: string | null) {
  if (!tagId) {
    return;
  }

  let currentTag = tagId;
  while (true) {
    const parent = parentTagId(currentTag);
    if (!parent) {
      break;
    }

    viewerState.expandedTags.add(parent);
    currentTag = parent;
  }
}

function isTagVisible(tagId: string, depth: number) {
  if (depth === 0) {
    return true;
  }

  const parent = parentTagId(tagId);
  return parent ? viewerState.expandedTags.has(parent) : true;
}

function findPdfRenderGroupIndexForPage(session: PdfRenderSession, pageNumber: number) {
  return session.plans.findIndex((plan) => plan.pageSlots.has(pageNumber));
}

function currentViewerPageNumber() {
  if (!viewerState.currentBook) {
    return null;
  }

  return activeReadingPosition?.pageNumber ?? 1;
}

function syncViewerPageJumpUi() {
  const pageJumpEl = document.querySelector<HTMLElement>("#viewer-page-jump");
  const formEl = document.querySelector<HTMLFormElement>("#viewer-page-jump-form");
  const inputEl = document.querySelector<HTMLInputElement>("#viewer-page-jump-input");
  const currentPageNumber = currentViewerPageNumber();

  if (!pageJumpEl || !formEl || !inputEl) {
    return;
  }

  const shouldShow = Boolean(viewerState.currentBook);
  pageJumpEl.hidden = !shouldShow;
  formEl.hidden = !shouldShow;

  if (!shouldShow || currentPageNumber === null) {
    return;
  }

  if (document.activeElement !== inputEl) {
    viewerPageJumpState.input = String(currentPageNumber);
    inputEl.value = viewerPageJumpState.input;
  } else if (inputEl.value !== viewerPageJumpState.input) {
    inputEl.value = viewerPageJumpState.input;
  }
}

function navigateViewerToPage(pageNumber: number) {
  const currentBook = viewerState.currentBook;

  if (!currentBook) {
    return;
  }

  const maxPageNumber = activePdfRenderSession?.pdfDocument.numPages ?? Number.POSITIVE_INFINITY;
  const boundedPageNumber = Math.min(Math.max(Math.trunc(pageNumber), 1), maxPageNumber);
  activeReadingPosition = {
    filePath: currentBook.filePath,
    pageNumber: boundedPageNumber,
    pageOffsetRatio: 0,
    updatedAt: activeReadingPosition?.updatedAt ?? null,
  };
  cacheReadingPosition(activeReadingPosition);
  syncViewerPageJumpUi();

  if (lastSnapshot?.pdfRenderer === "pdfjs" && activePdfRenderSession) {
    activePdfRenderSession.restoreTargetPage = boundedPageNumber;
    const groupIndex = findPdfRenderGroupIndexForPage(activePdfRenderSession, boundedPageNumber);
    schedulePdfRenderWindowUpdate(activePdfRenderSession, groupIndex >= 0 ? groupIndex : undefined);
    scheduleReadingPositionRestore();
  } else {
    const frame = document.querySelector<HTMLIFrameElement>("#pdf-frame");
    if (frame) {
      const sourceUrl = convertFileSrc(currentBook.filePath);
      frame.src = `${sourceUrl}#page=${boundedPageNumber}`;
      frame.dataset.filePath = currentBook.filePath;
      frame.hidden = false;
    }
  }

  void flushReadingPositionSave();
}

async function renderPdfJsLinks(
  container: HTMLElement,
  viewport: { convertToViewportRectangle: (rect: number[]) => number[] },
  annotations: PdfAnnotationRecord[],
  session: PdfRenderSession,
  currentPageNumber: number,
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
    const target = await resolvePdfLinkTarget(annotation, currentPageNumber, session.pdfDocument);

    if (target?.type === "external") {
      linkEl.href = target.url;
      linkEl.target = "_blank";
      linkEl.rel = "noreferrer noopener";
      linkEl.title = target.url;
    } else if (target?.type === "internal") {
      linkEl.href = `#page=${target.pageNumber}`;
      linkEl.title = `Go to page ${target.pageNumber}`;
      linkEl.addEventListener("click", (event) => {
        event.preventDefault();
        navigateViewerToPage(target.pageNumber);
      });
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

function releasePdfRenderPlan(plan: PdfRenderPlan) {
  for (const pageEl of plan.pageSlots.values()) {
    if (pageEl.dataset.rendered !== "true") {
      continue;
    }

    pageEl.innerHTML = "";
    pageEl.dataset.rendered = "false";
  }
}

function currentVisiblePdfGroupIndex(session: PdfRenderSession) {
  const anchor = session.stageEl.scrollTop + session.stageEl.clientHeight * 0.35;
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const plan of session.plans) {
    const distance = Math.abs(plan.spreadEl.offsetTop - anchor);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = plan.groupIndex;
    }
  }

  return bestIndex;
}

async function renderPdfRenderPlan(session: PdfRenderSession, plan: PdfRenderPlan) {
  const { TextLayer } = await loadPdfJsRuntime();

  for (const pageNumber of plan.visualOrder) {
    if (session.token !== pdfRenderToken) {
      return;
    }

    const pageEl = plan.pageSlots.get(pageNumber);
    if (!pageEl || pageEl.dataset.rendered === "true") {
      continue;
    }

    const page = await session.pdfDocument.getPage(pageNumber);
    const viewport = page.getViewport({ scale: plan.baseScale });
    pageEl.style.width = `${viewport.width}px`;
    pageEl.style.height = `${viewport.height}px`;
    pageEl.innerHTML = "";

    const canvasWrapperEl = document.createElement("div");
    canvasWrapperEl.className = "canvasWrapper";
    const canvas = document.createElement("canvas");
    const outputScale = Math.max(window.devicePixelRatio || 1, 1);
    canvas.width = Math.ceil(viewport.width * outputScale);
    canvas.height = Math.ceil(viewport.height * outputScale);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    canvasWrapperEl.appendChild(canvas);
    pageEl.appendChild(canvasWrapperEl);

    const textLayerEl = document.createElement("div");
    textLayerEl.className = "textLayer";
    pageEl.appendChild(textLayerEl);

    const linkLayerEl = document.createElement("div");
    linkLayerEl.className = "annotationLayer";
    pageEl.appendChild(linkLayerEl);

    const context = canvas.getContext("2d");
    if (!context) {
      continue;
    }

    await page.render({
      canvas,
      canvasContext: context,
      transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
      viewport,
    }).promise;

    const textLayer = new TextLayer({
      textContentSource: page.streamTextContent(),
      container: textLayerEl,
      viewport,
    });
    await textLayer.render();

    const annotations = await page.getAnnotations();
    await renderPdfJsLinks(
      linkLayerEl,
      viewport,
      annotations as PdfAnnotationRecord[],
      session,
      pageNumber,
    );
    pageEl.dataset.rendered = "true";

    if (session.restoreTargetPage === pageNumber) {
      scheduleReadingPositionRestore();
    }
  }
}

async function updatePdfRenderWindow(session: PdfRenderSession, focusGroupIndex?: number) {
  if (session.token !== pdfRenderToken) {
    return;
  }

  if (session.isUpdating) {
    session.pendingFocusGroupIndex = focusGroupIndex ?? currentVisiblePdfGroupIndex(session);
    return;
  }

  session.isUpdating = true;

  try {
    const activeGroupIndex = focusGroupIndex ?? currentVisiblePdfGroupIndex(session);
    const planWindow = buildPdfRenderWindowPlan(
      session.plans.length,
      activeGroupIndex,
      PDF_RENDER_RADIUS,
      PDF_KEEP_RADIUS,
    );

    for (const plan of session.plans) {
      if (plan.groupIndex < planWindow.keepMin || plan.groupIndex > planWindow.keepMax) {
        releasePdfRenderPlan(plan);
      }
    }

    for (const index of planWindow.renderOrder) {
      const plan = session.plans[index];
      if (!plan) {
        continue;
      }

      await renderPdfRenderPlan(session, plan);

      if (session.token !== pdfRenderToken) {
        return;
      }
    }
  } finally {
    session.isUpdating = false;
  }

  if (session.pendingFocusGroupIndex !== null) {
    const nextFocusGroupIndex = session.pendingFocusGroupIndex;
    session.pendingFocusGroupIndex = null;
    void updatePdfRenderWindow(session, nextFocusGroupIndex);
  }
}

function schedulePdfRenderWindowUpdate(session: PdfRenderSession, focusGroupIndex?: number) {
  if (session.token !== pdfRenderToken) {
    return;
  }

  if (session.updateScheduled) {
    if (typeof focusGroupIndex === "number") {
      session.pendingFocusGroupIndex = focusGroupIndex;
    }
    return;
  }

  session.updateScheduled = true;
  window.requestAnimationFrame(() => {
    session.updateScheduled = false;
    void updatePdfRenderWindow(session, focusGroupIndex);
  });
}

function clampNoteWindow() {
  const nextState = clampNoteWindowPosition(noteState, {
    width: window.innerWidth,
    height: window.innerHeight,
  });
  noteState.x = nextState.x;
  noteState.y = nextState.y;
}

function ensureNoteWindowPlacement() {
  const nextState = ensureNoteWindowPlacementForViewport(noteState, {
    width: window.innerWidth,
    height: window.innerHeight,
  });
  noteState.x = nextState.x;
  noteState.y = nextState.y;
}

function shouldAnchorNoteWindowToBottomRight() {
  return viewerSettings.alignMode === "left" || viewerSettings.alignMode === "center";
}

function syncNoteUi() {
  const noteToggleEl = document.querySelector<HTMLButtonElement>("#note-toggle");
  const notePanelEl = document.querySelector<HTMLElement>("#note-panel");
  const noteEditorEl = document.querySelector<HTMLElement>("#note-editor");

  const hasBook = Boolean(viewerState.currentBook);

  if (noteToggleEl) {
    noteToggleEl.hidden = !hasBook || noteState.isOpen;
    noteToggleEl.textContent = "Notes";
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

function renderLibraryRootsList() {
  const listEl = document.querySelector<HTMLElement>("#config-library-roots-list");
  if (!listEl) {
    return;
  }

  listEl.innerHTML = "";
  const roots = lastAppConfig?.libraryRoots ?? [];

  if (roots.length === 0) {
    const emptyEl = document.createElement("div");
    emptyEl.className = "settings-root-empty";
    emptyEl.textContent = "No library folders selected yet.";
    listEl.appendChild(emptyEl);
    return;
  }

  roots.forEach((root, index) => {
    const itemEl = document.createElement("div");
    itemEl.className = "settings-root-item";

    const codeEl = document.createElement("code");
    codeEl.textContent = root;

    const removeEl = document.createElement("button");
    removeEl.type = "button";
    removeEl.className = "settings-root-remove";
    removeEl.textContent = "Remove";
    removeEl.disabled = roots.length <= 1;
    removeEl.addEventListener("click", () => {
      if (!lastAppConfig) {
        return;
      }

      if (lastAppConfig.libraryRoots.length <= 1) {
        setAppSettingsStatus("At least one library root is required.", "error");
        return;
      }

      lastAppConfig = {
        ...lastAppConfig,
        libraryRoots: lastAppConfig.libraryRoots.filter(
          (_, candidateIndex) => candidateIndex !== index,
        ),
      };
      setAppSettingsStatus("");
      syncAppSettingsUi();
    });

    itemEl.appendChild(codeEl);
    itemEl.appendChild(removeEl);
    listEl.appendChild(itemEl);
  });
}

function setAppSettingsStatus(message: string, tone: "neutral" | "success" | "error" = "neutral") {
  const statusEl = document.querySelector<HTMLElement>("#app-settings-status");
  if (!statusEl) {
    return;
  }

  statusEl.hidden = message.length === 0;
  statusEl.textContent = message;
  if (tone === "neutral") {
    delete statusEl.dataset.tone;
  } else {
    statusEl.dataset.tone = tone;
  }
}

function syncAppSettingsUi() {
  const modalEl = document.querySelector<HTMLElement>("#app-settings-modal");
  const excludedPatternsEl = document.querySelector<HTMLTextAreaElement>(
    "#config-excluded-patterns",
  );
  const pdfRendererEl = document.querySelector<HTMLSelectElement>("#config-pdf-renderer");
  const configPathEl = document.querySelector<HTMLElement>("#app-settings-config-path");

  if (modalEl) {
    modalEl.hidden = !viewerState.isAppSettingsOpen;
  }

  if (lastAppConfig) {
    if (excludedPatternsEl) {
      excludedPatternsEl.value = lastAppConfig.excludedPatterns.join("\n");
    }
    if (pdfRendererEl) {
      pdfRendererEl.value = lastAppConfig.pdfRenderer;
    }
    if (configPathEl) {
      configPathEl.innerHTML = `Config file: <code>${lastAppConfig.configPath}</code>`;
    }
  } else if (configPathEl) {
    configPathEl.textContent = "";
  }

  renderLibraryRootsList();
}

function setTagEditorStatus(message: string, tone: "neutral" | "success" | "error" = "neutral") {
  const statusEl = document.querySelector<HTMLElement>("#tag-editor-status");
  if (!statusEl) {
    return;
  }

  tagEditorState.statusMessage = message;
  statusEl.hidden = message.length === 0;
  statusEl.textContent = message;
  if (tone === "neutral") {
    delete statusEl.dataset.tone;
  } else {
    statusEl.dataset.tone = tone;
  }
}

function setBookMetadataStatus(message: string, tone: "neutral" | "success" | "error" = "neutral") {
  const statusEl = document.querySelector<HTMLElement>("#book-metadata-status");
  if (!statusEl) {
    return;
  }

  bookMetadataEditorState.statusMessage = message;
  statusEl.hidden = message.length === 0;
  statusEl.textContent = message;
  if (tone === "neutral") {
    delete statusEl.dataset.tone;
  } else {
    statusEl.dataset.tone = tone;
  }
}

function syncTagEditorUi() {
  const modalEl = document.querySelector<HTMLElement>("#tag-editor-modal");
  const bookEl = document.querySelector<HTMLElement>("#tag-editor-book");
  const listEl = document.querySelector<HTMLElement>("#tag-editor-list");
  const inputEl = document.querySelector<HTMLInputElement>("#tag-editor-input");
  const suggestionsEl = document.querySelector<HTMLElement>("#tag-editor-suggestions");

  if (modalEl) {
    modalEl.hidden = !tagEditorState.isOpen;
  }

  if (bookEl) {
    bookEl.textContent = tagEditorState.bookTitle;
  }

  if (inputEl) {
    inputEl.value = tagEditorState.input;
  }

  if (suggestionsEl) {
    suggestionsEl.innerHTML = "";
    const explicitTags = deriveTags(lastSnapshot?.books ?? viewerState.books)
      .filter((tag) => tag.explicit)
      .map((tag) => tag.id);
    const suggestions = suggestTagCompletions(
      explicitTags,
      tagEditorState.input,
      tagEditorState.tags,
    );
    suggestionsEl.hidden = suggestions.length === 0;

    for (const tag of suggestions) {
      const suggestionEl = document.createElement("button");
      suggestionEl.type = "button";
      suggestionEl.className = "tag-editor-suggestion";
      suggestionEl.textContent = tag;
      suggestionEl.addEventListener("click", () => {
        tagEditorState.input = tag;
        addTagFromEditorInput();
      });
      suggestionsEl.appendChild(suggestionEl);
    }
  }

  if (!listEl) {
    return;
  }

  listEl.innerHTML = "";

  if (tagEditorState.tags.length === 0) {
    const emptyEl = document.createElement("p");
    emptyEl.className = "empty-state-detail";
    emptyEl.textContent = "No tags yet.";
    listEl.appendChild(emptyEl);
    return;
  }

  for (const tag of tagEditorState.tags) {
    const chipEl = document.createElement("span");
    chipEl.className = "book-tag";

    const labelEl = document.createElement("span");
    labelEl.textContent = tag;

    const removeEl = document.createElement("button");
    removeEl.type = "button";
    removeEl.className = "book-tag-remove";
    removeEl.textContent = "×";
    removeEl.setAttribute("aria-label", `Remove tag ${tag}`);
    removeEl.addEventListener("click", () => {
      tagEditorState.tags = tagEditorState.tags.filter((candidate) => candidate !== tag);
      syncTagEditorUi();
    });

    chipEl.appendChild(labelEl);
    chipEl.appendChild(removeEl);
    listEl.appendChild(chipEl);
  }
}

function syncBookMetadataEditorUi() {
  const modalEl = document.querySelector<HTMLElement>("#book-metadata-modal");
  const bookEl = document.querySelector<HTMLElement>("#book-metadata-book");
  const titleEl = document.querySelector<HTMLInputElement>("#book-metadata-title");
  const authorsEl = document.querySelector<HTMLTextAreaElement>("#book-metadata-authors");
  const descriptionEl = document.querySelector<HTMLTextAreaElement>("#book-metadata-description");
  const publisherEl = document.querySelector<HTMLInputElement>("#book-metadata-publisher");
  const releaseDateEl = document.querySelector<HTMLInputElement>("#book-metadata-release-date");
  const languageEl = document.querySelector<HTMLInputElement>("#book-metadata-language");
  const urlEl = document.querySelector<HTMLInputElement>("#book-metadata-url");
  const asinEl = document.querySelector<HTMLInputElement>("#book-metadata-asin");
  const coverUrlEl = document.querySelector<HTMLInputElement>("#book-metadata-cover-url");
  const importEl = document.querySelector<HTMLTextAreaElement>("#book-metadata-import");
  const exampleEl = document.querySelector<HTMLElement>("#book-metadata-import-example");

  if (modalEl) {
    modalEl.hidden = !bookMetadataEditorState.isOpen;
  }

  if (bookEl) {
    bookEl.textContent = bookMetadataEditorState.bookTitle;
  }

  const syncControlValue = (
    element: HTMLInputElement | HTMLTextAreaElement | null,
    value: string,
  ) => {
    if (!element) {
      return;
    }

    if (document.activeElement === element) {
      return;
    }

    if (element.value !== value) {
      element.value = value;
    }
  };

  syncControlValue(titleEl, bookMetadataEditorState.title);
  syncControlValue(authorsEl, bookMetadataEditorState.authorsText);
  syncControlValue(descriptionEl, bookMetadataEditorState.description);
  syncControlValue(publisherEl, bookMetadataEditorState.publisher);
  syncControlValue(releaseDateEl, bookMetadataEditorState.releaseDate);
  syncControlValue(languageEl, bookMetadataEditorState.language);
  syncControlValue(urlEl, bookMetadataEditorState.url);
  syncControlValue(asinEl, bookMetadataEditorState.asin);
  syncControlValue(coverUrlEl, bookMetadataEditorState.coverUrl);
  syncControlValue(importEl, bookMetadataEditorState.importText);
  if (exampleEl) {
    exampleEl.textContent = BOOK_METADATA_IMPORT_EXAMPLE;
  }
}

function updateBookTagsInState(filePath: string, tags: string[]) {
  const apply = (book: BookSummary) =>
    book.filePath === filePath ? { ...book, tags: [...tags] } : book;

  viewerState.books = viewerState.books.map(apply);
  if (lastSnapshot) {
    lastSnapshot = {
      ...lastSnapshot,
      books: lastSnapshot.books.map(apply),
    };
  }
  if (viewerState.currentBook?.filePath === filePath) {
    viewerState.currentBook = { ...viewerState.currentBook, tags: [...tags] };
  }
}

function populateBookMetadataEditor(book: BookSummary, metadata: BookMetadataPayload) {
  bookMetadataEditorState.filePath = metadata.filePath;
  bookMetadataEditorState.bookTitle = metadata.title || book.fileName;
  bookMetadataEditorState.sourceType = book.sourceType;
  bookMetadataEditorState.title = metadata.title;
  bookMetadataEditorState.authorsText = joinMetadataAuthors(metadata.authors);
  bookMetadataEditorState.description = metadata.description;
  bookMetadataEditorState.publisher = metadata.publisher;
  bookMetadataEditorState.releaseDate = metadata.releaseDate;
  bookMetadataEditorState.language = metadata.language;
  bookMetadataEditorState.url = metadata.url;
  bookMetadataEditorState.asin = metadata.asin;
  bookMetadataEditorState.coverUrl = metadata.coverUrl;
}

function openNewKindleBookEditor() {
  bookMetadataEditorState.loadToken += 1;
  bookMetadataEditorState.isOpen = true;
  bookMetadataEditorState.filePath = null;
  bookMetadataEditorState.bookTitle = "New Kindle book";
  bookMetadataEditorState.sourceType = "kindle";
  bookMetadataEditorState.title = "";
  bookMetadataEditorState.authorsText = "";
  bookMetadataEditorState.description = "";
  bookMetadataEditorState.publisher = "";
  bookMetadataEditorState.releaseDate = "";
  bookMetadataEditorState.language = "";
  bookMetadataEditorState.url = "";
  bookMetadataEditorState.asin = "";
  bookMetadataEditorState.coverUrl = "";
  bookMetadataEditorState.importText = "";
  setBookMetadataStatus("");
  syncBookMetadataEditorUi();
}

function openTagEditor(book: BookSummary) {
  tagEditorState.isOpen = true;
  tagEditorState.filePath = book.filePath;
  tagEditorState.bookTitle = book.fileName;
  tagEditorState.tags = [...book.tags];
  tagEditorState.input = "";
  setTagEditorStatus("");
  syncTagEditorUi();
}

async function openBookMetadataEditor(book: BookSummary) {
  const loadToken = bookMetadataEditorState.loadToken + 1;
  bookMetadataEditorState.loadToken = loadToken;
  bookMetadataEditorState.isOpen = true;
  bookMetadataEditorState.filePath = book.filePath;
  bookMetadataEditorState.bookTitle = book.fileName;
  bookMetadataEditorState.sourceType = book.sourceType;
  bookMetadataEditorState.title = "";
  bookMetadataEditorState.authorsText = "";
  bookMetadataEditorState.description = "";
  bookMetadataEditorState.publisher = "";
  bookMetadataEditorState.releaseDate = "";
  bookMetadataEditorState.language = "";
  bookMetadataEditorState.url = "";
  bookMetadataEditorState.asin = "";
  bookMetadataEditorState.coverUrl = "";
  bookMetadataEditorState.importText = "";
  setBookMetadataStatus("Loading metadata...");
  syncBookMetadataEditorUi();

  try {
    const payload = await invoke<BookMetadataPayload>("load_book_metadata", {
      filePath: book.filePath,
    });
    if (bookMetadataEditorState.loadToken !== loadToken) {
      return;
    }

    populateBookMetadataEditor(book, payload);
    setBookMetadataStatus("");
    syncBookMetadataEditorUi();
  } catch (error) {
    if (bookMetadataEditorState.loadToken !== loadToken) {
      return;
    }
    setBookMetadataStatus(`Failed to load metadata: ${String(error)}`, "error");
  }
}

function closeTagEditor() {
  tagEditorState.isOpen = false;
  tagEditorState.input = "";
  setTagEditorStatus("");
  syncTagEditorUi();
}

function closeBookMetadataEditor() {
  bookMetadataEditorState.isOpen = false;
  bookMetadataEditorState.filePath = null;
  bookMetadataEditorState.sourceType = "pdf";
  bookMetadataEditorState.importText = "";
  bookMetadataEditorState.loadToken += 1;
  setBookMetadataStatus("");
  syncBookMetadataEditorUi();
}

function addTagFromEditorInput() {
  const inputEl = document.querySelector<HTMLInputElement>("#tag-editor-input");
  const rawValue = tagEditorState.input || inputEl?.value || "";
  const result = validateTagValue(rawValue);
  if (!result.ok) {
    setTagEditorStatus(result.message, "error");
    return;
  }
  const candidate = result.value;

  if (!tagEditorState.tags.includes(candidate)) {
    tagEditorState.tags = [...tagEditorState.tags, candidate];
  }

  tagEditorState.input = "";
  setTagEditorStatus("");
  if (inputEl) {
    inputEl.value = "";
  }
  syncTagEditorUi();
}

function buildBookMetadataDraftFromForm() {
  const titleEl = document.querySelector<HTMLInputElement>("#book-metadata-title");
  const authorsEl = document.querySelector<HTMLTextAreaElement>("#book-metadata-authors");
  const descriptionEl = document.querySelector<HTMLTextAreaElement>("#book-metadata-description");
  const publisherEl = document.querySelector<HTMLInputElement>("#book-metadata-publisher");
  const releaseDateEl = document.querySelector<HTMLInputElement>("#book-metadata-release-date");
  const languageEl = document.querySelector<HTMLInputElement>("#book-metadata-language");
  const urlEl = document.querySelector<HTMLInputElement>("#book-metadata-url");
  const asinEl = document.querySelector<HTMLInputElement>("#book-metadata-asin");
  const coverUrlEl = document.querySelector<HTMLInputElement>("#book-metadata-cover-url");

  return {
    title: titleEl?.value ?? bookMetadataEditorState.title,
    authorsText: authorsEl?.value ?? bookMetadataEditorState.authorsText,
    description: descriptionEl?.value ?? bookMetadataEditorState.description,
    publisher: publisherEl?.value ?? bookMetadataEditorState.publisher,
    releaseDate: releaseDateEl?.value ?? bookMetadataEditorState.releaseDate,
    language: languageEl?.value ?? bookMetadataEditorState.language,
    url: urlEl?.value ?? bookMetadataEditorState.url,
    asin: asinEl?.value ?? bookMetadataEditorState.asin,
    coverUrl: coverUrlEl?.value ?? bookMetadataEditorState.coverUrl,
  };
}

function applyBookMetadataDraftToState(draft: {
  title: string;
  authorsText: string;
  description: string;
  publisher: string;
  releaseDate: string;
  language: string;
  url: string;
  asin: string;
  coverUrl: string;
}) {
  bookMetadataEditorState.title = draft.title;
  bookMetadataEditorState.authorsText = draft.authorsText;
  bookMetadataEditorState.description = draft.description;
  bookMetadataEditorState.publisher = draft.publisher;
  bookMetadataEditorState.releaseDate = draft.releaseDate;
  bookMetadataEditorState.language = draft.language;
  bookMetadataEditorState.url = draft.url;
  bookMetadataEditorState.asin = draft.asin;
  bookMetadataEditorState.coverUrl = draft.coverUrl;
}

function importBookMetadataFromJson() {
  const importEl = document.querySelector<HTMLTextAreaElement>("#book-metadata-import");
  const importText = importEl?.value ?? bookMetadataEditorState.importText;
  const parsed = parseBookMetadataImport(importText);
  if (!parsed.ok) {
    setBookMetadataStatus(parsed.message, "error");
    return;
  }

  const nextDraft = applyBookMetadataImport(buildBookMetadataDraftFromForm(), parsed.patch);
  const validation = validateBookMetadataDraft(nextDraft);
  if (!validation.ok) {
    setBookMetadataStatus(validation.message, "error");
    return;
  }

  bookMetadataEditorState.importText = importText;
  applyBookMetadataDraftToState(nextDraft);
  setBookMetadataStatus("Imported metadata from JSON.", "success");
  syncBookMetadataEditorUi();
}

async function refreshSnapshot() {
  const snapshot = await invoke<LibrarySnapshot>("library_snapshot");
  lastSnapshot = snapshot;
  viewerState.books = snapshot.books;
  viewerState.libraryErrorMessage = null;
  renderApp();
}

async function saveTagEditorChanges() {
  if (!tagEditorState.filePath) {
    return;
  }

  for (const tag of tagEditorState.tags) {
    const result = validateTagValue(tag);
    if (!result.ok) {
      setTagEditorStatus(result.message, "error");
      return;
    }
  }

  try {
    const payload = await invoke<BookTagsPayload>("save_book_tags", {
      filePath: tagEditorState.filePath,
      tags: tagEditorState.tags,
    });
    updateBookTagsInState(payload.filePath, payload.tags);
    closeTagEditor();
    renderApp();
  } catch (error) {
    setTagEditorStatus(`Failed to save tags: ${String(error)}`, "error");
  }
}

async function saveBookMetadataChanges() {
  const draft = buildBookMetadataDraftFromForm();
  const validation = validateBookMetadataDraft(draft);
  if (!validation.ok) {
    setBookMetadataStatus(validation.message, "error");
    return;
  }

  const filePath =
    bookMetadataEditorState.filePath ?? `kindle:${draft.asin.trim() || crypto.randomUUID()}`;

  try {
    const payload = await invoke<BookMetadataPayload>("save_book_metadata", {
      input: {
        filePath,
        title: draft.title,
        authors: normalizeMetadataAuthorsText(draft.authorsText),
        description: draft.description,
        publisher: draft.publisher,
        releaseDate: draft.releaseDate,
        language: draft.language,
        url: draft.url,
        asin: draft.asin,
        coverUrl: draft.coverUrl,
      },
    });
    const sourceBook =
      viewerState.currentBook?.filePath === payload.filePath
        ? viewerState.currentBook
        : {
            fileName: bookMetadataEditorState.bookTitle,
            filePath: payload.filePath,
            fileSize: 0,
            tags: [],
            authors: payload.authors,
            sourceType: bookMetadataEditorState.sourceType,
            coverUrl: payload.coverUrl || null,
            locationLabel:
              bookMetadataEditorState.sourceType === "kindle" ? "Kindle library" : null,
            isOpenable: bookMetadataEditorState.sourceType === "pdf",
          };
    populateBookMetadataEditor(sourceBook, payload);
    await refreshSnapshot();
    closeBookMetadataEditor();
  } catch (error) {
    setBookMetadataStatus(`Failed to save metadata: ${String(error)}`, "error");
  }
}

function syncAboutUi() {
  const modalEl = document.querySelector<HTMLElement>("#app-about-modal");
  const nameEl = document.querySelector<HTMLElement>("#app-about-name");
  const versionEl = document.querySelector<HTMLElement>("#app-about-version");
  const buildDateEl = document.querySelector<HTMLElement>("#app-about-build-date");
  const licenseEl = document.querySelector<HTMLElement>("#app-license-text");
  const thirdPartyRustEl = document.querySelector<HTMLElement>("#app-third-party-rust-text");
  const thirdPartyJsEl = document.querySelector<HTMLElement>("#app-third-party-js-text");

  if (modalEl) {
    modalEl.hidden = !viewerState.isAboutOpen;
  }

  if (nameEl) {
    nameEl.textContent = cachedAppName;
  }

  if (versionEl) {
    versionEl.textContent = cachedAppVersion;
  }

  if (buildDateEl) {
    buildDateEl.textContent = `(built ${buildDate})`;
  }

  if (licenseEl) {
    licenseEl.textContent = cachedLicenseText;
  }

  if (thirdPartyRustEl) {
    thirdPartyRustEl.textContent = cachedThirdPartyRustText;
  }

  if (thirdPartyJsEl) {
    thirdPartyJsEl.textContent = cachedThirdPartyJsText;
  }
}

async function loadThirdPartyLicenses() {
  try {
    const [licenseModule, rustModule, jsModule] = await Promise.all([
      import("../LICENSE?raw"),
      import("../THIRD-PARTY-LICENSES-rust.md?raw"),
      import("../THIRD-PARTY-LICENSES-js.md?raw"),
    ]);

    cachedLicenseText = licenseModule.default.trim();
    cachedThirdPartyRustText = rustModule.default.trim();
    cachedThirdPartyJsText = jsModule.default.trim();
  } catch (error) {
    const message = `Failed to load third-party notices: ${String(error)}`;
    cachedLicenseText = message;
    cachedThirdPartyRustText = message;
    cachedThirdPartyJsText = message;
  }
}

async function loadAppConfig() {
  lastAppConfig = await invoke<AppConfigPayload>("load_app_config");
  if (!lastAppConfig.configExists) {
    viewerState.isAppSettingsOpen = true;
    setAppSettingsStatus("Choose at least one library folder to get started.");
  }
  syncAppSettingsUi();
}

async function saveAppSettingsFromForm() {
  const excludedPatternsEl = document.querySelector<HTMLTextAreaElement>(
    "#config-excluded-patterns",
  );
  const pdfRendererEl = document.querySelector<HTMLSelectElement>("#config-pdf-renderer");

  const libraryRoots = [...(lastAppConfig?.libraryRoots ?? [])];

  if (libraryRoots.length === 0) {
    setAppSettingsStatus("At least one library root is required.", "error");
    return;
  }

  try {
    const payload = await invoke<AppConfigPayload>("save_app_config", {
      input: {
        ...buildAppConfigDraft(libraryRoots, excludedPatternsEl?.value ?? "", pdfRendererEl?.value),
      },
    });

    lastAppConfig = payload;
    const snapshot = await invoke<LibrarySnapshot>("library_snapshot");
    lastSnapshot = snapshot;
    viewerState.books = snapshot.books;
    renderApp();
    viewerState.isAppSettingsOpen = false;
    setAppSettingsStatus("");
    syncAppSettingsUi();
  } catch (error) {
    setAppSettingsStatus(`Failed to save settings: ${String(error)}`, "error");
  }
}

function syncViewerSettingsUi() {
  const settingsToggleEl = document.querySelector<HTMLButtonElement>("#viewer-settings-toggle");
  const settingsPanelEl = document.querySelector<HTMLElement>("#viewer-settings-panel");
  const tagsOpenEl = document.querySelector<HTMLButtonElement>("#viewer-tags-open");
  const metadataOpenEl = document.querySelector<HTMLButtonElement>("#viewer-metadata-open");
  const scopeGlobalEl = document.querySelector<HTMLButtonElement>("#viewer-settings-scope-global");
  const scopeFileEl = document.querySelector<HTMLButtonElement>("#viewer-settings-scope-file");
  const pageModeEl = document.querySelector<HTMLSelectElement>("#viewer-page-mode");
  const bindingEl = document.querySelector<HTMLSelectElement>("#viewer-binding-direction");
  const zoomModeEl = document.querySelector<HTMLSelectElement>("#viewer-zoom-mode");
  const alignModeEl = document.querySelector<HTMLSelectElement>("#viewer-align-mode");
  const verticalGapModeEl = document.querySelector<HTMLSelectElement>("#viewer-vertical-gap-mode");
  const coverModeEl = document.querySelector<HTMLInputElement>("#viewer-cover-mode");
  const isPdfJs = lastSnapshot?.pdfRenderer === "pdfjs" && Boolean(viewerState.currentBook);
  const editingPreferences =
    viewerSettings.scope === "file" ? viewerSettings.fileDraft : viewerSettings.globalDraft;

  if (settingsToggleEl) {
    settingsToggleEl.hidden = !isPdfJs;
    settingsToggleEl.setAttribute("aria-expanded", String(viewerSettings.isSettingsOpen));
  }

  if (tagsOpenEl) {
    tagsOpenEl.hidden = !isPdfJs || !viewerSettings.isSettingsOpen;
  }

  if (metadataOpenEl) {
    metadataOpenEl.hidden =
      !viewerState.currentBook ||
      (lastSnapshot?.pdfRenderer === "pdfjs" && !viewerSettings.isSettingsOpen);
  }

  if (settingsPanelEl) {
    settingsPanelEl.hidden = !isPdfJs || !viewerSettings.isSettingsOpen;
    settingsPanelEl.dataset.scope = viewerSettings.scope;
  }

  scopeGlobalEl?.classList.toggle("is-active", viewerSettings.scope === "global");
  scopeGlobalEl?.setAttribute("aria-selected", String(viewerSettings.scope === "global"));
  scopeFileEl?.classList.toggle("is-active", viewerSettings.scope === "file");
  scopeFileEl?.setAttribute("aria-selected", String(viewerSettings.scope === "file"));

  if (pageModeEl) {
    pageModeEl.value = editingPreferences.pageMode;
  }

  if (bindingEl) {
    bindingEl.value = editingPreferences.bindingDirection;
  }

  if (zoomModeEl) {
    zoomModeEl.value = editingPreferences.zoomMode;
  }

  if (alignModeEl) {
    alignModeEl.value = editingPreferences.alignMode;
  }

  if (verticalGapModeEl) {
    verticalGapModeEl.value = editingPreferences.verticalGapMode;
  }

  if (coverModeEl) {
    coverModeEl.checked = editingPreferences.treatFirstPageAsCover;
  }
}

function currentViewerPreferences(): ViewerSettings {
  return {
    ...(viewerSettings.scope === "file" ? viewerSettings.fileDraft : viewerSettings.globalDraft),
  };
}

function setViewerDraft(scope: ViewerSettingsScope, preferences: ViewerSettings) {
  if (scope === "file") {
    viewerSettings.fileDraft = { ...preferences };
    return;
  }

  viewerSettings.globalDraft = { ...preferences };
}

function applyViewerPreferences(
  preferences: ViewerSettings,
  scope: ViewerSettingsScope,
  hasFileOverride: boolean,
) {
  viewerSettings.pageMode = preferences.pageMode;
  viewerSettings.bindingDirection = preferences.bindingDirection;
  viewerSettings.zoomMode = preferences.zoomMode;
  viewerSettings.alignMode = preferences.alignMode;
  viewerSettings.verticalGapMode = preferences.verticalGapMode;
  viewerSettings.treatFirstPageAsCover = preferences.treatFirstPageAsCover;
  viewerSettings.scope = scope;
  viewerSettings.hasFileOverride = hasFileOverride;
}

function applyViewerSettingsPayload(
  payload: ViewerSettingsPayload,
  preferredScope: ViewerSettingsScope = payload.usesFileOverride ? "file" : "global",
) {
  const nextState = applyViewerSettingsPayloadToState(payload, preferredScope);
  applyViewerPreferences(nextState, nextState.scope, nextState.hasFileOverride);
  viewerSettings.globalDraft = nextState.globalDraft;
  viewerSettings.fileDraft = nextState.fileDraft;
}

async function loadViewerSettingsForCurrentBook() {
  const currentBook = viewerState.currentBook;

  if (!currentBook) {
    applyViewerPreferences(DEFAULT_VIEWER_SETTINGS, "global", false);
    viewerSettings.globalDraft = { ...DEFAULT_VIEWER_SETTINGS };
    viewerSettings.fileDraft = { ...DEFAULT_VIEWER_SETTINGS };
    syncViewerSettingsUi();
    return;
  }

  viewerSettingsLoadToken += 1;
  const currentToken = viewerSettingsLoadToken;

  try {
    const payload = await invoke<ViewerSettingsPayload>("load_viewer_preferences", {
      filePath: currentBook.filePath,
    });

    if (
      currentToken !== viewerSettingsLoadToken ||
      viewerState.currentBook?.filePath !== currentBook.filePath
    ) {
      return;
    }

    applyViewerSettingsPayload(payload);
    syncViewerSettingsUi();
  } catch (error) {
    applyViewerPreferences(DEFAULT_VIEWER_SETTINGS, "global", false);
    viewerSettings.globalDraft = { ...DEFAULT_VIEWER_SETTINGS };
    viewerSettings.fileDraft = { ...DEFAULT_VIEWER_SETTINGS };
    syncViewerSettingsUi();
    console.error("Failed to load viewer preferences:", error);
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
  noteState.statusMessage = "Saving notes...";
  syncNoteUi();

  try {
    const note = await invoke<NoteDocument>("save_note", {
      filePath: noteState.activeFilePath,
      content: noteState.currentContent,
    });

    noteState.savedContent = note.content;
    noteState.statusMessage = "Saved";
  } catch (error) {
    noteState.statusMessage = `Failed to save notes: ${String(error)}`;
  } finally {
    noteState.isSaving = false;
    syncNoteUi();
  }
}

function scheduleNoteSave(markdown: string) {
  noteState.currentContent = markdown;
  noteState.statusMessage = "Waiting to save...";
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
  noteState.statusMessage = "Loading notes...";
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
    noteState.statusMessage = note.updatedAt ? "Saved" : "Notes are saved automatically.";

    const { mountNoteEditor } = await loadNoteEditorModule();
    noteEditor = await mountNoteEditor({
      root: noteRootEl,
      initialMarkdown: note.content,
      onMarkdownChange: (markdown) => {
        scheduleNoteSave(markdown);
      },
    });
  } catch (error) {
    noteState.statusMessage = `Failed to load notes: ${String(error)}`;
  } finally {
    if (currentToken === noteLoadToken) {
      noteState.isLoading = false;
      syncNoteUi();
    }
  }
}

async function clearCurrentBookSelection() {
  activeReadingPosition = captureReadingPositionFromViewer();
  await flushReadingPositionSave();
  await flushPendingNoteSave();
  await destroyNoteEditor();
  noteState.activeFilePath = null;
  noteState.currentContent = "";
  noteState.savedContent = "";
  noteState.statusMessage = "Notes are saved automatically.";
  viewerState.currentBook = null;
  applyViewerPreferences(DEFAULT_VIEWER_SETTINGS, "global", false);
  viewerSettings.globalDraft = { ...DEFAULT_VIEWER_SETTINGS };
  viewerSettings.fileDraft = { ...DEFAULT_VIEWER_SETTINGS };
  syncNoteUi();
  syncViewerSettingsUi();
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
      nextLeft =
        noteInteractionState.startLeft + (noteInteractionState.startWidth - MIN_NOTE_WIDTH);
    }
  }

  if (edge.includes("n")) {
    nextHeight = Math.max(MIN_NOTE_HEIGHT, noteInteractionState.startHeight - dy);
    nextTop = noteInteractionState.startTop + dy;
    if (nextHeight === MIN_NOTE_HEIGHT) {
      nextTop =
        noteInteractionState.startTop + (noteInteractionState.startHeight - MIN_NOTE_HEIGHT);
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
  return filterVisibleBooks(
    snapshot.books,
    viewerState.activeDirectory,
    viewerState.activeTag,
    viewerState.activeExternalSource,
    viewerState.activeTagDirectOnly,
    viewerState.searchQuery,
  );
}

function describeEmptyLibraryState(snapshot: LibrarySnapshot, books: BookSummary[]) {
  if (
    viewerState.searchQuery ||
    viewerState.activeDirectory ||
    viewerState.activeTag ||
    viewerState.activeExternalSource
  ) {
    return {
      message: "No matching books.",
      detail: null as string | null,
    };
  }

  if (viewerState.libraryErrorMessage) {
    return {
      message: viewerState.libraryErrorMessage,
      detail: null as string | null,
    };
  }

  if (snapshot.libraryRoots.length === 0) {
    return {
      message: "No library folders selected yet.",
      detail: "Open Settings and add at least one library folder.",
    };
  }

  if (snapshot.existingLibraryRoots.length === 0) {
    return {
      message: "The configured library folders do not exist.",
      detail:
        "Update Library roots in Settings and choose folders that are available on this machine.",
    };
  }

  if (books.length === 0) {
    const detail =
      snapshot.missingLibraryRoots.length > 0
        ? "Some configured folders are missing, and no PDFs were found in the folders that still exist."
        : "No PDFs were found in the configured library folders.";

    return {
      message: "Your library is empty.",
      detail,
    };
  }

  return {
    message: "No PDFs yet.",
    detail: null as string | null,
  };
}

function currentNavigationState(): NavigationState {
  return {
    historyIndex: navigationHistoryIndex,
    bookFilePath: viewerState.currentBook?.filePath ?? null,
    activeDirectory: viewerState.activeDirectory,
    activeTag: viewerState.activeTag,
    activeExternalSource: viewerState.activeExternalSource,
    activeTagDirectOnly: viewerState.activeTagDirectOnly,
    searchQuery: viewerState.searchQuery,
  };
}

function syncNavigationHistory(mode: "push" | "replace") {
  if (suppressHistoryUpdates) {
    return;
  }

  syncNavigationHistoryState(currentNavigationState(), mode);
}

function syncNavigationHistoryState(state: NavigationState, mode: "push" | "replace") {
  if (suppressHistoryUpdates) {
    return;
  }

  const normalizedState = {
    ...state,
    historyIndex: navigationHistoryIndex,
  };

  if (mode === "push") {
    const currentState = navigationEntries[navigationHistoryIndex];
    if (
      currentState &&
      navigationStateSignature(currentState) === navigationStateSignature(normalizedState)
    ) {
      syncNavigationControlsUi();
      return;
    }

    navigationEntries = navigationEntries.slice(0, navigationHistoryIndex + 1);
    navigationEntries.push({
      ...normalizedState,
      historyIndex: navigationHistoryIndex + 1,
    });
    navigationHistoryIndex = navigationEntries.length - 1;
  } else if (navigationEntries.length === 0) {
    navigationEntries = [{ ...normalizedState, historyIndex: 0 }];
    navigationHistoryIndex = 0;
  } else {
    navigationEntries[navigationHistoryIndex] = {
      ...normalizedState,
      historyIndex: navigationHistoryIndex,
    };
  }

  navigationHistoryMax = Math.max(0, navigationEntries.length - 1);
  const historyState = navigationEntries[navigationHistoryIndex];
  const url = buildNavigationUrl(historyState);

  if (mode === "push") {
    window.history.pushState(historyState, "", url);
  } else {
    window.history.replaceState(historyState, "", url);
  }

  syncNavigationControlsUi();
}

async function navigateToState(
  state: Omit<NavigationState, "historyIndex">,
  mode: "push" | "replace",
) {
  const nextState: NavigationState = {
    historyIndex: navigationHistoryIndex,
    ...state,
  };

  syncNavigationHistoryState(nextState, mode);
  await applyNavigationState({
    ...nextState,
    historyIndex: navigationHistoryIndex,
  });
}

async function applyNavigationState(state: NavigationState) {
  const snapshot = lastSnapshot;

  if (!snapshot) {
    return;
  }

  viewerState.searchQuery = state.searchQuery;
  viewerState.activeDirectory = state.activeDirectory;
  viewerState.activeTag = state.activeTag;
  viewerState.activeExternalSource = state.activeExternalSource;
  viewerState.activeTagDirectOnly = state.activeTagDirectOnly;

  const nextBook = state.bookFilePath
    ? (snapshot.books.find((book) => book.filePath === state.bookFilePath) ?? null)
    : null;

  ensureExpandedPath(state.activeDirectory);
  ensureExpandedTag(state.activeTag);

  if (nextBook) {
    await openBook(nextBook, { updateHistory: "none" });
    return;
  }

  await clearCurrentBookSelection();
  renderApp();
}

function syncNavigationControlsUi() {
  const backButtonEl = document.querySelector<HTMLButtonElement>("#nav-back");
  const forwardButtonEl = document.querySelector<HTMLButtonElement>("#nav-forward");

  if (backButtonEl) {
    backButtonEl.disabled = navigationHistoryIndex <= 0;
  }

  if (forwardButtonEl) {
    forwardButtonEl.disabled = navigationHistoryIndex >= navigationHistoryMax;
  }
}

function isEditableTarget(target: EventTarget | null) {
  const element = target instanceof HTMLElement ? target : null;

  if (!element) {
    return false;
  }

  return Boolean(
    element.closest('input, textarea, select, [contenteditable="true"], .ProseMirror, .milkdown'),
  );
}

function currentViewerStage() {
  return document.querySelector<HTMLElement>(".viewer-stage");
}

function captureReadingPositionFromViewer(): ReadingPosition | null {
  const currentBook = viewerState.currentBook;
  const stageEl = currentViewerStage();
  const pdfjsViewerEl = document.querySelector<HTMLElement>("#pdfjs-viewer");

  if (
    !currentBook ||
    !stageEl ||
    !pdfjsViewerEl ||
    lastSnapshot?.pdfRenderer !== "pdfjs" ||
    pdfjsViewerEl.dataset.filePath !== currentBook.filePath
  ) {
    return activeReadingPosition;
  }

  const pageEls = Array.from(
    document.querySelectorAll<HTMLElement>(".pdfjs-page[data-page-number]"),
  );

  if (pageEls.length === 0) {
    return activeReadingPosition;
  }

  const anchorLine = stageEl.scrollTop + 24;
  let anchorPageEl = pageEls[0];

  for (const pageEl of pageEls) {
    if (pageEl.offsetTop <= anchorLine) {
      anchorPageEl = pageEl;
    } else {
      break;
    }
  }

  const pageNumber = Number(anchorPageEl.dataset.pageNumber ?? "1");
  const pageHeight = Math.max(anchorPageEl.offsetHeight, 1);
  const pageOffsetRatio = Math.min(
    Math.max((stageEl.scrollTop - anchorPageEl.offsetTop) / pageHeight, 0),
    1,
  );

  return {
    filePath: currentBook.filePath,
    pageNumber,
    pageOffsetRatio,
    updatedAt: activeReadingPosition?.updatedAt ?? null,
  };
}

function cacheReadingPosition(position: ReadingPosition | null) {
  if (!position) {
    return;
  }

  try {
    window.localStorage.setItem(
      readingPositionStorageKey(position.filePath),
      JSON.stringify(position),
    );
  } catch (error) {
    console.error("Failed to cache reading position:", error);
  }
}

function loadCachedReadingPosition(filePath: string): ReadingPosition | null {
  try {
    const rawValue = window.localStorage.getItem(readingPositionStorageKey(filePath));
    return parseCachedReadingPosition(rawValue);
  } catch (error) {
    console.error("Failed to read cached reading position:", error);
    return null;
  }
}

async function flushReadingPositionSave() {
  if (readingPositionSaveTimer !== null) {
    window.clearTimeout(readingPositionSaveTimer);
    readingPositionSaveTimer = null;
  }

  if (
    !activeReadingPosition ||
    activeReadingPosition.filePath !== viewerState.currentBook?.filePath
  ) {
    return;
  }

  try {
    activeReadingPosition = await invoke<ReadingPosition>("save_reading_position", {
      filePath: activeReadingPosition.filePath,
      pageNumber: activeReadingPosition.pageNumber,
      pageOffsetRatio: activeReadingPosition.pageOffsetRatio,
    });
  } catch (error) {
    console.error("Failed to save reading position:", error);
  }
}

function scheduleReadingPositionSave() {
  activeReadingPosition = captureReadingPositionFromViewer();

  if (!activeReadingPosition) {
    return;
  }

  cacheReadingPosition(activeReadingPosition);
  syncViewerPageJumpUi();

  if (readingPositionSaveTimer !== null) {
    window.clearTimeout(readingPositionSaveTimer);
  }

  readingPositionSaveTimer = window.setTimeout(() => {
    void flushReadingPositionSave();
  }, 300);
}

async function loadReadingPositionForCurrentBook() {
  const currentBook = viewerState.currentBook;

  if (!currentBook) {
    activeReadingPosition = null;
    syncViewerPageJumpUi();
    return;
  }

  try {
    activeReadingPosition =
      loadCachedReadingPosition(currentBook.filePath) ??
      (await invoke<ReadingPosition | null>("load_reading_position", {
        filePath: currentBook.filePath,
      }));
    cacheReadingPosition(activeReadingPosition);
    syncViewerPageJumpUi();
  } catch (error) {
    activeReadingPosition = loadCachedReadingPosition(currentBook.filePath);
    syncViewerPageJumpUi();
    console.error("Failed to load reading position:", error);
  }
}

function restoreReadingPositionAttempt() {
  const currentBook = viewerState.currentBook;
  const stageEl = currentViewerStage();

  if (!currentBook || !stageEl || !activeReadingPosition) {
    return false;
  }

  if (activeReadingPosition.filePath !== currentBook.filePath) {
    return false;
  }

  const pageEl = document.querySelector<HTMLElement>(
    `.pdfjs-page[data-page-number="${activeReadingPosition.pageNumber}"]`,
  );

  if (!pageEl) {
    return false;
  }

  const stageRect = stageEl.getBoundingClientRect();
  const pageRect = pageEl.getBoundingClientRect();
  const pageOffsetRatio = clampReadingPositionOffsetRatio(activeReadingPosition.pageOffsetRatio);
  const pageTopInStage = stageEl.scrollTop + (pageRect.top - stageRect.top);
  const targetTop = pageTopInStage + pageEl.offsetHeight * pageOffsetRatio;

  stageEl.scrollTo({
    top: Math.max(targetTop, 0),
    behavior: "auto",
  });
  return true;
}

function scheduleReadingPositionRestore() {
  let attempts = 0;
  const run = () => {
    attempts += 1;
    if (restoreReadingPositionAttempt() || attempts >= 5) {
      return;
    }

    window.requestAnimationFrame(run);
  };

  window.requestAnimationFrame(run);
}

function navigateBack() {
  if (navigationHistoryIndex <= 0) {
    return;
  }

  navigationHistoryIndex -= 1;
  const nextState = navigationEntries[navigationHistoryIndex];
  window.history.replaceState(nextState, "", buildNavigationUrl(nextState));
  syncNavigationControlsUi();
  suppressHistoryUpdates = true;
  void applyNavigationState(nextState).finally(() => {
    suppressHistoryUpdates = false;
  });
}

function navigateForward() {
  if (navigationHistoryIndex >= navigationHistoryMax) {
    return;
  }

  navigationHistoryIndex += 1;
  const nextState = navigationEntries[navigationHistoryIndex];
  window.history.replaceState(nextState, "", buildNavigationUrl(nextState));
  syncNavigationControlsUi();
  suppressHistoryUpdates = true;
  void applyNavigationState(nextState).finally(() => {
    suppressHistoryUpdates = false;
  });
}

async function renderCurrentPage() {
  const frame = document.querySelector<HTMLIFrameElement>("#pdf-frame");
  const viewerStageEl = currentViewerStage();
  const pdfjsViewerEl = document.querySelector<HTMLElement>("#pdfjs-viewer");
  const snapshot = lastSnapshot;

  if (!frame || !viewerStageEl || !pdfjsViewerEl || !viewerState.currentBook || !snapshot) {
    return;
  }

  const previousFilePath = pdfjsViewerEl.dataset.filePath;
  if (previousFilePath && previousFilePath === viewerState.currentBook.filePath) {
    activeReadingPosition = captureReadingPositionFromViewer();
  }

  const sourceUrl = convertFileSrc(viewerState.currentBook.filePath);

  if (snapshot.pdfRenderer === "pdfjs") {
    activePdfRenderSession = null;
    frame.hidden = true;
    frame.src = "about:blank";
    frame.dataset.filePath = "";
    pdfjsViewerEl.hidden = false;
    pdfjsViewerEl.innerHTML = "";
    pdfjsViewerEl.dataset.filePath = viewerState.currentBook.filePath;
    pdfjsViewerEl.dataset.position = viewerSettings.alignMode;
    pdfjsViewerEl.dataset.verticalGap = viewerSettings.verticalGapMode;

    pdfRenderToken += 1;
    const currentToken = pdfRenderToken;
    const loadingEl = document.createElement("div");
    loadingEl.className = "pdfjs-loading";
    loadingEl.textContent = "Rendering PDF...";
    pdfjsViewerEl.appendChild(loadingEl);

    try {
      const { getDocument } = await loadPdfJsRuntime();
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
      const pageGroups = buildPageGroups(pdfDocument.numPages, viewerSettings);
      const restoreTargetPage = activeReadingPosition?.pageNumber ?? null;
      const pageGap = viewerSettings.pageMode === "spread" ? 6 : 0;
      const viewerWidth = Math.max(pdfjsViewerEl.clientWidth, 720);
      const viewerHeight = Math.max(pdfjsViewerEl.clientHeight, 600);
      const maxColumns = viewerSettings.pageMode === "spread" ? 2 : 1;
      const availableWidth = viewerWidth - pageGap * (maxColumns - 1) - 32;
      const renderPlans: PdfRenderPlan[] = [];

      for (const [groupIndex, group] of pageGroups.entries()) {
        const visualOrder = getVisualPageOrder(group, viewerSettings);
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

        const pageSlots = new Map<number, HTMLElement>();
        for (const pageNumber of visualOrder) {
          const estimatedViewport = (await pdfDocument.getPage(pageNumber)).getViewport({
            scale: baseScale,
          });
          const pageEl = document.createElement("section");
          pageEl.className = "pdfjs-page page";
          pageEl.dataset.pageNumber = String(pageNumber);
          pageEl.style.width = `${estimatedViewport.width}px`;
          pageEl.style.height = `${estimatedViewport.height}px`;
          spreadEl.appendChild(pageEl);
          pageSlots.set(pageNumber, pageEl);
        }

        renderPlans.push({ groupIndex, visualOrder, spreadEl, pageSlots, baseScale });
      }

      const targetGroupIndex =
        restoreTargetPage === null
          ? 0
          : Math.max(
              0,
              pageGroups.findIndex((group) => group.includes(restoreTargetPage)),
            );
      const session: PdfRenderSession = {
        token: currentToken,
        pdfDocument,
        viewerEl: pdfjsViewerEl,
        stageEl: viewerStageEl,
        plans: renderPlans,
        restoreTargetPage,
        updateScheduled: false,
        isUpdating: false,
        pendingFocusGroupIndex: null,
      };
      activePdfRenderSession = session;
      schedulePdfRenderWindowUpdate(session, targetGroupIndex);
    } catch (error) {
      pdfjsViewerEl.innerHTML = "";
      const errorEl = document.createElement("div");
      errorEl.className = "pdfjs-loading";
      errorEl.textContent = `Failed to render with PDF.js: ${String(error)}`;
      pdfjsViewerEl.appendChild(errorEl);
    }

    return;
  }

  pdfRenderToken += 1;
  activePdfRenderSession = null;
  pdfjsViewerEl.hidden = true;
  pdfjsViewerEl.innerHTML = "";
  pdfjsViewerEl.dataset.filePath = "";
  frame.hidden = false;
  frame.dataset.filePath = viewerState.currentBook.filePath;
  frame.src = activeReadingPosition?.pageNumber
    ? `${sourceUrl}#page=${activeReadingPosition.pageNumber}`
    : sourceUrl;
}

function viewerNeedsRender(snapshot: LibrarySnapshot) {
  const frame = document.querySelector<HTMLIFrameElement>("#pdf-frame");
  const pdfjsViewerEl = document.querySelector<HTMLElement>("#pdfjs-viewer");
  const currentBook = viewerState.currentBook;

  if (!frame || !pdfjsViewerEl || !currentBook) {
    return false;
  }

  if (snapshot.pdfRenderer === "pdfjs") {
    return (
      pdfjsViewerEl.hidden ||
      pdfjsViewerEl.dataset.filePath !== currentBook.filePath ||
      pdfjsViewerEl.childElementCount === 0
    );
  }

  return frame.hidden || frame.dataset.filePath !== currentBook.filePath;
}

async function openBook(
  book: BookSummary,
  options: { updateHistory?: "push" | "replace" | "none" } = {},
) {
  const { updateHistory = "none" } = options;

  if (viewerState.currentBook?.filePath !== book.filePath) {
    activeReadingPosition = captureReadingPositionFromViewer();
    await flushReadingPositionSave();
    await flushPendingNoteSave();
    await destroyNoteEditor();
  }

  viewerState.currentBook = book;

  if (updateHistory !== "none") {
    syncNavigationHistory(updateHistory);
  }

  await loadReadingPositionForCurrentBook();
  await loadViewerSettingsForCurrentBook();
  renderApp();
  await loadNoteForCurrentBook();
}

function renderSidebar(snapshot: LibrarySnapshot) {
  const navEl = document.querySelector<HTMLElement>("#sidebar-nav");
  if (!navEl) {
    return;
  }

  navEl.innerHTML = "";

  const directoryHeader = document.createElement("p");
  directoryHeader.className = "nav-section-title";
  directoryHeader.innerHTML =
    '<i class="fa-solid fa-folder" aria-hidden="true"></i><span>Directories</span>';
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
      void navigateToState(
        {
          bookFilePath: null,
          activeDirectory: node.path,
          activeTag: null,
          activeExternalSource: null,
          activeTagDirectOnly: false,
          searchQuery: viewerState.searchQuery,
        },
        "push",
      );
      ensureExpandedPath(node.path);
    });

    if (node.hasChildren) {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "nav-toggle";
      toggle.textContent = viewerState.expandedDirectories.has(node.path) ? "▾" : "▸";
      toggle.setAttribute("aria-label", `Expand or collapse ${node.label}`);
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
  futureHeader.innerHTML = '<i class="fa-solid fa-tags" aria-hidden="true"></i><span>Tags</span>';
  navEl.appendChild(futureHeader);

  for (const tag of deriveTags(snapshot.books)) {
    if (!isTagVisible(tag.id, tag.depth)) {
      continue;
    }

    const row = document.createElement("div");
    row.className = "nav-tree-row";
    row.style.setProperty("--depth", String(tag.depth));

    const labelEl = document.createElement("span");
    labelEl.textContent = tag.label;

    const countEl = document.createElement("small");
    countEl.textContent = String(tag.count);

    if (tag.hasChildren) {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "nav-toggle";
      toggle.textContent = viewerState.expandedTags.has(tag.id) ? "▾" : "▸";
      toggle.setAttribute("aria-label", `Expand or collapse ${tag.id}`);
      toggle.addEventListener("click", (event) => {
        event.stopPropagation();
        if (viewerState.expandedTags.has(tag.id)) {
          viewerState.expandedTags.delete(tag.id);
        } else {
          viewerState.expandedTags.add(tag.id);
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

    const button = document.createElement("button");
    button.type = "button";
    button.className = "nav-link nav-tree-link";
    button.classList.toggle("nav-placeholder", !tag.explicit);
    button.classList.toggle("is-active", viewerState.activeTag === tag.id);
    button.title = tag.id;
    button.appendChild(labelEl);
    button.appendChild(countEl);
    button.addEventListener("click", () => {
      void navigateToState(
        {
          bookFilePath: null,
          activeDirectory: null,
          activeTag: tag.id,
          activeExternalSource: null,
          activeTagDirectOnly: false,
          searchQuery: viewerState.searchQuery,
        },
        "push",
      );
      ensureExpandedTag(tag.id);
    });
    row.appendChild(button);

    navEl.appendChild(row);
  }

  const externalBooks = snapshot.books.filter((book) => book.sourceType !== "pdf");
  if (externalBooks.length > 0) {
    const externalHeader = document.createElement("p");
    externalHeader.className = "nav-section-title";
    externalHeader.innerHTML =
      '<i class="fa-solid fa-up-right-from-square" aria-hidden="true"></i><span>EXTERNAL</span>';
    navEl.appendChild(externalHeader);

    const kindleCount = externalBooks.filter((book) => book.sourceType === "kindle").length;
    if (kindleCount > 0) {
      const row = document.createElement("div");
      row.className = "nav-tree-row";
      row.style.setProperty("--depth", "0");

      const spacer = document.createElement("span");
      spacer.className = "nav-toggle-spacer";
      spacer.setAttribute("aria-hidden", "true");
      row.appendChild(spacer);

      const button = document.createElement("button");
      button.type = "button";
      button.className = "nav-link nav-tree-link";
      button.classList.toggle("is-active", viewerState.activeExternalSource === "kindle");
      button.innerHTML =
        '<span><i class="fa-brands fa-amazon" aria-hidden="true"></i> Kindle</span><small>' +
        String(kindleCount) +
        "</small>";
      button.addEventListener("click", () => {
        void navigateToState(
          {
            bookFilePath: null,
            activeDirectory: null,
            activeTag: null,
            activeExternalSource: "kindle",
            activeTagDirectOnly: false,
            searchQuery: viewerState.searchQuery,
          },
          "push",
        );
      });
      row.appendChild(button);
      navEl.appendChild(row);
    }
  }
}

function renderBookList(books: BookSummary[], container: HTMLElement) {
  container.innerHTML = "";

  if (books.length === 0) {
    const snapshot = lastSnapshot;
    const emptyEl = document.createElement("div");
    emptyEl.className = "empty-state";
    const state = snapshot
      ? describeEmptyLibraryState(snapshot, books)
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
    pathEl.textContent = book.locationLabel ?? formatBookLocation(book.filePath, cachedHomeDir);

    const metaEl = document.createElement("small");
    metaEl.className = "book-meta";
    metaEl.textContent = book.sourceType === "pdf" ? formatFileSize(book.fileSize) : "Kindle book";

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
    bodyEl.appendChild(pathEl);
    tagsRowEl.appendChild(tagsEl);
    actionsEl.appendChild(editMetadataEl);
    actionsEl.appendChild(editTagsEl);
    tagsRowEl.appendChild(actionsEl);
    bodyEl.appendChild(tagsRowEl);
    bodyEl.appendChild(metaEl);
    itemEl.appendChild(thumbEl);
    itemEl.appendChild(bodyEl);

    itemEl.addEventListener("click", () => {
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
          activeTagDirectOnly: viewerState.activeTagDirectOnly,
          searchQuery: viewerState.searchQuery,
        },
        "push",
      );
    });
    itemEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
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
            activeTagDirectOnly: viewerState.activeTagDirectOnly,
            searchQuery: viewerState.searchQuery,
          },
          "push",
        );
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

  if (tagDirectFilterEl && tagDirectOnlyEl) {
    const shouldShow = Boolean(viewerState.activeTag && selectedTagNode?.hasChildren);
    tagDirectFilterEl.hidden = !shouldShow;
    tagDirectOnlyEl.checked = viewerState.activeTagDirectOnly;
  }

  if (viewerOverlayControlsEl) {
    viewerOverlayControlsEl.hidden = !viewerState.currentBook;
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
  syncTagEditorUi();
  syncBookMetadataEditorUi();
}

window.addEventListener("DOMContentLoaded", async () => {
  await primeHomeDirCache();
  const searchInput = document.querySelector<HTMLInputElement>("#library-search");
  const viewerStageEl = currentViewerStage();
  const navBackEl = document.querySelector<HTMLButtonElement>("#nav-back");
  const navForwardEl = document.querySelector<HTMLButtonElement>("#nav-forward");
  const sidebarToggleEl = document.querySelector<HTMLButtonElement>("#sidebar-toggle");
  const sidebarHomeOpenEl = document.querySelector<HTMLButtonElement>("#sidebar-home-open");
  const appSettingsOpenEl = document.querySelector<HTMLButtonElement>("#app-settings-open");
  const appAboutOpenEl = document.querySelector<HTMLButtonElement>("#app-about-open");
  const appAboutCloseEl = document.querySelector<HTMLButtonElement>("#app-about-close");
  const appAboutDoneEl = document.querySelector<HTMLButtonElement>("#app-about-done");
  const appAboutBackdropEl = document.querySelector<HTMLElement>("#app-about-backdrop");
  const appSettingsCloseEl = document.querySelector<HTMLButtonElement>("#app-settings-close");
  const appSettingsCancelEl = document.querySelector<HTMLButtonElement>("#app-settings-cancel");
  const appSettingsSaveEl = document.querySelector<HTMLButtonElement>("#app-settings-save");
  const appSettingsBackdropEl = document.querySelector<HTMLElement>("#app-settings-backdrop");
  const appSettingsAddRootEl = document.querySelector<HTMLButtonElement>(
    "#config-library-roots-add",
  );
  const libraryAddKindleEl = document.querySelector<HTMLButtonElement>("#library-add-kindle");
  const noteToggleEl = document.querySelector<HTMLButtonElement>("#note-toggle");
  const noteCloseEl = document.querySelector<HTMLButtonElement>("#note-close");
  const viewerTagsOpenEl = document.querySelector<HTMLButtonElement>("#viewer-tags-open");
  const viewerMetadataOpenEl = document.querySelector<HTMLButtonElement>("#viewer-metadata-open");
  const viewerSettingsToggleEl =
    document.querySelector<HTMLButtonElement>("#viewer-settings-toggle");
  const viewerPageJumpFormEl = document.querySelector<HTMLFormElement>("#viewer-page-jump-form");
  const viewerPageJumpInputEl = document.querySelector<HTMLInputElement>("#viewer-page-jump-input");
  const viewerSettingsPanelEl = document.querySelector<HTMLElement>("#viewer-settings-panel");
  const viewerSettingsScopeGlobalEl = document.querySelector<HTMLButtonElement>(
    "#viewer-settings-scope-global",
  );
  const viewerSettingsScopeFileEl = document.querySelector<HTMLButtonElement>(
    "#viewer-settings-scope-file",
  );
  const viewerPageModeEl = document.querySelector<HTMLSelectElement>("#viewer-page-mode");
  const viewerBindingEl = document.querySelector<HTMLSelectElement>("#viewer-binding-direction");
  const viewerZoomModeEl = document.querySelector<HTMLSelectElement>("#viewer-zoom-mode");
  const viewerAlignModeEl = document.querySelector<HTMLSelectElement>("#viewer-align-mode");
  const viewerVerticalGapModeEl = document.querySelector<HTMLSelectElement>(
    "#viewer-vertical-gap-mode",
  );
  const viewerCoverModeEl = document.querySelector<HTMLInputElement>("#viewer-cover-mode");
  const tagDirectOnlyEl = document.querySelector<HTMLInputElement>("#tag-direct-only");
  const noteDragHandleEl = document.querySelector<HTMLElement>("#note-drag-handle");
  const noteResizeEls = document.querySelectorAll<HTMLElement>(".note-resize-handle");
  const tagEditorBackdropEl = document.querySelector<HTMLElement>("#tag-editor-backdrop");
  const tagEditorCloseEl = document.querySelector<HTMLButtonElement>("#tag-editor-close");
  const tagEditorCancelEl = document.querySelector<HTMLButtonElement>("#tag-editor-cancel");
  const tagEditorSaveEl = document.querySelector<HTMLButtonElement>("#tag-editor-save");
  const tagEditorAddEl = document.querySelector<HTMLButtonElement>("#tag-editor-add");
  const tagEditorInputEl = document.querySelector<HTMLInputElement>("#tag-editor-input");
  const bookMetadataBackdropEl = document.querySelector<HTMLElement>("#book-metadata-backdrop");
  const bookMetadataCloseEl = document.querySelector<HTMLButtonElement>("#book-metadata-close");
  const bookMetadataCancelEl = document.querySelector<HTMLButtonElement>("#book-metadata-cancel");
  const bookMetadataSaveEl = document.querySelector<HTMLButtonElement>("#book-metadata-save");
  const bookMetadataImportEl = document.querySelector<HTMLTextAreaElement>("#book-metadata-import");
  const bookMetadataImportApplyEl = document.querySelector<HTMLButtonElement>(
    "#book-metadata-import-apply",
  );
  const bookMetadataTitleEl = document.querySelector<HTMLInputElement>("#book-metadata-title");
  const bookMetadataAuthorsEl =
    document.querySelector<HTMLTextAreaElement>("#book-metadata-authors");
  const bookMetadataDescriptionEl = document.querySelector<HTMLTextAreaElement>(
    "#book-metadata-description",
  );
  const bookMetadataPublisherEl = document.querySelector<HTMLInputElement>(
    "#book-metadata-publisher",
  );
  const bookMetadataReleaseDateEl = document.querySelector<HTMLInputElement>(
    "#book-metadata-release-date",
  );
  const bookMetadataLanguageEl =
    document.querySelector<HTMLInputElement>("#book-metadata-language");
  const bookMetadataUrlEl = document.querySelector<HTMLInputElement>("#book-metadata-url");
  const bookMetadataAsinEl = document.querySelector<HTMLInputElement>("#book-metadata-asin");
  const bookMetadataCoverUrlEl = document.querySelector<HTMLInputElement>(
    "#book-metadata-cover-url",
  );

  searchInput?.addEventListener("input", () => {
    void navigateToState(
      {
        bookFilePath: null,
        activeDirectory: null,
        activeTag: null,
        activeExternalSource: null,
        activeTagDirectOnly: false,
        searchQuery: searchInput.value.trim(),
      },
      "replace",
    );
  });

  navBackEl?.addEventListener("click", () => {
    navigateBack();
  });

  navForwardEl?.addEventListener("click", () => {
    navigateForward();
  });

  viewerPageJumpInputEl?.addEventListener("input", () => {
    viewerPageJumpState.input = viewerPageJumpInputEl.value;
  });

  viewerPageJumpInputEl?.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      const currentPageNumber = currentViewerPageNumber();
      viewerPageJumpState.input = currentPageNumber === null ? "" : String(currentPageNumber);
      syncViewerPageJumpUi();
      viewerPageJumpInputEl.blur();
    }
  });

  viewerPageJumpInputEl?.addEventListener("focus", () => {
    viewerPageJumpInputEl.select();
  });

  viewerPageJumpInputEl?.addEventListener("blur", () => {
    const currentPageNumber = currentViewerPageNumber();
    viewerPageJumpState.input = currentPageNumber === null ? "" : String(currentPageNumber);
    syncViewerPageJumpUi();
  });

  viewerPageJumpFormEl?.addEventListener("submit", (event) => {
    event.preventDefault();
    const pageNumber = parseRequestedPageNumber(viewerPageJumpState.input);
    if (pageNumber === null) {
      const currentPageNumber = currentViewerPageNumber();
      viewerPageJumpState.input = currentPageNumber === null ? "" : String(currentPageNumber);
      syncViewerPageJumpUi();
      return;
    }

    navigateViewerToPage(pageNumber);
    viewerPageJumpInputEl?.blur();
  });

  viewerStageEl?.addEventListener("scroll", () => {
    if (lastSnapshot?.pdfRenderer !== "pdfjs" || !viewerState.currentBook) {
      return;
    }

    scheduleReadingPositionSave();
    if (activePdfRenderSession) {
      schedulePdfRenderWindowUpdate(activePdfRenderSession);
    }
  });

  sidebarToggleEl?.addEventListener("click", () => {
    viewerState.sidebarCollapsed = !viewerState.sidebarCollapsed;
    renderApp();
  });

  sidebarHomeOpenEl?.addEventListener("click", () => {
    void navigateToState(
      {
        bookFilePath: null,
        activeDirectory: null,
        activeTag: null,
        activeExternalSource: null,
        activeTagDirectOnly: false,
        searchQuery: "",
      },
      "push",
    );
  });

  libraryAddKindleEl?.addEventListener("click", () => {
    openNewKindleBookEditor();
  });

  tagDirectOnlyEl?.addEventListener("change", () => {
    void navigateToState(
      {
        bookFilePath: null,
        activeDirectory: null,
        activeTag: viewerState.activeTag,
        activeExternalSource: viewerState.activeExternalSource,
        activeTagDirectOnly: tagDirectOnlyEl.checked,
        searchQuery: viewerState.searchQuery,
      },
      "replace",
    );
  });

  const closeAppSettings = () => {
    viewerState.isAppSettingsOpen = false;
    setAppSettingsStatus("");
    syncAppSettingsUi();
  };

  const closeAbout = () => {
    viewerState.isAboutOpen = false;
    syncAboutUi();
  };

  appSettingsOpenEl?.addEventListener("click", async () => {
    viewerState.isAppSettingsOpen = true;
    setAppSettingsStatus("");
    syncAppSettingsUi();
    try {
      await loadAppConfig();
    } catch (error) {
      setAppSettingsStatus(`Failed to load settings: ${String(error)}`, "error");
    }
  });

  appSettingsCloseEl?.addEventListener("click", closeAppSettings);
  appSettingsCancelEl?.addEventListener("click", closeAppSettings);
  appSettingsBackdropEl?.addEventListener("click", closeAppSettings);
  appSettingsSaveEl?.addEventListener("click", () => {
    void saveAppSettingsFromForm();
  });

  appSettingsAddRootEl?.addEventListener("click", async () => {
    const defaultPath = lastAppConfig?.libraryRoots[lastAppConfig.libraryRoots.length - 1] ?? "~/";

    try {
      const selected = await open({
        directory: true,
        multiple: false,
        defaultPath,
        title: "Choose a library folder",
      });

      if (!selected) {
        return;
      }

      const normalizedSelection = Array.isArray(selected) ? selected[0] : selected;
      if (!normalizedSelection) {
        return;
      }

      const collapsedSelection = await collapseHomePath(normalizedSelection);
      const currentRoots = addLibraryRoot(lastAppConfig?.libraryRoots ?? [], collapsedSelection);
      lastAppConfig = {
        configPath: lastAppConfig?.configPath ?? "",
        configExists: lastAppConfig?.configExists ?? false,
        libraryRoots: currentRoots,
        excludedPatterns: lastAppConfig?.excludedPatterns ?? [],
        pdfRenderer: lastAppConfig?.pdfRenderer ?? "native",
      };
      syncAppSettingsUi();
    } catch (error) {
      setAppSettingsStatus(`Failed to choose a folder: ${String(error)}`, "error");
    }
  });

  appAboutOpenEl?.addEventListener("click", () => {
    viewerState.isAboutOpen = true;
    syncAboutUi();
    if (
      cachedThirdPartyRustText === "Loading Rust notices..." ||
      cachedThirdPartyJsText === "Loading JavaScript notices..."
    ) {
      void loadThirdPartyLicenses().then(() => {
        syncAboutUi();
      });
    }
  });

  appAboutCloseEl?.addEventListener("click", closeAbout);
  appAboutDoneEl?.addEventListener("click", closeAbout);
  appAboutBackdropEl?.addEventListener("click", closeAbout);

  viewerTagsOpenEl?.addEventListener("click", () => {
    if (viewerState.currentBook) {
      openTagEditor(viewerState.currentBook);
    }
  });

  viewerMetadataOpenEl?.addEventListener("click", () => {
    if (viewerState.currentBook) {
      void openBookMetadataEditor(viewerState.currentBook);
    }
  });

  tagEditorCloseEl?.addEventListener("click", closeTagEditor);
  tagEditorCancelEl?.addEventListener("click", closeTagEditor);
  tagEditorBackdropEl?.addEventListener("click", closeTagEditor);
  tagEditorAddEl?.addEventListener("click", addTagFromEditorInput);
  tagEditorSaveEl?.addEventListener("click", () => {
    void saveTagEditorChanges();
  });
  bookMetadataCloseEl?.addEventListener("click", closeBookMetadataEditor);
  bookMetadataCancelEl?.addEventListener("click", closeBookMetadataEditor);
  bookMetadataBackdropEl?.addEventListener("click", closeBookMetadataEditor);
  bookMetadataSaveEl?.addEventListener("click", () => {
    void saveBookMetadataChanges();
  });
  bookMetadataImportApplyEl?.addEventListener("click", importBookMetadataFromJson);
  bookMetadataImportEl?.addEventListener("input", () => {
    bookMetadataEditorState.importText = bookMetadataImportEl.value;
  });
  bookMetadataTitleEl?.addEventListener("input", () => {
    bookMetadataEditorState.title = bookMetadataTitleEl.value;
  });
  bookMetadataAuthorsEl?.addEventListener("input", () => {
    bookMetadataEditorState.authorsText = bookMetadataAuthorsEl.value;
  });
  bookMetadataDescriptionEl?.addEventListener("input", () => {
    bookMetadataEditorState.description = bookMetadataDescriptionEl.value;
  });
  bookMetadataPublisherEl?.addEventListener("input", () => {
    bookMetadataEditorState.publisher = bookMetadataPublisherEl.value;
  });
  bookMetadataReleaseDateEl?.addEventListener("input", () => {
    bookMetadataEditorState.releaseDate = bookMetadataReleaseDateEl.value;
  });
  bookMetadataLanguageEl?.addEventListener("input", () => {
    bookMetadataEditorState.language = bookMetadataLanguageEl.value;
  });
  bookMetadataUrlEl?.addEventListener("input", () => {
    bookMetadataEditorState.url = bookMetadataUrlEl.value;
  });
  bookMetadataAsinEl?.addEventListener("input", () => {
    bookMetadataEditorState.asin = bookMetadataAsinEl.value;
  });
  bookMetadataCoverUrlEl?.addEventListener("input", () => {
    bookMetadataEditorState.coverUrl = bookMetadataCoverUrlEl.value;
  });
  tagEditorInputEl?.addEventListener("input", () => {
    tagEditorState.input = tagEditorInputEl.value;
    syncTagEditorUi();
  });
  tagEditorInputEl?.addEventListener("compositionstart", () => {
    isTagEditorComposing = true;
  });
  tagEditorInputEl?.addEventListener("compositionend", () => {
    isTagEditorComposing = false;
  });
  tagEditorInputEl?.addEventListener("keydown", (event) => {
    if (
      event.key === "Enter" &&
      !event.isComposing &&
      !isTagEditorComposing &&
      event.keyCode !== 229
    ) {
      event.preventDefault();
      addTagFromEditorInput();
    }
  });

  viewerSettingsToggleEl?.addEventListener("click", () => {
    const isOpening = !viewerSettings.isSettingsOpen;
    viewerSettings.isSettingsOpen = isOpening;
    if (isOpening) {
      viewerSettings.scope = "file";
    }
    syncViewerSettingsUi();
  });

  const rerenderPdfJs = () => {
    syncViewerSettingsUi();
    if (lastSnapshot?.pdfRenderer === "pdfjs" && viewerState.currentBook) {
      void renderCurrentPage();
    }
  };

  const persistViewerSettings = async () => {
    const currentFilePath = viewerState.currentBook?.filePath ?? null;

    if (viewerSettings.scope === "file" && currentFilePath) {
      const payload = await invoke<ViewerSettingsPayload>("save_file_viewer_preferences", {
        filePath: currentFilePath,
        preferences: currentViewerPreferences(),
      });
      applyViewerSettingsPayload(payload, "file");
      return;
    }

    const payload = await invoke<ViewerSettingsPayload>("save_default_viewer_preferences", {
      currentFilePath,
      preferences: currentViewerPreferences(),
    });
    applyViewerSettingsPayload(payload, "global");
  };

  const updateViewerSettings = (mutate: () => void) => {
    mutate();
    void persistViewerSettings()
      .catch((error) => {
        console.error("Failed to save viewer preferences:", error);
      })
      .finally(() => {
        rerenderPdfJs();
      });
  };

  const switchViewerSettingsScope = (requestedScope: ViewerSettingsScope) => {
    const nextState = switchViewerSettingsScopeInState(viewerSettings, requestedScope);
    viewerSettings.scope = nextState.scope;
    viewerSettings.fileDraft = nextState.fileDraft;
    syncViewerSettingsUi();
  };

  const mutateEditingViewerSettings = (mutate: (preferences: ViewerSettings) => void) => {
    const nextPreferences = { ...currentViewerPreferences() };
    mutate(nextPreferences);
    setViewerDraft(viewerSettings.scope, nextPreferences);
  };

  viewerSettingsScopeGlobalEl?.addEventListener("click", () => {
    switchViewerSettingsScope("global");
  });

  viewerSettingsScopeFileEl?.addEventListener("click", () => {
    switchViewerSettingsScope("file");
  });

  viewerPageModeEl?.addEventListener("change", () => {
    updateViewerSettings(() => {
      mutateEditingViewerSettings((preferences) => {
        preferences.pageMode = viewerPageModeEl.value as ViewerSettings["pageMode"];
      });
    });
  });

  viewerBindingEl?.addEventListener("change", () => {
    updateViewerSettings(() => {
      mutateEditingViewerSettings((preferences) => {
        preferences.bindingDirection = viewerBindingEl.value as ViewerSettings["bindingDirection"];
      });
    });
  });

  viewerZoomModeEl?.addEventListener("change", () => {
    updateViewerSettings(() => {
      mutateEditingViewerSettings((preferences) => {
        preferences.zoomMode = viewerZoomModeEl.value as ViewerSettings["zoomMode"];
      });
    });
  });

  viewerAlignModeEl?.addEventListener("change", () => {
    updateViewerSettings(() => {
      mutateEditingViewerSettings((preferences) => {
        preferences.alignMode = viewerAlignModeEl.value as ViewerSettings["alignMode"];
      });
    });
  });

  viewerVerticalGapModeEl?.addEventListener("change", () => {
    updateViewerSettings(() => {
      mutateEditingViewerSettings((preferences) => {
        preferences.verticalGapMode =
          viewerVerticalGapModeEl.value as ViewerSettings["verticalGapMode"];
      });
    });
  });

  viewerCoverModeEl?.addEventListener("change", () => {
    updateViewerSettings(() => {
      mutateEditingViewerSettings((preferences) => {
        preferences.treatFirstPageAsCover = viewerCoverModeEl.checked;
      });
    });
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

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && tagEditorState.isOpen) {
      closeTagEditor();
      return;
    }

    if (event.key === "Escape" && viewerState.isAboutOpen) {
      closeAbout();
      return;
    }

    if (event.key === "Escape" && viewerState.isAppSettingsOpen) {
      closeAppSettings();
      return;
    }

    if (isEditableTarget(event.target)) {
      return;
    }

    const shortcutInput = {
      platform: navigator.platform,
      key: event.key,
      metaKey: event.metaKey,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
    };
    const wantsBack = isNavigationBackShortcut(shortcutInput);
    const wantsForward = isNavigationForwardShortcut(shortcutInput);

    if (wantsBack) {
      event.preventDefault();
      navigateBack();
      return;
    }

    if (wantsForward) {
      event.preventDefault();
      navigateForward();
    }
  });

  window.addEventListener("resize", () => {
    if (shouldAnchorNoteWindowToBottomRight()) {
      const nextState = preserveNoteWindowBottomRightOffset(noteState, lastViewportSize, {
        width: window.innerWidth,
        height: window.innerHeight,
      });
      noteState.x = nextState.x;
      noteState.y = nextState.y;
    }

    clampNoteWindow();
    syncNoteUi();
    lastViewportSize = {
      width: window.innerWidth,
      height: window.innerHeight,
    };

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
    activeReadingPosition = captureReadingPositionFromViewer();
    void flushReadingPositionSave();
    if (noteSaveTimer !== null) {
      window.clearTimeout(noteSaveTimer);
    }
  });

  await listen<LibrarySnapshot>("library-updated", (event) => {
    lastSnapshot = event.payload;
    viewerState.libraryErrorMessage = null;
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
    console.error("library-watch-error", event.payload);
  });

  await listen<{ filePath: string; thumbnailPath: string }>("thumbnail-ready", (event) => {
    applyThumbnail(event.payload.filePath, event.payload.thumbnailPath);
  });

  window.addEventListener("popstate", (event) => {
    const state = event.state as NavigationState | null;
    const nextState: NavigationState = state ?? {
      historyIndex: 0,
      bookFilePath: null,
      activeDirectory: null,
      activeTag: null,
      activeExternalSource: null,
      activeTagDirectOnly: false,
      searchQuery: "",
    };

    if (navigationEntries.length === 0) {
      navigationEntries = [{ ...nextState, historyIndex: 0 }];
    }

    navigationHistoryIndex = Math.max(
      0,
      Math.min(nextState.historyIndex ?? 0, navigationEntries.length - 1),
    );
    navigationHistoryMax = Math.max(0, navigationEntries.length - 1);
    syncNavigationControlsUi();

    suppressHistoryUpdates = true;
    void applyNavigationState(nextState).finally(() => {
      suppressHistoryUpdates = false;
    });
  });

  invoke<LibrarySnapshot>("library_snapshot")
    .then((snapshot) => {
      lastSnapshot = snapshot;
      viewerState.libraryErrorMessage = null;
      viewerState.books = snapshot.books;
      const params = new URLSearchParams(window.location.search);
      const initialState: NavigationState = {
        historyIndex: 0,
        bookFilePath: params.get("book"),
        activeDirectory: params.get("dir"),
        activeTag: params.get("tag"),
        activeExternalSource: params.get("source"),
        activeTagDirectOnly: params.get("tagMode") === "direct",
        searchQuery: params.get("q") ?? "",
      };

      navigationEntries = [{ ...initialState, historyIndex: 0 }];
      navigationHistoryIndex = 0;
      navigationHistoryMax = 0;
      syncNavigationControlsUi();
      suppressHistoryUpdates = true;
      void applyNavigationState(initialState).finally(() => {
        suppressHistoryUpdates = false;
        syncNavigationHistory("replace");
      });
    })
    .catch((error) => {
      viewerState.libraryErrorMessage = "Failed to load the library.";
      renderApp();
      console.error("failed to load library snapshot", error);
    });

  try {
    await loadAppConfig();
  } catch (error) {
    console.error("failed to load app config", error);
  }

  try {
    cachedAppName = await getName();
    cachedAppVersion = await getVersion();
  } catch (error) {
    console.error("failed to load app metadata", error);
  }
  syncAboutUi();
});
