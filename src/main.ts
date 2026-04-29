import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getName, getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { homeDir } from "@tauri-apps/api/path";
import { confirm, message, open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import "./vendor/fontawesome/css/fontawesome.min.css";
import "./vendor/fontawesome/css/brands.min.css";
import "./vendor/fontawesome/css/regular.min.css";
import "./vendor/fontawesome/css/solid.min.css";
import type { NoteEditorHandle } from "./note-editor";
import {
  addLibraryRoot,
  buildAppConfigDraft,
  normalizeAppTheme,
  type AppTheme,
} from "./app-config-utils";
import {
  applyBookMetadataImport,
  BOOK_METADATA_IMPORT_EXAMPLE,
  isBookMetadataDraftEmpty,
  joinMetadataAuthors,
  normalizeMetadataAuthorsText,
  normalizeReleaseDateInput,
  parseBookMetadataImport,
  validateBookMetadataDraft,
} from "./book-metadata-utils";
import {
  clampEpubPageNumber,
  epubLocationIndexFromPageNumber,
  epubPageNumberFromLocation,
} from "./epub-page-utils";
import { resolveEpubLinkAction } from "./epub-link-routing";
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
import {
  applySuggestion,
  buildValueSource,
  computeSuggestions,
  type SearchSuggestion,
} from "./search-suggestions";
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
import { planPagedKeyAction } from "./pdf-paged-nav-utils";
import {
  applyViewerSettingsPayloadToState,
  switchViewerSettingsScopeInState,
} from "./viewer-settings-utils";
import { CJK_RADICAL_MAP } from "./cjk-radical-map";

type CustomSource = {
  id: string;
  name: string;
  icon: string;
};

type BookSummary = {
  fileName: string;
  title: string | null;
  filePath: string;
  fileSize: number;
  tags: string[];
  authors: string[];
  sourceType: string;
  coverUrl: string | null;
  locationLabel: string | null;
  isOpenable: boolean;
  asin: string | null;
  url: string | null;
  publisher: string | null;
  language: string | null;
  lastReadAt: number | null;
};

type LibrarySnapshot = {
  libraryRoots: string[];
  existingLibraryRoots: string[];
  missingLibraryRoots: string[];
  indexedCount: number;
  books: BookSummary[];
  excludedPatterns: string[];
  pdfRenderer: "native" | "pdfjs";
  customSources: CustomSource[];
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
  cfi?: string | null;
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
  theme: AppTheme;
  enabledExternalSources: string[];
};

type ViewerSourceType = "pdf" | "epub";
type ViewerBackgroundMode = "inherit-theme" | "default" | "snow-white" | "night-city" | "navy-blue";
type ViewerColorPalette = {
  background: string;
  foreground: string;
  link: string;
};

type ViewerSettings = {
  pageMode: "single" | "spread";
  bindingDirection: "left" | "right";
  zoomMode: "fit-width" | "fit-height" | "original";
  alignMode: "left" | "center" | "right";
  verticalGapMode: "wide" | "compact" | "none";
  treatFirstPageAsCover: boolean;
  backgroundMode: ViewerBackgroundMode;
  scrollMode: "continuous" | "paged";
  epubFontSize: number;
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
  sourceType: ViewerSourceType;
};

type NavigationState = {
  historyIndex: number;
  bookFilePath: string | null;
  epubCfi?: string | null;
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
  sourceType: string;
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

type PdfSearchNormChar = {
  itemIndex: number;
  origOffset: number;
  origOffsetEnd: number;
};

type PdfSearchPageIndex = {
  normalizedText: string;
  normChars: PdfSearchNormChar[];
};

type PdfSearchMatch = {
  pageNumber: number;
  normalizedStart: number;
  normalizedEnd: number;
};

type PdfOutlineNode = {
  title: string;
  dest: string | unknown[] | null;
  items: PdfOutlineNode[];
};

type PdfRenderSession = {
  token: number;
  pdfDocument: {
    numPages: number;
    getPage: (pageNumber: number) => Promise<any>;
    getDestination?: (destinationId: string) => Promise<unknown>;
    getPageIndex?: (pageRef: any) => Promise<number>;
    getOutline?: () => Promise<PdfOutlineNode[] | null>;
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
  backgroundMode: "inherit-theme",
  scrollMode: "paged",
  epubFontSize: 100,
};

const viewerSettings: ViewerSettingsState = {
  ...DEFAULT_VIEWER_SETTINGS,
  globalDraft: { ...DEFAULT_VIEWER_SETTINGS },
  fileDraft: { ...DEFAULT_VIEWER_SETTINGS },
  scope: "file",
  hasFileOverride: false,
  treatFirstPageAsCover: true,
  isSettingsOpen: false,
  sourceType: "pdf",
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
let epubRenderToken = 0;
let activeEpubBook: import("epubjs").Book | null = null;
let activeEpubRendition: import("epubjs").Rendition | null = null;
let activeEpubLinkMessageHandler: ((event: MessageEvent) => void) | null = null;
let activeEpubTotalPages: number | null = null;
// True when the active EPUB's spine page-progression-direction is "rtl".
// DPFJ guide §ページ進行方向の遵守: page direction is governed by OPF spine, not writing-mode.
// In rtl books, ArrowLeft advances the reading order (next page) while ArrowRight goes back.
let activeEpubIsRtl = false;
let tocPanelOpen = false;
let activePdfOutline: PdfOutlineNode[] | null = null;
let viewerSettingsLoadToken = 0;
const pdfSearchState: {
  isOpen: boolean;
  query: string;
  pageIndices: Map<number, PdfSearchPageIndex>;
  matches: PdfSearchMatch[];
  currentMatchIndex: number;
  searchTimer: number | null;
} = {
  isOpen: false,
  query: "",
  pageIndices: new Map(),
  matches: [],
  currentMatchIndex: -1,
  searchTimer: null,
};
let readingPositionSaveTimer: number | null = null;
let suppressHistoryUpdates = false;
let navigationHistoryIndex = 0;
let navigationHistoryMax = 0;
let navigationEntries: NavigationState[] = [];
let activeReadingPosition: ReadingPosition | null = null;
let lastAppConfig: AppConfigPayload | null = null;
let cachedHomeDir: string | null = null;
let cachedAppName = "riida";
let cachedAppVersion = "0.3.4";
const buildDate = __BUILD_DATE__;
let cachedLicenseText = "Loading license text...";
let cachedThirdPartyRustText = "Loading Rust notices...";
let cachedThirdPartyJsText = "Loading JavaScript notices...";
const APP_THEME_STORAGE_KEY = "riida.appTheme";

function applyAppTheme(theme: AppTheme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme =
    theme === "night-city" || theme === "navy-blue" ? "dark" : "light";
}

function persistAppTheme(theme: AppTheme) {
  localStorage.setItem(APP_THEME_STORAGE_KEY, theme);
}

function normalizeViewerSourceType(sourceType: string | null | undefined): ViewerSourceType {
  return sourceType === "epub" ? "epub" : "pdf";
}

function currentViewerSettingsSourceType(): ViewerSourceType | null {
  const currentBook = viewerState.currentBook;
  if (!currentBook) {
    return null;
  }

  return normalizeViewerSourceType(currentBook.sourceType);
}

function resolveViewerThemeMode(
  backgroundMode: ViewerBackgroundMode,
): Exclude<ViewerBackgroundMode, "inherit-theme"> {
  if (backgroundMode !== "inherit-theme") {
    return backgroundMode;
  }

  return normalizeAppTheme(lastAppConfig?.theme ?? "default");
}

function viewerColorPaletteForMode(backgroundMode: ViewerBackgroundMode): ViewerColorPalette {
  switch (resolveViewerThemeMode(backgroundMode)) {
    case "snow-white":
      return {
        background: "#f5f5f7",
        foreground: "#222226",
        link: "#006ee6",
      };
    case "night-city":
      return {
        background: "#101114",
        foreground: "#f2f2f7",
        link: "#5db2ff",
      };
    case "navy-blue":
      return {
        background: "#18314f",
        foreground: "#e5edf7",
        link: "#9fc5ff",
      };
    default:
      return {
        background: "rgb(244 234 212)",
        foreground: "#2b2118",
        link: "#7d4e21",
      };
  }
}

function applyPdfViewerBackground(backgroundMode: ViewerBackgroundMode) {
  const palette = viewerColorPaletteForMode(backgroundMode);

  const applyBackgroundStyles = (el: HTMLElement | null) => {
    if (!el) {
      return;
    }

    el.style.backgroundColor = palette.background;
  };

  const mainPaneEl = document.querySelector<HTMLElement>("#main-pane");
  if (backgroundMode === "inherit-theme") {
    mainPaneEl?.style.removeProperty("background-color");
    return;
  }

  applyBackgroundStyles(mainPaneEl);
}

function applyEpubColorsToDocument(doc: Document, palette: ViewerColorPalette) {
  const root = doc.documentElement;
  const body = doc.body;

  root?.style.setProperty("background-color", palette.background, "important");
  root?.style.setProperty("color", palette.foreground, "important");
  body?.style.setProperty("background-color", palette.background, "important");
  body?.style.setProperty("color", palette.foreground, "important");

  const linkEls = doc.querySelectorAll<HTMLAnchorElement>("a[href]");
  for (const linkEl of linkEls) {
    linkEl.style.setProperty("color", palette.link, "important");
  }
}

// WKWebView does not recognize the -epub-writing-mode vendor prefix, so
// vertical-text EPUBs render horizontally. Scan each section's stylesheets and
// inject a companion <style> that mirrors every -epub-writing-mode declaration
// as a standard writing-mode declaration, which WKWebView does understand.
function injectEpubWritingModeCSS(doc: Document) {
  const EPUB_PROP = "-epub-writing-mode";
  const STD_PROP = "writing-mode";

  let extraRules = "";

  for (const styleEl of Array.from(doc.querySelectorAll("style"))) {
    const sheet = styleEl.sheet;
    if (!sheet) continue;
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSStyleRule)) continue;
      const epubVal = rule.style.getPropertyValue(EPUB_PROP).trim();
      if (!epubVal) continue;
      // Only add writing-mode if not already declared by the book's CSS.
      const alreadyHasStd = rule.style.getPropertyValue(STD_PROP).trim() !== "";
      if (alreadyHasStd) continue;
      extraRules += `${rule.selectorText}{${STD_PROP}:${epubVal}}\n`;
    }
  }

  // Also handle inline styles.
  for (const el of Array.from(doc.querySelectorAll<HTMLElement>("[style]"))) {
    const epubVal = el.style.getPropertyValue(EPUB_PROP).trim();
    if (!epubVal) continue;
    if (el.style.getPropertyValue(STD_PROP).trim() !== "") continue;
    el.style.setProperty(STD_PROP, epubVal);
  }

  if (extraRules) {
    const injected = doc.createElement("style");
    injected.dataset.riidaInjected = "writing-mode";
    injected.textContent = extraRules;
    (doc.head ?? doc.documentElement)?.appendChild(injected);
  }
}

// Overlay a full-bleed <img> on top of the epub viewer when the rendered
// section is a cover page. This sidesteps epub.js's multi-column layout,
// which constrains in-iframe images to a single column and makes them
// impossible to scale reliably via CSS alone.
function syncEpubCoverOverlay(epubViewerEl: HTMLElement) {
  const iframes = epubViewerEl.querySelectorAll<HTMLIFrameElement>("iframe");
  let coverSrc: string | null = null;
  let coverAlt = "";

  for (const iframe of iframes) {
    const body = iframe.contentDocument?.body;
    if (!body) continue;
    const epubType = body.getAttribute("epub:type") ?? "";
    const isCover = epubType.split(/\s+/).includes("cover") || body.classList.contains("coverimg");
    if (!isCover) {
      body.style.removeProperty("visibility");
      continue;
    }
    body.style.setProperty("visibility", "hidden", "important");
    const imgEl = body.querySelector<HTMLImageElement>("img");
    if (imgEl?.src && !coverSrc) {
      coverSrc = imgEl.src;
      coverAlt = imgEl.alt;
    }
  }

  let overlay = epubViewerEl.querySelector<HTMLImageElement>(":scope > .epub-cover-overlay");

  if (!coverSrc) {
    overlay?.remove();
    return;
  }

  if (!overlay) {
    overlay = document.createElement("img");
    overlay.className = "epub-cover-overlay";
    epubViewerEl.appendChild(overlay);
  }
  if (overlay.src !== coverSrc) {
    overlay.src = coverSrc;
  }
  overlay.alt = coverAlt;
}

function viewerExtraVerticalGap(mode: ViewerSettings["verticalGapMode"]): number {
  switch (mode) {
    case "wide":
      return 40;
    case "compact":
      return 16;
    default:
      return 0;
  }
}

function applyViewerVerticalGapMode(mode: ViewerSettings["verticalGapMode"]) {
  const extraGap = viewerExtraVerticalGap(mode);
  const pdfjsViewerEl = document.querySelector<HTMLElement>("#pdfjs-viewer");
  if (pdfjsViewerEl) {
    pdfjsViewerEl.dataset.verticalGap = mode;
    pdfjsViewerEl.style.setProperty("--viewer-extra-vertical-gap", `${extraGap}px`);
  }

  const epubViewerEl = document.querySelector<HTMLElement>("#epub-viewer");
  if (epubViewerEl) {
    epubViewerEl.dataset.verticalGap = mode;
    epubViewerEl.style.setProperty("--epub-vertical-gap", `${extraGap}px`);
    if (activeEpubRendition) {
      requestAnimationFrame(() => resizeEpubRendition());
    }
  }
}

function applyEpubViewerColors(backgroundMode: ViewerBackgroundMode) {
  const epubViewerEl = document.querySelector<HTMLElement>("#epub-viewer");
  const mainPaneEl = document.querySelector<HTMLElement>("#main-pane");
  const palette = viewerColorPaletteForMode(backgroundMode);

  if (backgroundMode === "inherit-theme") {
    mainPaneEl?.style.removeProperty("background-color");
    epubViewerEl?.style.removeProperty("background-color");
  } else {
    if (mainPaneEl) {
      mainPaneEl.style.backgroundColor = palette.background;
    }
    if (epubViewerEl) {
      epubViewerEl.style.backgroundColor = palette.background;
    }
  }

  const contentsList = activeEpubRendition
    ? ((activeEpubRendition.getContents() as unknown as import("epubjs").Contents[]) ?? [])
    : [];
  for (const contents of contentsList) {
    if (contents.document) {
      applyEpubColorsToDocument(contents.document, palette);
    }
  }
}

function applyEpubFontSize(fontSize: number) {
  if (!activeEpubRendition) return;
  activeEpubRendition.themes.fontSize(`${fontSize}%`);
}

function setCheckedViewerBackgroundOption(groupName: string, value: ViewerBackgroundMode) {
  const input = document.querySelector<HTMLInputElement>(
    `input[name="${groupName}"][value="${value}"]`,
  );
  if (input) {
    input.checked = true;
  }
}

function preferredExplicitViewerBackgroundMode(
  backgroundMode: ViewerBackgroundMode,
): Exclude<ViewerBackgroundMode, "inherit-theme"> {
  return resolveViewerThemeMode(backgroundMode);
}

function syncViewerBackgroundControls(
  groupName: string,
  inheritCheckboxId: string,
  backgroundMode: ViewerBackgroundMode,
) {
  const inheritCheckbox = document.querySelector<HTMLInputElement>(`#${inheritCheckboxId}`);
  const group = document.querySelector<HTMLElement>(`#${groupName}`);
  const isInherited = backgroundMode === "inherit-theme";
  const explicitMode = preferredExplicitViewerBackgroundMode(backgroundMode);

  if (inheritCheckbox) {
    inheritCheckbox.checked = isInherited;
  }

  setCheckedViewerBackgroundOption(groupName, explicitMode);
  group?.classList.toggle("is-disabled", isInherited);
}

function syncImmediatePdfBackgroundPreview() {
  const sourceType = currentViewerSettingsSourceType();
  if (sourceType === "pdf" && lastSnapshot?.pdfRenderer === "pdfjs") {
    applyPdfViewerBackground(currentViewerPreferences().backgroundMode);
    return;
  }

  if (sourceType === "epub") {
    applyEpubViewerColors(currentViewerPreferences().backgroundMode);
    return;
  }
}

function syncImmediateViewerLayoutPreview() {
  const sourceType = currentViewerSettingsSourceType();
  if (sourceType !== "pdf" && sourceType !== "epub") {
    return;
  }

  applyViewerVerticalGapMode(currentViewerPreferences().verticalGapMode);
}

function bindViewerBackgroundOptionGroup(
  groupName: string,
  onChange: (value: ViewerBackgroundMode) => void,
) {
  const inputs = document.querySelectorAll<HTMLInputElement>(`input[name="${groupName}"]`);
  for (const input of inputs) {
    input.addEventListener("change", () => {
      if (input.checked) {
        onChange(input.value as ViewerBackgroundMode);
      }
    });
  }
}

function finishStartupPhase() {
  document.body.dataset.startup = "ready";
}
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

type CustomSourceEditorState = {
  isOpen: boolean;
  id: string | null;
  name: string;
  icon: string;
  statusMessage: string;
};

const customSourceEditorState: CustomSourceEditorState = {
  isOpen: false,
  id: null,
  name: "",
  icon: "fa-solid fa-book",
  statusMessage: "",
};

const CUSTOM_SOURCE_ICONS: Array<{ cls: string; label: string }> = [
  { cls: "fa-regular fa-building", label: "Building" },
  { cls: "fa-solid fa-building", label: "Building (solid)" },
  { cls: "fa-solid fa-house", label: "House" },
  { cls: "fa-regular fa-house", label: "House (regular)" },
  { cls: "fa-solid fa-book", label: "Book" },
  { cls: "fa-solid fa-school", label: "School" },
  { cls: "fa-solid fa-suitcase", label: "Suitcase" },
  { cls: "fa-solid fa-shop", label: "Shop" },
  { cls: "fa-solid fa-mobile-screen", label: "Mobile" },
  { cls: "fa-solid fa-tablet-screen-button", label: "Tablet" },
  { cls: "fa-solid fa-computer", label: "Computer" },
  { cls: "fa-solid fa-floppy-disk", label: "Floppy disk" },
  { cls: "fa-solid fa-house-laptop", label: "House + laptop" },
  { cls: "fa-solid fa-laptop", label: "Laptop" },
  { cls: "fa-solid fa-laptop-file", label: "Laptop + file" },
  { cls: "fa-solid fa-bus", label: "Bus" },
  { cls: "fa-solid fa-train", label: "Train" },
  { cls: "fa-solid fa-square-rss", label: "RSS" },
  { cls: "fa-solid fa-bed", label: "Bed" },
  { cls: "fa-solid fa-bag-shopping", label: "Shopping bag" },
  ...Array.from({ length: 10 }, (_, i) => ({
    cls: `fa-solid fa-${i}`,
    label: String(i),
  })),
  ...Array.from({ length: 26 }, (_, i) => ({
    cls: `fa-solid fa-${String.fromCharCode(97 + i)}`,
    label: String.fromCharCode(65 + i),
  })),
  { cls: "fa-brands fa-pixiv", label: "Pixiv" },
];

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

let epubJsModulePromise: Promise<typeof import("epubjs")> | null = null;

async function loadEpubJs() {
  epubJsModulePromise ??= import("epubjs");
  return epubJsModulePromise;
}

const EPUB_PREVIEW_NOTICE_STORAGE_KEY = "riida.epub.previewNoticeShown";

function epubLocationsStorageKey(filePath: string, fileSize: number): string {
  return `riida:epub-locations:${fileSize}:${filePath}`;
}

function loadCachedEpubLocations(filePath: string, fileSize: number): string | null {
  if (!filePath || !Number.isFinite(fileSize) || fileSize <= 0) return null;
  try {
    return window.localStorage.getItem(epubLocationsStorageKey(filePath, fileSize));
  } catch {
    return null;
  }
}

function saveCachedEpubLocations(filePath: string, fileSize: number, serialized: string) {
  if (!filePath || !Number.isFinite(fileSize) || fileSize <= 0 || !serialized) return;
  try {
    window.localStorage.setItem(epubLocationsStorageKey(filePath, fileSize), serialized);
  } catch {
    // localStorage full or unavailable — skip caching.
  }
}

async function maybeShowEpubPreviewNotice(): Promise<void> {
  try {
    if (window.localStorage.getItem(EPUB_PREVIEW_NOTICE_STORAGE_KEY) === "1") {
      return;
    }
  } catch {
    // localStorage unavailable — fall through and show the notice once.
  }
  try {
    await message("EPUBは開発中です。リンクは機能せず、画面が乱れる可能性があります。", {
      title: "EPUB (開発中)",
      kind: "warning",
    });
  } catch {
    // Ignore dialog failures; we still record that we tried to show it.
  }
  try {
    window.localStorage.setItem(EPUB_PREVIEW_NOTICE_STORAGE_KEY, "1");
  } catch {
    // localStorage unavailable — the notice will show again next time.
  }
}

function isEpubNextPageKey(event: KeyboardEvent): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  return event.key === "PageDown" || event.key === "ArrowDown" || event.key === "ArrowRight";
}

function isEpubPrevPageKey(event: KeyboardEvent): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  return event.key === "PageUp" || event.key === "ArrowUp" || event.key === "ArrowLeft";
}

async function loadNoteEditorModule() {
  noteEditorModulePromise ??= import("./note-editor");
  return noteEditorModulePromise;
}

function promptPdfPassword(isRetry: boolean): Promise<string | null> {
  return new Promise((resolve) => {
    const modalEl = document.querySelector<HTMLElement>("#pdf-password-modal");
    const inputEl = document.querySelector<HTMLInputElement>("#pdf-password-input");
    const submitEl = document.querySelector<HTMLButtonElement>("#pdf-password-submit");
    const cancelEl = document.querySelector<HTMLButtonElement>("#pdf-password-cancel");
    const statusEl = document.querySelector<HTMLElement>("#pdf-password-status");
    if (!modalEl || !inputEl || !submitEl || !cancelEl || !statusEl) {
      resolve(null);
      return;
    }

    inputEl.value = "";
    modalEl.hidden = false;
    if (isRetry) {
      statusEl.textContent = "Incorrect password. Try again.";
      statusEl.dataset.tone = "error";
      statusEl.hidden = false;
    } else {
      statusEl.hidden = true;
      delete statusEl.dataset.tone;
    }
    inputEl.focus();

    function cleanup() {
      modalEl!.hidden = true;
      submitEl!.removeEventListener("click", onSubmit);
      cancelEl!.removeEventListener("click", onCancel);
      inputEl!.removeEventListener("keydown", onKeydown);
    }

    function onSubmit() {
      const pw = inputEl!.value;
      cleanup();
      resolve(pw.length > 0 ? pw : null);
    }

    function onCancel() {
      cleanup();
      resolve(null);
    }

    function onKeydown(event: KeyboardEvent) {
      if (event.key === "Enter" && !event.isComposing && event.keyCode !== 229) {
        onSubmit();
      } else if (event.key === "Escape") {
        onCancel();
      }
    }

    submitEl.addEventListener("click", onSubmit);
    cancelEl.addEventListener("click", onCancel);
    inputEl.addEventListener("keydown", onKeydown);
  });
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

  if (viewerState.currentBook.sourceType === "epub") {
    return activeReadingPosition?.pageNumber ?? (activeEpubTotalPages ? 1 : null);
  }

  return activeReadingPosition?.pageNumber ?? 1;
}

function currentViewerTotalPages() {
  const currentBook = viewerState.currentBook;
  if (!currentBook) {
    return null;
  }

  if (currentBook.sourceType === "epub") {
    return activeEpubTotalPages;
  }

  return activePdfRenderSession?.pdfDocument.numPages ?? null;
}

function syncViewerPageJumpUi() {
  const pageJumpEl = document.querySelector<HTMLElement>("#viewer-page-jump");
  const formEl = document.querySelector<HTMLFormElement>("#viewer-page-jump-form");
  const inputEl = document.querySelector<HTMLInputElement>("#viewer-page-jump-input");
  const totalEl = document.querySelector<HTMLElement>("#viewer-page-jump-total");
  const currentPageNumber = currentViewerPageNumber();
  const totalPages = currentViewerTotalPages();

  if (!pageJumpEl || !formEl || !inputEl || !totalEl) {
    return;
  }

  const shouldShow = Boolean(viewerState.currentBook);
  pageJumpEl.hidden = !shouldShow;
  formEl.hidden = !shouldShow;

  if (!shouldShow || currentPageNumber === null) {
    totalEl.textContent = "";
    return;
  }

  totalEl.textContent = totalPages ? `/ ${totalPages}` : "";

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

  if (currentBook.sourceType === "epub") {
    if (!activeEpubBook || !activeEpubRendition || !activeEpubTotalPages) {
      return;
    }

    const boundedPageNumber = clampEpubPageNumber(pageNumber, activeEpubTotalPages);
    const cfi = activeEpubBook.locations.cfiFromLocation(
      epubLocationIndexFromPageNumber(boundedPageNumber, activeEpubTotalPages),
    );
    if (!cfi) {
      return;
    }

    activeReadingPosition = {
      filePath: currentBook.filePath,
      pageNumber: boundedPageNumber,
      pageOffsetRatio: 0,
      cfi,
      updatedAt: activeReadingPosition?.updatedAt ?? null,
    };
    cacheReadingPosition(activeReadingPosition);
    syncViewerPageJumpUi();
    void activeEpubRendition.display(cfi);
    void flushReadingPositionSave();
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

    const rect = viewport.convertToViewportRectangle(annotation.rect);
    const x1 = rect[0] ?? 0;
    const y1 = rect[1] ?? 0;
    const x2 = rect[2] ?? 0;
    const y2 = rect[3] ?? 0;
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

    if (pdfSearchState.isOpen && pdfSearchState.matches.length > 0) {
      applyPdfSearchHighlights();
    }

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
  const themeEl = document.querySelector<HTMLSelectElement>("#config-theme");
  const configPathEl = document.querySelector<HTMLElement>("#app-settings-config-path");
  const kindleEnabledEl = document.querySelector<HTMLInputElement>("#config-kindle-enabled");

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
    if (themeEl) {
      themeEl.value = lastAppConfig.theme;
    }
    if (configPathEl) {
      configPathEl.innerHTML = `Config file: <code>${lastAppConfig.configPath}</code>`;
    }
    if (kindleEnabledEl) {
      kindleEnabledEl.checked = lastAppConfig.enabledExternalSources.includes("kindle");
    }
  } else if (configPathEl) {
    configPathEl.textContent = "";
  }

  renderLibraryRootsList();
  renderCustomSourcesList();
}

function renderCustomSourcesList() {
  const listEl = document.querySelector<HTMLElement>("#config-custom-sources-list");
  if (!listEl) {
    return;
  }
  listEl.innerHTML = "";
  const sources = lastSnapshot?.customSources ?? [];
  if (sources.length === 0) {
    const emptyEl = document.createElement("p");
    emptyEl.className = "config-custom-sources-empty";
    emptyEl.textContent = "No custom sources yet.";
    listEl.appendChild(emptyEl);
    return;
  }
  for (const source of sources) {
    const rowEl = document.createElement("div");
    rowEl.className = "config-custom-source-row";

    const iconEl = document.createElement("i");
    iconEl.className = `${source.icon} config-custom-source-icon`;
    iconEl.setAttribute("aria-hidden", "true");

    const nameEl = document.createElement("span");
    nameEl.className = "config-custom-source-name";
    nameEl.textContent = source.name;

    const editEl = document.createElement("button");
    editEl.type = "button";
    editEl.className = "config-custom-source-action";
    editEl.textContent = "Edit";
    editEl.addEventListener("click", () => openCustomSourceEditor(source));

    const deleteEl = document.createElement("button");
    deleteEl.type = "button";
    deleteEl.className = "config-custom-source-action config-custom-source-action--delete";
    deleteEl.textContent = "Delete";
    deleteEl.addEventListener("click", () => void deleteCustomSource(source));

    rowEl.appendChild(iconEl);
    rowEl.appendChild(nameEl);
    rowEl.appendChild(editEl);
    rowEl.appendChild(deleteEl);
    listEl.appendChild(rowEl);
  }
}

function syncCustomSourceEditorUi() {
  const modalEl = document.querySelector<HTMLElement>("#custom-source-editor-modal");
  const nameEl = document.querySelector<HTMLInputElement>("#custom-source-name");
  const statusEl = document.querySelector<HTMLElement>("#custom-source-status");
  if (modalEl) {
    modalEl.hidden = !customSourceEditorState.isOpen;
  }
  if (nameEl && document.activeElement !== nameEl) {
    nameEl.value = customSourceEditorState.name;
  }
  // Update icon picker selection
  const pickerEl = document.querySelector<HTMLElement>("#custom-source-icon-picker");
  if (pickerEl) {
    for (const btn of pickerEl.querySelectorAll<HTMLButtonElement>("[data-icon]")) {
      btn.classList.toggle("is-selected", btn.dataset.icon === customSourceEditorState.icon);
    }
  }
  if (statusEl) {
    statusEl.hidden = customSourceEditorState.statusMessage.length === 0;
    statusEl.textContent = customSourceEditorState.statusMessage;
  }
}

function openCustomSourceEditor(source?: CustomSource) {
  customSourceEditorState.isOpen = true;
  customSourceEditorState.id = source?.id ?? null;
  customSourceEditorState.name = source?.name ?? "";
  customSourceEditorState.icon = source?.icon ?? "fa-solid fa-book";
  customSourceEditorState.statusMessage = "";
  syncCustomSourceEditorUi();
}

function closeCustomSourceEditor() {
  customSourceEditorState.isOpen = false;
  syncCustomSourceEditorUi();
}

async function saveCustomSource() {
  const nameEl = document.querySelector<HTMLInputElement>("#custom-source-name");
  const name = nameEl?.value.trim() ?? customSourceEditorState.name.trim();
  if (!name) {
    customSourceEditorState.statusMessage = "Name is required.";
    syncCustomSourceEditorUi();
    return;
  }
  try {
    await invoke<CustomSource>("save_custom_source", {
      id: customSourceEditorState.id ?? null,
      name,
      icon: customSourceEditorState.icon,
    });
    const snapshot = await invoke<LibrarySnapshot>("library_snapshot");
    lastSnapshot = snapshot;
    viewerState.books = snapshot.books;
    renderApp();
    closeCustomSourceEditor();
  } catch (error) {
    customSourceEditorState.statusMessage = `Failed to save: ${String(error)}`;
    syncCustomSourceEditorUi();
  }
}

async function deleteCustomSource(source: CustomSource) {
  const confirmed = await confirm(`Delete "${source.name}" and all its books?`, {
    title: "Delete source",
    kind: "warning",
    okLabel: "Delete",
    cancelLabel: "Cancel",
  });
  if (!confirmed) {
    return;
  }
  try {
    await invoke("delete_custom_source", { id: source.id });
    const snapshot = await invoke<LibrarySnapshot>("library_snapshot");
    lastSnapshot = snapshot;
    viewerState.books = snapshot.books;
    if (viewerState.activeExternalSource === source.id) {
      viewerState.activeExternalSource = null;
    }
    renderApp();
    syncAppSettingsUi();
  } catch (error) {
    await message(`Failed to delete: ${String(error)}`, { kind: "error" });
  }
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
  const deleteEl = document.querySelector<HTMLButtonElement>("#book-metadata-delete");
  const epubImportEl = document.querySelector<HTMLButtonElement>("#book-metadata-epub-import");

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
  if (deleteEl) {
    const canDelete =
      bookMetadataEditorState.filePath !== null || bookMetadataEditorState.sourceType === "pdf";
    deleteEl.hidden = !canDelete;
    deleteEl.textContent =
      bookMetadataEditorState.sourceType === "pdf" ? "Clear metadata" : "Delete book";
  }
  if (epubImportEl) {
    epubImportEl.hidden = bookMetadataEditorState.sourceType !== "epub";
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

function bookSourceDisplayName(sourceType: string): string {
  if (sourceType === "kindle") return "Kindle";
  const custom = lastSnapshot?.customSources.find((s) => s.id === sourceType);
  return custom?.name ?? sourceType;
}

function populateBookMetadataEditor(book: BookSummary, metadata: BookMetadataPayload) {
  bookMetadataEditorState.filePath = metadata.filePath;
  bookMetadataEditorState.bookTitle =
    book.sourceType === "pdf" ? book.fileName : bookSourceDisplayName(book.sourceType);
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

type EpubMetadataPayload = {
  title: string;
  authors: string[];
  description: string;
  publisher: string;
  releaseDate: string;
  language: string;
};

async function importMetadataFromEpub(
  filePath: string,
  loadToken: number,
  { overwriteNonEmpty = false } = {},
) {
  setBookMetadataStatus("Importing from EPUB...");
  syncBookMetadataEditorUi();
  try {
    const epub = await invoke<EpubMetadataPayload>("extract_epub_metadata", { filePath });
    if (bookMetadataEditorState.loadToken !== loadToken) return;

    const draft = buildBookMetadataDraftFromForm();
    if (epub.title && (overwriteNonEmpty || !draft.title.trim())) {
      bookMetadataEditorState.title = epub.title;
    }
    if (epub.authors.length > 0 && (overwriteNonEmpty || !draft.authorsText.trim())) {
      bookMetadataEditorState.authorsText = joinMetadataAuthors(epub.authors);
    }
    if (epub.description && (overwriteNonEmpty || !draft.description.trim())) {
      bookMetadataEditorState.description = epub.description;
    }
    if (epub.publisher && (overwriteNonEmpty || !draft.publisher.trim())) {
      bookMetadataEditorState.publisher = epub.publisher;
    }
    if (epub.releaseDate && (overwriteNonEmpty || !draft.releaseDate.trim())) {
      bookMetadataEditorState.releaseDate = epub.releaseDate;
    }
    if (epub.language && (overwriteNonEmpty || !draft.language.trim())) {
      bookMetadataEditorState.language = epub.language;
    }
    setBookMetadataStatus("");
    syncBookMetadataEditorUi();
  } catch (err) {
    if (bookMetadataEditorState.loadToken !== loadToken) return;
    setBookMetadataStatus(`EPUB import failed: ${String(err)}`, "error");
  }
}

function openNewKindleBookEditor() {
  bookMetadataEditorState.loadToken += 1;
  bookMetadataEditorState.isOpen = true;
  bookMetadataEditorState.filePath = null;
  bookMetadataEditorState.bookTitle = "Kindle";
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

function openNewCustomBookEditor(source: CustomSource) {
  bookMetadataEditorState.loadToken += 1;
  bookMetadataEditorState.isOpen = true;
  bookMetadataEditorState.filePath = null;
  bookMetadataEditorState.bookTitle = source.name;
  bookMetadataEditorState.sourceType = source.id;
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
  bookMetadataEditorState.bookTitle =
    book.sourceType === "pdf" ? book.fileName : bookSourceDisplayName(book.sourceType);
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

    // Auto-import OPF metadata when the book has no saved title or authors.
    if (book.sourceType === "epub" && !payload.title.trim() && payload.authors.length === 0) {
      await importMetadataFromEpub(book.filePath, loadToken);
    }
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

function buildBookMetadataDraftForSave():
  | { ok: true; draft: ReturnType<typeof buildBookMetadataDraftFromForm> }
  | { ok: false; message: string } {
  const baseDraft = buildBookMetadataDraftFromForm();
  const importText = bookMetadataEditorState.importText.trim();
  let draft = baseDraft;

  if (isBookMetadataDraftEmpty(baseDraft) && importText) {
    const parsed = parseBookMetadataImport(importText);
    if (!parsed.ok) {
      return { ok: false, message: parsed.message };
    }
    draft = applyBookMetadataImport(baseDraft, parsed.patch);
    applyBookMetadataDraftToState(draft);
    syncBookMetadataEditorUi();
  }

  if (isBookMetadataDraftEmpty(draft)) {
    return {
      ok: false,
      message: "Enter at least one metadata field, or paste JSON to import before saving.",
    };
  }

  return { ok: true, draft };
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
  const saveInput = buildBookMetadataDraftForSave();
  if (!saveInput.ok) {
    setBookMetadataStatus(saveInput.message, "error");
    return;
  }

  const draft = saveInput.draft;
  const validation = validateBookMetadataDraft(draft);
  if (!validation.ok) {
    setBookMetadataStatus(validation.message, "error");
    return;
  }

  const isCustom =
    bookMetadataEditorState.sourceType !== "pdf" && bookMetadataEditorState.sourceType !== "kindle";
  let filePath: string;
  if (bookMetadataEditorState.filePath) {
    filePath = bookMetadataEditorState.filePath;
  } else if (bookMetadataEditorState.sourceType === "kindle") {
    filePath = `kindle:${draft.asin.trim() || crypto.randomUUID()}`;
  } else {
    filePath = `custom:${crypto.randomUUID()}`;
  }

  if (
    !bookMetadataEditorState.filePath &&
    bookMetadataEditorState.sourceType === "kindle" &&
    draft.asin.trim()
  ) {
    const duplicate = viewerState.books.find((b) => b.filePath === filePath);
    if (duplicate) {
      await message(`ASIN ${draft.asin.trim()} is already registered: "${duplicate.fileName}"`, {
        title: "Duplicate ASIN",
        kind: "error",
      });
      return;
    }
  }

  try {
    const payload = await invoke<BookMetadataPayload>("save_book_metadata", {
      input: {
        filePath,
        sourceType: isCustom ? bookMetadataEditorState.sourceType : null,
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
    const customSource = isCustom
      ? lastSnapshot?.customSources.find((s) => s.id === bookMetadataEditorState.sourceType)
      : null;
    const sourceBook =
      viewerState.currentBook?.filePath === payload.filePath
        ? viewerState.currentBook
        : {
            fileName: bookMetadataEditorState.bookTitle,
            title: null,
            filePath: payload.filePath,
            fileSize: 0,
            tags: [],
            authors: payload.authors,
            sourceType: bookMetadataEditorState.sourceType,
            coverUrl: payload.coverUrl || null,
            locationLabel:
              customSource?.name ??
              (bookMetadataEditorState.sourceType === "kindle" ? "Kindle library" : null),
            isOpenable: bookMetadataEditorState.sourceType === "pdf",
            asin: payload.asin || null,
            url: payload.url || null,
            publisher: payload.publisher || null,
            language: payload.language || null,
            lastReadAt: null,
          };
    populateBookMetadataEditor(sourceBook, payload);
    await refreshSnapshot();
    closeBookMetadataEditor();
  } catch (error) {
    setBookMetadataStatus(`Failed to save metadata: ${String(error)}`, "error");
  }
}

async function deleteBookMetadataChanges() {
  const filePath = bookMetadataEditorState.filePath;
  if (!filePath) {
    setBookMetadataStatus("Save the book once before deleting it.", "error");
    return;
  }

  const isExternalBook = bookMetadataEditorState.sourceType !== "pdf";
  const confirmed = await confirm(
    isExternalBook
      ? "Delete this book from the library?"
      : "Clear the saved metadata for this PDF?",
    {
      title: isExternalBook ? "Delete book" : "Clear metadata",
      kind: "warning",
      okLabel: "Delete",
      cancelLabel: "Cancel",
    },
  );
  if (!confirmed) {
    return;
  }

  try {
    await invoke("delete_book_metadata", { filePath });

    if (viewerState.currentBook?.filePath === filePath) {
      if (isExternalBook) {
        viewerState.currentBook = null;
      } else {
        viewerState.currentBook = {
          ...viewerState.currentBook,
          coverUrl: null,
          authors: [],
        };
      }
    }

    await refreshSnapshot();
    closeBookMetadataEditor();
  } catch (error) {
    setBookMetadataStatus(`Failed to delete metadata: ${String(error)}`, "error");
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
  const theme = normalizeAppTheme(lastAppConfig.theme);
  applyAppTheme(theme);
  persistAppTheme(theme);
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
  const themeEl = document.querySelector<HTMLSelectElement>("#config-theme");
  const kindleEnabledEl = document.querySelector<HTMLInputElement>("#config-kindle-enabled");

  const libraryRoots = [...(lastAppConfig?.libraryRoots ?? [])];

  if (libraryRoots.length === 0) {
    setAppSettingsStatus("At least one library root is required.", "error");
    return;
  }

  const enabledExternalSources = kindleEnabledEl?.checked ? ["kindle"] : [];

  try {
    const payload = await invoke<AppConfigPayload>("save_app_config", {
      input: {
        ...buildAppConfigDraft(
          libraryRoots,
          excludedPatternsEl?.value ?? "",
          pdfRendererEl?.value,
          themeEl?.value,
          enabledExternalSources,
        ),
      },
    });

    lastAppConfig = payload;
    applyAppTheme(payload.theme);
    persistAppTheme(payload.theme);
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

function buildEpubToc() {
  const listEl = document.querySelector<HTMLElement>("#epub-toc-list");
  if (!listEl || !activeEpubBook) return;
  listEl.innerHTML = "";

  type NavItem = { label: string; href: string; subitems?: NavItem[] };
  const toc: NavItem[] = (activeEpubBook.navigation as unknown as { toc: NavItem[] }).toc ?? [];

  function appendItems(items: NavItem[], depth: number) {
    for (const item of items) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "epub-toc-item";
      btn.dataset.depth = String(depth);
      btn.textContent = item.label.trim();
      btn.addEventListener("click", () => {
        tocPanelOpen = false;
        syncTocUi();
        if (activeEpubRendition) {
          void activeEpubRendition.display(item.href);
        }
      });
      listEl!.appendChild(btn);
      if (item.subitems && item.subitems.length > 0) {
        appendItems(item.subitems, depth + 1);
      }
    }
  }

  appendItems(toc, 0);
}

function buildPdfToc() {
  const listEl = document.querySelector<HTMLElement>("#epub-toc-list");
  if (!listEl) return;
  listEl.innerHTML = "";

  const outline = activePdfOutline;
  if (!outline || outline.length === 0) return;

  const session = activePdfRenderSession;

  function appendItems(items: PdfOutlineNode[], depth: number) {
    for (const item of items) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "epub-toc-item";
      btn.dataset.depth = String(depth);
      btn.textContent = item.title;
      btn.addEventListener("click", () => {
        tocPanelOpen = false;
        syncTocUi();
        if (!session || item.dest === null) return;
        const resolver = session.pdfDocument;
        void (async () => {
          let explicitDest: unknown = item.dest;
          if (typeof item.dest === "string" && resolver.getDestination) {
            explicitDest = await resolver.getDestination(item.dest);
          }
          if (!Array.isArray(explicitDest) || explicitDest.length === 0) return;
          const [firstEntry] = explicitDest;
          let pageNumber: number | null = null;
          if (typeof firstEntry === "number" && Number.isFinite(firstEntry)) {
            pageNumber = Math.min(Math.max(Math.trunc(firstEntry) + 1, 1), resolver.numPages);
          } else if (firstEntry && typeof firstEntry === "object" && resolver.getPageIndex) {
            const idx = await resolver.getPageIndex(firstEntry);
            pageNumber = Math.min(Math.max(Math.trunc(idx) + 1, 1), resolver.numPages);
          }
          if (pageNumber !== null) {
            navigateViewerToPage(pageNumber);
          }
        })();
      });
      listEl!.appendChild(btn);
      if (item.items.length > 0) {
        appendItems(item.items, depth + 1);
      }
    }
  }

  appendItems(outline, 0);
}

function syncTocUi() {
  const toggleEl = document.querySelector<HTMLButtonElement>("#epub-toc-toggle");
  const panelEl = document.querySelector<HTMLElement>("#epub-toc-panel");
  const sourceType = currentViewerSettingsSourceType();
  const isEpub = sourceType === "epub";
  const isPdf =
    sourceType === "pdf" &&
    lastSnapshot?.pdfRenderer === "pdfjs" &&
    activePdfOutline !== null &&
    activePdfOutline.length > 0;
  const hasToc = isEpub || isPdf;
  if (toggleEl) {
    toggleEl.hidden = !hasToc;
    toggleEl.setAttribute("aria-expanded", String(tocPanelOpen));
  }
  if (panelEl) {
    panelEl.hidden = !hasToc || !tocPanelOpen;
  }
}

function syncViewerSettingsUi() {
  const settingsToggleEl = document.querySelector<HTMLButtonElement>("#viewer-settings-toggle");
  const settingsPanelEl = document.querySelector<HTMLElement>("#viewer-settings-panel");
  const tagsOpenEl = document.querySelector<HTMLButtonElement>("#viewer-tags-open");
  const metadataOpenEl = document.querySelector<HTMLButtonElement>("#viewer-metadata-open");
  const scopeGlobalEl = document.querySelector<HTMLButtonElement>("#viewer-settings-scope-global");
  const scopeFileEl = document.querySelector<HTMLButtonElement>("#viewer-settings-scope-file");
  const sourceLabelEl = document.querySelector<HTMLElement>("#viewer-settings-source-label");
  const readerFieldsEl = document.querySelector<HTMLElement>("#viewer-settings-reader-fields");
  const pageModeEl = document.querySelector<HTMLSelectElement>("#viewer-page-mode");
  const bindingEl = document.querySelector<HTMLSelectElement>("#viewer-binding-direction");
  const zoomModeEl = document.querySelector<HTMLSelectElement>("#viewer-zoom-mode");
  const alignModeEl = document.querySelector<HTMLSelectElement>("#viewer-align-mode");
  const verticalGapModeEl = document.querySelector<HTMLSelectElement>("#viewer-vertical-gap-mode");
  const scrollModeEl = document.querySelector<HTMLSelectElement>("#viewer-scroll-mode");
  const coverModeEl = document.querySelector<HTMLInputElement>("#viewer-cover-mode");
  const epubFontSizeEl = document.querySelector<HTMLInputElement>("#viewer-epub-font-size");
  const epubFontSizeOutputEl = document.querySelector<HTMLOutputElement>(
    "#viewer-epub-font-size-output",
  );
  const sourceType = currentViewerSettingsSourceType();
  const isPdfViewerSettingsAvailable =
    sourceType === "pdf" && lastSnapshot?.pdfRenderer === "pdfjs";
  const isEpubViewerSettingsAvailable = sourceType === "epub";
  const isViewerSettingsAvailable = isPdfViewerSettingsAvailable || isEpubViewerSettingsAvailable;
  const editingPreferences =
    viewerSettings.scope === "file" ? viewerSettings.fileDraft : viewerSettings.globalDraft;

  if (settingsToggleEl) {
    settingsToggleEl.hidden = !isViewerSettingsAvailable;
    settingsToggleEl.setAttribute("aria-expanded", String(viewerSettings.isSettingsOpen));
  }

  if (tagsOpenEl) {
    tagsOpenEl.hidden = !isViewerSettingsAvailable || !viewerSettings.isSettingsOpen;
  }

  if (metadataOpenEl) {
    metadataOpenEl.hidden =
      !viewerState.currentBook || (isViewerSettingsAvailable && !viewerSettings.isSettingsOpen);
  }

  if (settingsPanelEl) {
    settingsPanelEl.hidden = !isViewerSettingsAvailable || !viewerSettings.isSettingsOpen;
    settingsPanelEl.dataset.scope = viewerSettings.scope;
    settingsPanelEl.dataset.sourceType = sourceType ?? "";
  }

  scopeGlobalEl?.classList.toggle("is-active", viewerSettings.scope === "global");
  scopeGlobalEl?.setAttribute("aria-selected", String(viewerSettings.scope === "global"));
  scopeFileEl?.classList.toggle("is-active", viewerSettings.scope === "file");
  scopeFileEl?.setAttribute("aria-selected", String(viewerSettings.scope === "file"));
  if (sourceLabelEl) {
    sourceLabelEl.textContent = sourceType === "epub" ? "EPUB" : "PDF";
  }
  if (readerFieldsEl) {
    readerFieldsEl.hidden = !isViewerSettingsAvailable;
  }

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

  if (scrollModeEl) {
    scrollModeEl.value = editingPreferences.scrollMode;
  }

  if (coverModeEl) {
    coverModeEl.checked = editingPreferences.treatFirstPageAsCover;
  }

  if (epubFontSizeEl) {
    epubFontSizeEl.value = String(editingPreferences.epubFontSize);
  }

  if (epubFontSizeOutputEl) {
    epubFontSizeOutputEl.value = `${editingPreferences.epubFontSize}%`;
  }

  syncViewerBackgroundControls(
    "viewer-background-mode",
    "viewer-background-inherit",
    editingPreferences.backgroundMode,
  );

  syncTocUi();
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
  sourceType: ViewerSourceType,
) {
  viewerSettings.pageMode = preferences.pageMode;
  viewerSettings.bindingDirection = preferences.bindingDirection;
  viewerSettings.zoomMode = preferences.zoomMode;
  viewerSettings.alignMode = preferences.alignMode;
  viewerSettings.verticalGapMode = preferences.verticalGapMode;
  viewerSettings.treatFirstPageAsCover = preferences.treatFirstPageAsCover;
  viewerSettings.backgroundMode = preferences.backgroundMode;
  viewerSettings.scrollMode = preferences.scrollMode;
  syncImmediatePdfScrollMode();
  viewerSettings.scope = scope;
  viewerSettings.hasFileOverride = hasFileOverride;
  viewerSettings.sourceType = sourceType;
}

function applyViewerSettingsPayload(
  payload: ViewerSettingsPayload,
  sourceType: ViewerSourceType,
  preferredScope: ViewerSettingsScope = payload.usesFileOverride ? "file" : "global",
) {
  const nextState = applyViewerSettingsPayloadToState(payload, preferredScope);
  applyViewerPreferences(nextState, nextState.scope, nextState.hasFileOverride, sourceType);
  viewerSettings.globalDraft = nextState.globalDraft;
  viewerSettings.fileDraft = nextState.fileDraft;
}

async function loadViewerSettingsForCurrentBook() {
  const currentBook = viewerState.currentBook;
  const currentSourceType = currentViewerSettingsSourceType() ?? "pdf";

  if (!currentBook) {
    applyPdfViewerBackground("inherit-theme");
    applyViewerPreferences(DEFAULT_VIEWER_SETTINGS, "global", false, currentSourceType);
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
      sourceType: currentSourceType,
    });

    if (
      currentToken !== viewerSettingsLoadToken ||
      viewerState.currentBook?.filePath !== currentBook.filePath
    ) {
      return;
    }

    applyViewerSettingsPayload(payload, currentSourceType);
    syncViewerSettingsUi();
  } catch (error) {
    applyPdfViewerBackground("inherit-theme");
    applyViewerPreferences(DEFAULT_VIEWER_SETTINGS, "global", false, currentSourceType);
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
  applyPdfViewerBackground("inherit-theme");
  applyViewerPreferences(DEFAULT_VIEWER_SETTINGS, "global", false, "pdf");
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
    epubCfi: activeReadingPosition?.cfi ?? null,
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
  if (!historyState) return;
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
    // Fast path: same EPUB book already rendered — jump directly via CFI
    // to avoid destroying and re-creating the rendition.
    if (
      state.epubCfi &&
      nextBook.filePath === viewerState.currentBook?.filePath &&
      nextBook.sourceType === "epub" &&
      activeEpubRendition
    ) {
      await activeEpubRendition.display(state.epubCfi);
      return;
    }

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

function syncImmediatePdfScrollMode() {
  const stageEl = currentViewerStage();
  if (!stageEl) {
    return;
  }
  stageEl.dataset.scrollMode = viewerSettings.scrollMode;
}

function getPdfPageEls(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".pdfjs-spread"));
}

function findActivePdfPageEl(stageEl: HTMLElement, pageEls: HTMLElement[]): HTMLElement | null {
  if (pageEls.length === 0) {
    return null;
  }
  const anchor = stageEl.scrollTop + stageEl.clientHeight * 0.3;
  let active: HTMLElement | null = pageEls[0] ?? null;
  for (const pageEl of pageEls) {
    if (pageEl.offsetTop <= anchor) {
      active = pageEl;
    } else {
      break;
    }
  }
  return active;
}

function handlePdfPagedKey(event: KeyboardEvent): boolean {
  if (viewerSettings.scrollMode !== "paged") {
    return false;
  }
  if (viewerState.currentBook?.sourceType !== "pdf") {
    return false;
  }
  if (lastSnapshot?.pdfRenderer !== "pdfjs") {
    return false;
  }
  const stageEl = currentViewerStage();
  if (!stageEl) {
    return false;
  }
  const pageEls = getPdfPageEls();
  const activeEl = findActivePdfPageEl(stageEl, pageEls);
  if (!activeEl) {
    return false;
  }

  const key = event.key;
  if (
    key !== "ArrowLeft" &&
    key !== "ArrowRight" &&
    key !== "ArrowUp" &&
    key !== "ArrowDown" &&
    key !== "PageUp" &&
    key !== "PageDown"
  ) {
    return false;
  }

  const action = planPagedKeyAction(
    key,
    {
      scrollTop: stageEl.scrollTop,
      scrollLeft: stageEl.scrollLeft,
      clientHeight: stageEl.clientHeight,
      clientWidth: stageEl.clientWidth,
      pageOffsetTop: activeEl.offsetTop,
      pageOffsetLeft: activeEl.offsetLeft,
      pageHeight: activeEl.offsetHeight,
      pageWidth: activeEl.offsetWidth,
    },
    viewerSettings.bindingDirection,
  );

  event.preventDefault();

  if (action.kind === "jump-adjacent") {
    const index = pageEls.indexOf(activeEl);
    const target = pageEls[index + action.direction];
    if (target) {
      stageEl.scrollTo({ top: target.offsetTop, left: stageEl.scrollLeft, behavior: "auto" });
    }
    return true;
  }

  stageEl.scrollTo({ top: action.top, left: action.left, behavior: "auto" });
  return true;
}

function searchNormalize(str: string): string {
  return [
    ...str
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .normalize("NFKC")
      .toLowerCase(),
  ]
    .map((c) => CJK_RADICAL_MAP[c] ?? c)
    .join("");
}

function buildPdfSearchPageIndex(items: Array<{ str: string }>): PdfSearchPageIndex {
  const normChars: PdfSearchNormChar[] = [];
  let normalizedText = "";

  for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
    const item = items[itemIndex];
    if (!item) continue;
    const str = item.str;
    let origOffset = 0;
    for (const cp of str) {
      const origOffsetEnd = origOffset + cp.length;
      const normalized = searchNormalize(cp);
      for (const nc of normalized) {
        normChars.push({ itemIndex, origOffset, origOffsetEnd });
        normalizedText += nc;
      }
      origOffset = origOffsetEnd;
    }
  }

  return { normalizedText, normChars };
}

async function ensurePdfSearchPageIndex(pageNumber: number): Promise<PdfSearchPageIndex | null> {
  const cached = pdfSearchState.pageIndices.get(pageNumber);
  if (cached) return cached;

  const session = activePdfRenderSession;
  if (!session) return null;

  try {
    const page = await session.pdfDocument.getPage(pageNumber);
    const stream = page.streamTextContent() as ReadableStream<{ items: Array<{ str?: string }> }>;
    const reader = stream.getReader();
    const allItems: Array<{ str: string }> = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const item of value.items) {
        if (typeof item.str === "string") {
          allItems.push({ str: item.str });
        }
      }
    }
    const index = buildPdfSearchPageIndex(allItems);
    pdfSearchState.pageIndices.set(pageNumber, index);
    return index;
  } catch (err) {
    console.error(`[pdf-search] ensurePdfSearchPageIndex(${pageNumber}) threw:`, err);
    return null;
  }
}

async function executePdfSearch(query: string) {
  const session = activePdfRenderSession;
  const normalizedQuery = searchNormalize(query);
  console.log(
    `[pdf-search] executePdfSearch query="${query}" normalizedQuery="${normalizedQuery}" session=${session ? "ok" : "null"}`,
  );

  if (!session || !normalizedQuery) {
    pdfSearchState.matches = [];
    pdfSearchState.currentMatchIndex = -1;
    applyPdfSearchHighlights();
    syncPdfSearchUi();
    return;
  }

  const matches: PdfSearchMatch[] = [];
  const totalPages = session.pdfDocument.numPages;

  for (let p = 1; p <= totalPages; p++) {
    const index = await ensurePdfSearchPageIndex(p);
    if (!index) continue;

    if (pdfSearchState.query !== query) return;

    const { normalizedText } = index;
    let pos = 0;
    while (pos <= normalizedText.length - normalizedQuery.length) {
      const found = normalizedText.indexOf(normalizedQuery, pos);
      if (found === -1) break;
      matches.push({
        pageNumber: p,
        normalizedStart: found,
        normalizedEnd: found + normalizedQuery.length,
      });
      pos = found + 1;
    }
  }

  pdfSearchState.matches = matches;

  if (matches.length > 0) {
    const currentPage = activeReadingPosition?.pageNumber ?? 1;
    const idx = matches.findIndex((m) => m.pageNumber >= currentPage);
    pdfSearchState.currentMatchIndex = idx >= 0 ? idx : 0;
  } else {
    pdfSearchState.currentMatchIndex = -1;
  }

  applyPdfSearchHighlights();
  syncPdfSearchUi();

  if (pdfSearchState.currentMatchIndex >= 0) {
    scrollToPdfSearchMatch(pdfSearchState.currentMatchIndex);
  }
}

function findPageElement(pageNumber: number): HTMLElement | null {
  const session = activePdfRenderSession;
  if (!session) return null;

  for (const plan of session.plans) {
    const el = plan.pageSlots.get(pageNumber);
    if (el) return el;
  }
  return null;
}

function getPdfSearchMatchRange(match: PdfSearchMatch): Range | null {
  const index = pdfSearchState.pageIndices.get(match.pageNumber);
  if (!index) return null;

  const { normChars } = index;
  if (match.normalizedStart >= normChars.length || match.normalizedEnd > normChars.length)
    return null;

  const startChar = normChars[match.normalizedStart];
  const endChar = normChars[match.normalizedEnd - 1];
  if (!startChar || !endChar) return null;

  const pageEl = findPageElement(match.pageNumber);
  if (!pageEl) return null;

  const textLayerEl = pageEl.querySelector(".textLayer");
  if (!textLayerEl) return null;

  const spans = Array.from(textLayerEl.querySelectorAll<HTMLElement>("span"));
  const startSpan = spans[startChar.itemIndex];
  const endSpan = spans[endChar.itemIndex];
  if (!startSpan?.firstChild || !endSpan?.firstChild) return null;

  try {
    const range = new Range();
    range.setStart(startSpan.firstChild, startChar.origOffset);
    range.setEnd(endSpan.firstChild, endChar.origOffsetEnd);
    return range;
  } catch {
    return null;
  }
}

function clearPdfSearchMarkEls() {
  for (const el of document.querySelectorAll(".pdf-search-mark")) {
    el.remove();
  }
}

function applyPdfSearchHighlights() {
  clearPdfSearchMarkEls();

  if (!pdfSearchState.isOpen || !pdfSearchState.query || pdfSearchState.matches.length === 0) {
    return;
  }

  for (let i = 0; i < pdfSearchState.matches.length; i++) {
    const match = pdfSearchState.matches[i];
    if (!match) continue;
    const range = getPdfSearchMatchRange(match);
    if (!range) continue;

    const pageEl = findPageElement(match.pageNumber);
    if (!pageEl) continue;

    const pageRect = pageEl.getBoundingClientRect();
    const isCurrent = i === pdfSearchState.currentMatchIndex;

    for (const rect of range.getClientRects()) {
      const mark = document.createElement("div");
      mark.className = isCurrent ? "pdf-search-mark pdf-search-mark--current" : "pdf-search-mark";
      mark.style.left = `${rect.left - pageRect.left}px`;
      mark.style.top = `${rect.top - pageRect.top}px`;
      mark.style.width = `${rect.width}px`;
      mark.style.height = `${rect.height}px`;
      pageEl.appendChild(mark);
    }
  }
}

function syncPdfSearchUi() {
  const countEl = document.querySelector<HTMLElement>("#pdf-search-count");
  if (!countEl) return;

  const { matches, currentMatchIndex } = pdfSearchState;
  if (matches.length === 0) {
    countEl.textContent = pdfSearchState.query ? "No matches" : "";
  } else {
    countEl.textContent = `${currentMatchIndex + 1} / ${matches.length}`;
  }
}

function scrollToPdfSearchMatch(index: number) {
  const match = pdfSearchState.matches[index];
  if (!match) return;

  const session = activePdfRenderSession;
  if (!session) return;

  const groupIndex = findPdfRenderGroupIndexForPage(session, match.pageNumber);
  if (groupIndex >= 0) {
    schedulePdfRenderWindowUpdate(session, groupIndex);
  }

  const attemptScroll = (attempts: number) => {
    const pageEl = findPageElement(match.pageNumber);
    if (!pageEl || pageEl.dataset.rendered !== "true") {
      if (attempts < 8) {
        requestAnimationFrame(() => attemptScroll(attempts + 1));
      }
      return;
    }
    const stageEl = session.stageEl;
    const stageRect = stageEl.getBoundingClientRect();
    const pageRect = pageEl.getBoundingClientRect();
    const pageTopInStage = stageEl.scrollTop + (pageRect.top - stageRect.top);
    stageEl.scrollTo({ top: Math.max(pageTopInStage - 32, 0), behavior: "smooth" });
    applyPdfSearchHighlights();
  };

  requestAnimationFrame(() => attemptScroll(0));
}

function navigatePdfSearchForward() {
  if (pdfSearchState.matches.length === 0) return;
  pdfSearchState.currentMatchIndex =
    (pdfSearchState.currentMatchIndex + 1) % pdfSearchState.matches.length;
  applyPdfSearchHighlights();
  syncPdfSearchUi();
  scrollToPdfSearchMatch(pdfSearchState.currentMatchIndex);
}

function navigatePdfSearchBackward() {
  if (pdfSearchState.matches.length === 0) return;
  pdfSearchState.currentMatchIndex =
    (pdfSearchState.currentMatchIndex - 1 + pdfSearchState.matches.length) %
    pdfSearchState.matches.length;
  applyPdfSearchHighlights();
  syncPdfSearchUi();
  scrollToPdfSearchMatch(pdfSearchState.currentMatchIndex);
}

function openPdfSearch() {
  const bar = document.querySelector<HTMLElement>("#pdf-search-bar");
  const input = document.querySelector<HTMLInputElement>("#pdf-search-input");
  if (!bar || !input) return;

  pdfSearchState.isOpen = true;
  bar.hidden = false;
  input.select();
  input.focus();
}

function closePdfSearch() {
  const bar = document.querySelector<HTMLElement>("#pdf-search-bar");
  if (!bar) return;

  if (pdfSearchState.searchTimer !== null) {
    window.clearTimeout(pdfSearchState.searchTimer);
    pdfSearchState.searchTimer = null;
  }

  pdfSearchState.isOpen = false;
  pdfSearchState.query = "";
  pdfSearchState.matches = [];
  pdfSearchState.currentMatchIndex = -1;
  pdfSearchState.pageIndices.clear();
  bar.hidden = true;

  applyPdfSearchHighlights();
  syncPdfSearchUi();
}

function isPdfSearchShortcut(event: KeyboardEvent): boolean {
  const isMac = navigator.platform.startsWith("Mac");
  return (
    event.key === "f" && (isMac ? event.metaKey : event.ctrlKey) && !event.shiftKey && !event.altKey
  );
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
  let anchorPageEl: HTMLElement = pageEls[0]!;

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

  const sourceType = viewerState.currentBook?.sourceType;

  try {
    if (sourceType === "epub" && activeReadingPosition.cfi) {
      await invoke("save_epub_position", {
        filePath: activeReadingPosition.filePath,
        cfi: activeReadingPosition.cfi,
      });
    } else if (sourceType !== "epub") {
      activeReadingPosition = await invoke<ReadingPosition>("save_reading_position", {
        filePath: activeReadingPosition.filePath,
        pageNumber: activeReadingPosition.pageNumber,
        pageOffsetRatio: activeReadingPosition.pageOffsetRatio,
      });
    }
  } catch (error) {
    console.error("Failed to save reading position:", error);
  }
}

function scheduleEpubPositionSave() {
  if (readingPositionSaveTimer !== null) {
    window.clearTimeout(readingPositionSaveTimer);
  }
  readingPositionSaveTimer = window.setTimeout(() => {
    void flushReadingPositionSave();
  }, 300);
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
  if (!nextState) return;
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
  if (!nextState) return;
  window.history.replaceState(nextState, "", buildNavigationUrl(nextState));
  syncNavigationControlsUi();
  suppressHistoryUpdates = true;
  void applyNavigationState(nextState).finally(() => {
    suppressHistoryUpdates = false;
  });
}

function resizeEpubRendition() {
  if (!activeEpubRendition) return;
  const el = document.querySelector<HTMLElement>("#epub-viewer");
  if (!el) return;
  activeEpubRendition.resize(el.clientWidth, el.clientHeight);
}

function destroyEpubBook() {
  if (activeEpubLinkMessageHandler) {
    window.removeEventListener("message", activeEpubLinkMessageHandler);
    activeEpubLinkMessageHandler = null;
  }
  activeEpubTotalPages = null;
  activeEpubRendition = null;
  activeEpubIsRtl = false;
  tocPanelOpen = false;
  if (activeEpubBook) {
    activeEpubBook.destroy();
    activeEpubBook = null;
  }
  epubRenderToken += 1;
  const epubViewerEl = document.querySelector<HTMLElement>("#epub-viewer");
  if (epubViewerEl) {
    epubViewerEl.innerHTML = "";
    epubViewerEl.hidden = true;
    epubViewerEl.dataset.filePath = "";
  }
}

type EpubLinkMessage = {
  type: "riida:epub-link";
  href: string;
  filePath: string;
  sectionIndex: number;
};

function isEpubLinkMessage(value: unknown): value is EpubLinkMessage {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    record.type === "riida:epub-link" &&
    typeof record.href === "string" &&
    typeof record.filePath === "string" &&
    typeof record.sectionIndex === "number"
  );
}

function installEpubLinkBridge(contents: import("epubjs").Contents, filePath: string) {
  const doc = contents.document;
  if (!doc?.documentElement) {
    return;
  }

  doc.documentElement.dataset.riidaFilePath = filePath;
  doc.documentElement.dataset.riidaSectionIndex = String(contents.sectionIndex);
}

function captureEpubCfiForHistory(rendition: import("epubjs").Rendition) {
  try {
    const loc = rendition.location as { start?: { cfi?: string } } | null;
    const cfi = loc?.start?.cfi;
    if (cfi && activeReadingPosition) {
      activeReadingPosition = { ...activeReadingPosition, cfi };
    }
  } catch {
    // rendition may not have a location yet; skip silently
  }
}

async function epubDisplayHref(
  book: import("epubjs").Book,
  rendition: import("epubjs").Rendition,
  target: string,
) {
  // Prefer CFI-based navigation to avoid paginated-layout breakage on anchor
  // jumps. epub.js's rendition.display(href) can reset the paginator to a
  // single-page view when the href contains a fragment; going through CFI
  // preserves the spread/paginated flow.
  try {
    const bookLocations = book.locations as unknown as {
      cfiFromHref?: (href: string) => string | null;
    };
    const cfi = bookLocations.cfiFromHref?.(target);
    if (cfi) {
      await rendition.display(cfi);
      return;
    }
  } catch {
    // fall through to plain href display
  }
  await rendition.display(target);
}

function syncEpubLinkOverlays(
  rendition: import("epubjs").Rendition,
  book: import("epubjs").Book,
  epubViewerEl: HTMLElement,
) {
  let overlayRoot = epubViewerEl.querySelector<HTMLElement>(".epub-link-overlays");
  if (!overlayRoot) {
    overlayRoot = document.createElement("div");
    overlayRoot.className = "epub-link-overlays";
    epubViewerEl.appendChild(overlayRoot);
  }

  overlayRoot.innerHTML = "";
  const viewerRect = epubViewerEl.getBoundingClientRect();
  const contentsList = rendition.getContents() as unknown as import("epubjs").Contents[];

  for (const contents of contentsList) {
    const frameEl = contents.window?.frameElement;
    if (!(frameEl instanceof HTMLIFrameElement)) {
      continue;
    }

    const frameRect = frameEl.getBoundingClientRect();
    const links = contents.document
      ? (Array.from(contents.document.querySelectorAll("a[href]")) as HTMLAnchorElement[])
      : null;
    if (!links) {
      continue;
    }

    for (const link of links) {
      const href = link.getAttribute("href");
      if (!href) {
        continue;
      }

      const rect = link.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        continue;
      }

      const action = resolveEpubLinkAction(
        href,
        book.spine.get(contents.sectionIndex)?.href ?? null,
      );
      if (!action) {
        continue;
      }

      const overlay = document.createElement("button");
      overlay.type = "button";
      overlay.className = "epub-link-overlay";
      overlay.style.left = `${frameRect.left - viewerRect.left + rect.left}px`;
      overlay.style.top = `${frameRect.top - viewerRect.top + rect.top}px`;
      overlay.style.width = `${rect.width}px`;
      overlay.style.height = `${rect.height}px`;
      overlay.setAttribute("aria-label", href);
      overlay.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (action.kind === "external") {
          void openUrl(action.target);
          return;
        }
        captureEpubCfiForHistory(rendition);
        syncNavigationHistory("push");
        void epubDisplayHref(book, rendition, action.target);
      });
      overlayRoot.appendChild(overlay);
    }
  }
}

async function renderCurrentPage() {
  const frame = document.querySelector<HTMLIFrameElement>("#pdf-frame");
  const viewerStageEl = currentViewerStage();
  const pdfjsViewerEl = document.querySelector<HTMLElement>("#pdfjs-viewer");
  const epubViewerEl = document.querySelector<HTMLElement>("#epub-viewer");
  const snapshot = lastSnapshot;

  if (
    !frame ||
    !viewerStageEl ||
    !pdfjsViewerEl ||
    !epubViewerEl ||
    !viewerState.currentBook ||
    !snapshot
  ) {
    return;
  }

  const previousFilePath = pdfjsViewerEl.dataset.filePath;
  if (previousFilePath && previousFilePath === viewerState.currentBook.filePath) {
    activeReadingPosition = captureReadingPositionFromViewer();
  }

  const sourceUrl = convertFileSrc(viewerState.currentBook.filePath);

  if (viewerState.currentBook.sourceType === "epub") {
    applyEpubViewerColors(viewerSettings.backgroundMode);
    await maybeShowEpubPreviewNotice();
    destroyEpubBook();
    activePdfRenderSession = null;
    activePdfOutline = null;
    frame.hidden = true;
    frame.src = "about:blank";
    frame.dataset.filePath = "";
    pdfjsViewerEl.hidden = true;
    pdfjsViewerEl.innerHTML = "";
    pdfjsViewerEl.dataset.filePath = "";
    epubViewerEl.hidden = false;
    epubViewerEl.dataset.filePath = viewerState.currentBook.filePath;
    epubViewerEl.innerHTML = "";
    const epubLoadingEl = document.createElement("div");
    epubLoadingEl.className = "epub-loading";
    const epubLoadingSpinnerEl = document.createElement("div");
    epubLoadingSpinnerEl.className = "epub-loading-spinner";
    epubLoadingEl.appendChild(epubLoadingSpinnerEl);
    const epubLoadingLabelEl = document.createElement("div");
    epubLoadingLabelEl.className = "epub-loading-label";
    epubLoadingLabelEl.textContent = "Loading EPUB...";
    epubLoadingEl.appendChild(epubLoadingLabelEl);
    epubViewerEl.appendChild(epubLoadingEl);

    epubRenderToken += 1;
    const currentToken = epubRenderToken;

    try {
      const EpubModule = await loadEpubJs();
      if (currentToken !== epubRenderToken) return;

      const Epub = EpubModule.default;
      const book = Epub(sourceUrl);
      activeEpubBook = book;
      await book.ready;
      if (currentToken !== epubRenderToken) return;

      tocPanelOpen = false;
      buildEpubToc();
      syncTocUi();

      // Fast path: reuse previously-generated locations when the file
      // hasn't changed. Falls back to background generation after display.
      const locationsFilePath = viewerState.currentBook.filePath;
      const locationsFileSize = viewerState.currentBook.fileSize;
      const cachedLocations = loadCachedEpubLocations(locationsFilePath, locationsFileSize);
      let locationsReady = false;
      if (cachedLocations) {
        try {
          book.locations.load(cachedLocations);
          activeEpubTotalPages = Math.max(book.locations.length(), 1);
          locationsReady = true;
        } catch (err) {
          console.warn("[riida] failed to load cached EPUB locations:", err);
        }
      }
      syncViewerPageJumpUi();

      // Detect page-progression-direction for correct key mapping.
      // DPFJ guide §ページ進行方向の遵守: direction is from OPF spine, not writing-mode.
      // In rtl books (Japanese vertical text etc.) ArrowLeft = next page, ArrowRight = prev.
      // epub.js exposes package/spine internals not covered by the public typings.
      const bookInternal = book as unknown as {
        spine?: { direction?: string };
        package?: { metadata?: { direction?: string; rendition_layout?: string } };
      };
      const spineDirection =
        bookInternal.spine?.direction ?? bookInternal.package?.metadata?.direction ?? "ltr";
      activeEpubIsRtl = spineDirection === "rtl";

      // Detect fixed-layout vs. reflow from OPF metadata.
      // DPFJ guide §固定レイアウト: pre-paginated books use SVG-wrapped images and
      // require flow:"pre-paginated" so epub.js renders each spine item as a single page.
      const renditionLayout = bookInternal.package?.metadata?.rendition_layout ?? "";
      const isPrePaginated = renditionLayout === "pre-paginated";
      const flow: string = isPrePaginated ? "pre-paginated" : "paginated";
      const spread = isPrePaginated
        ? "auto"
        : viewerSettings.pageMode === "spread"
          ? "always"
          : "none";

      book.spine.hooks.content.register((doc: Document, section: { index: number }) => {
        doc.documentElement?.setAttribute(
          "data-riida-file-path",
          viewerState.currentBook?.filePath ?? "",
        );
        doc.documentElement?.setAttribute("data-riida-section-index", String(section.index));
      });

      // Ensure the viewer element has actually been laid out before
      // creating the rendition. WKWebView occasionally reports 0 for
      // clientWidth/clientHeight on the first frame after show; epub.js
      // then locks the stage to 0x0 and never recovers. Poll up to ~20
      // frames for a non-zero size so the stage starts at the right size.
      for (let attempts = 0; attempts < 20; attempts += 1) {
        if (epubViewerEl.clientWidth > 0 && epubViewerEl.clientHeight > 0) break;
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        if (currentToken !== epubRenderToken) return;
      }

      const rendition = book.renderTo(epubViewerEl, {
        width: "100%",
        height: "100%",
        spread,
        flow,
        allowScriptedContent: true,
      });

      rendition.themes.default({
        html: {
          "background-color": `${viewerColorPaletteForMode(viewerSettings.backgroundMode).background} !important`,
          color: `${viewerColorPaletteForMode(viewerSettings.backgroundMode).foreground} !important`,
        },
        // DPFJ guide §ページメディアの余白: RS should not add its own margins to body.
        // epub.js injects padding by default; suppress it so the book's own CSS controls spacing.
        body: {
          "background-color": `${viewerColorPaletteForMode(viewerSettings.backgroundMode).background} !important`,
          color: `${viewerColorPaletteForMode(viewerSettings.backgroundMode).foreground} !important`,
          padding: "0 !important",
          margin: "0 !important",
        },
        a: {
          color: `${viewerColorPaletteForMode(viewerSettings.backgroundMode).link} !important`,
        },
        pre: {
          "white-space": "pre-wrap !important",
          "word-break": "break-all !important",
          "overflow-wrap": "break-word !important",
        },
        code: {
          "word-break": "break-all !important",
          "overflow-wrap": "break-word !important",
        },
      });

      const contentHooks = rendition.hooks.content.list();
      if (contentHooks.length > 0) {
        rendition.hooks.content.deregister(contentHooks[0]);
      }

      rendition.hooks.content.register((contents: import("epubjs").Contents) => {
        try {
          installEpubLinkBridge(contents, viewerState.currentBook?.filePath ?? "");
          if (contents.document) {
            applyEpubColorsToDocument(
              contents.document,
              viewerColorPaletteForMode(viewerSettings.backgroundMode),
            );
            injectEpubWritingModeCSS(contents.document);
          }
        } catch (err) {
          console.error("[riida] epub link hook failed:", err);
        }
      });

      activeEpubLinkMessageHandler = (event: MessageEvent) => {
        if (currentToken !== epubRenderToken || !isEpubLinkMessage(event.data)) {
          return;
        }

        const currentBook = viewerState.currentBook;
        if (!currentBook || currentBook.sourceType !== "epub") {
          return;
        }

        if (event.data.filePath !== currentBook.filePath) {
          return;
        }

        const sectionHref = book.spine.get(event.data.sectionIndex)?.href ?? null;
        const action = resolveEpubLinkAction(event.data.href, sectionHref);
        if (!action) {
          return;
        }

        if (action.kind === "external") {
          void openUrl(action.target);
          return;
        }

        captureEpubCfiForHistory(rendition);
        syncNavigationHistory("push");
        void epubDisplayHref(book, rendition, action.target);
      };
      window.addEventListener("message", activeEpubLinkMessageHandler);

      const restoreCfi = activeReadingPosition?.cfi ?? undefined;
      await rendition.display(restoreCfi);
      if (currentToken !== epubRenderToken) return;

      activeEpubRendition = rendition;
      applyViewerVerticalGapMode(viewerSettings.verticalGapMode);
      applyEpubViewerColors(viewerSettings.backgroundMode);
      applyEpubFontSize(viewerSettings.epubFontSize);

      // Safety net: if the initial render ended up at zero dimensions
      // (WKWebView can report 0 clientWidth/Height on first attach),
      // force resize + redisplay before hiding the spinner. epub.js's
      // own onResized only re-displays when rendition.location is set,
      // which can fail to happen after a 0x0 initial render.
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (currentToken !== epubRenderToken) return;
      const iframeEl = epubViewerEl.querySelector<HTMLIFrameElement>("iframe");
      if (!iframeEl || iframeEl.clientWidth === 0 || iframeEl.clientHeight === 0) {
        resizeEpubRendition();
        try {
          await rendition.display(restoreCfi);
        } catch (err) {
          console.warn("[riida] epub redisplay after resize failed:", err);
        }
        if (currentToken !== epubRenderToken) return;
      }

      syncEpubLinkOverlays(rendition, book, epubViewerEl);
      epubLoadingEl.remove();

      // Slow path: compute pagination in the background so the first
      // page renders immediately. Result is cached for next open.
      if (!locationsReady) {
        void (async () => {
          try {
            await book.locations.generate(1200);
            if (currentToken !== epubRenderToken) return;
            activeEpubTotalPages = Math.max(book.locations.length(), 1);
            saveCachedEpubLocations(locationsFilePath, locationsFileSize, book.locations.save());
            syncViewerPageJumpUi();
          } catch (err) {
            console.warn("[riida] failed to generate EPUB locations:", err);
          }
        })();
      }

      rendition.on("relocated", (location: import("epubjs").Location) => {
        const cfi = location.start.cfi;
        const currentBook = viewerState.currentBook;
        if (!cfi || !currentBook || currentBook.sourceType !== "epub") return;
        const totalPages = activeEpubTotalPages ?? Math.max(book.locations.length(), 1);
        const currentPageNumber = epubPageNumberFromLocation(location.start.location, totalPages);
        activeReadingPosition = {
          filePath: currentBook.filePath,
          pageNumber: currentPageNumber,
          pageOffsetRatio: 0,
          cfi,
          updatedAt: activeReadingPosition?.updatedAt ?? null,
        };
        syncEpubLinkOverlays(rendition, book, epubViewerEl);
        syncViewerPageJumpUi();
        scheduleEpubPositionSave();
      });

      rendition.on("rendered", () => {
        syncEpubLinkOverlays(rendition, book, epubViewerEl);
        syncEpubCoverOverlay(epubViewerEl);
      });
    } catch (error) {
      if (currentToken !== epubRenderToken) return;
      epubViewerEl.innerHTML = "";
      const errorEl = document.createElement("div");
      errorEl.className = "pdfjs-loading";
      errorEl.textContent = `Failed to open EPUB: ${String(error)}`;
      epubViewerEl.appendChild(errorEl);
    }
    return;
  }

  destroyEpubBook();

  if (snapshot.pdfRenderer === "pdfjs") {
    applyEpubViewerColors("inherit-theme");
    applyPdfViewerBackground(viewerSettings.backgroundMode);
    syncImmediatePdfScrollMode();
    activePdfRenderSession = null;
    activePdfOutline = null;
    frame.hidden = true;
    frame.src = "about:blank";
    frame.dataset.filePath = "";
    pdfjsViewerEl.hidden = false;
    pdfjsViewerEl.innerHTML = "";
    pdfjsViewerEl.dataset.filePath = viewerState.currentBook.filePath;
    pdfjsViewerEl.dataset.position = viewerSettings.alignMode;
    applyViewerVerticalGapMode(viewerSettings.verticalGapMode);

    closePdfSearch();
    pdfRenderToken += 1;
    const currentToken = pdfRenderToken;
    const loadingEl = document.createElement("div");
    loadingEl.className = "pdfjs-loading";
    loadingEl.textContent = "Rendering PDF...";
    pdfjsViewerEl.appendChild(loadingEl);

    let passwordCancelled = false;
    try {
      const { getDocument } = await loadPdfJsRuntime();
      const filePath = viewerState.currentBook.filePath;
      const savedPassword = await invoke<string | null>("get_pdf_password", { filePath });
      let usedPassword: string | null = savedPassword;
      const documentTask = getDocument({
        url: sourceUrl,
        cMapUrl: "/pdfjs/cmaps/node_modules/pdfjs-dist/cmaps/",
        cMapPacked: true,
        standardFontDataUrl: "/pdfjs/standard_fonts/node_modules/pdfjs-dist/standard_fonts/",
        useSystemFonts: true,
        disableFontFace: false,
        password: savedPassword ?? undefined,
      });
      documentTask.onPassword = async (updatePassword: (pw: string) => void, reason: number) => {
        // reason 1 = needs password, reason 2 = wrong password
        const isRetry = reason === 2;
        if (isRetry) {
          usedPassword = null;
        }
        const entered = await promptPdfPassword(isRetry);
        if (entered !== null) {
          usedPassword = entered;
          updatePassword(entered);
        } else {
          // User cancelled — destroy the task so documentTask.promise rejects
          passwordCancelled = true;
          void documentTask.destroy();
        }
      };
      const pdfDocument = await documentTask.promise;
      if (usedPassword !== null && usedPassword !== savedPassword) {
        await invoke("save_pdf_password", { filePath, password: usedPassword });
      }

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
      const targetHeight = Math.max(260, viewerHeight - 56);

      // Strategy A: in fit-height + spread mode, split any 2-page group whose
      // combined rendered width would exceed the available viewer width.
      let layoutGroups = pageGroups;
      if (viewerSettings.pageMode === "spread" && viewerSettings.zoomMode === "fit-height") {
        layoutGroups = [];
        for (const group of pageGroups) {
          if (group.length === 2 && group[0] !== undefined && group[1] !== undefined) {
            const g0 = group[0];
            const g1 = group[1];
            const vp0 = (await pdfDocument.getPage(g0)).getViewport({ scale: 1 });
            const vp1 = (await pdfDocument.getPage(g1)).getViewport({ scale: 1 });
            const fitScale = targetHeight / Math.max(vp0.height, 1);
            const combinedWidth = (vp0.width + vp1.width) * fitScale + pageGap;
            if (combinedWidth > availableWidth) {
              layoutGroups.push([g0]);
              layoutGroups.push([g1]);
              continue;
            }
          }
          layoutGroups.push(group);
        }
      }

      const renderPlans: PdfRenderPlan[] = [];

      for (const [groupIndex, group] of layoutGroups.entries()) {
        const visualOrder = getVisualPageOrder(group, viewerSettings);
        const spreadEl = document.createElement("section");
        spreadEl.className = "pdfjs-spread";
        spreadEl.dataset.pageCount = String(visualOrder.length);
        spreadEl.dataset.binding = viewerSettings.bindingDirection;
        spreadEl.dataset.cover = String(group.length === 1);
        pdfjsViewerEl.appendChild(spreadEl);

        const samplePage = await pdfDocument.getPage(group[0]!);
        const sampleViewport = samplePage.getViewport({ scale: 1 });
        const targetWidth =
          viewerSettings.pageMode === "spread"
            ? Math.max(220, Math.floor(availableWidth / Math.max(visualOrder.length, 1)))
            : Math.max(320, availableWidth);

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
              layoutGroups.findIndex((group) => group.includes(restoreTargetPage)),
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

      // Load PDF outline (TOC) asynchronously so it does not block rendering.
      tocPanelOpen = false;
      activePdfOutline = null;
      syncTocUi();
      if (pdfDocument.getOutline) {
        void pdfDocument.getOutline().then((outline) => {
          if (activePdfRenderSession?.token !== currentToken) return;
          activePdfOutline = outline ?? null;
          buildPdfToc();
          syncTocUi();
        });
      }
    } catch (error) {
      if (passwordCancelled) {
        pdfjsViewerEl.innerHTML = "";
        navigateBack();
        return;
      }
      pdfjsViewerEl.innerHTML = "";
      const errorEl = document.createElement("div");
      errorEl.className = "pdfjs-loading";
      const msg = String(error);
      errorEl.textContent =
        msg.includes("PasswordException") || msg.includes("No password given")
          ? "This PDF requires a password."
          : `Failed to render with PDF.js: ${msg}`;
      pdfjsViewerEl.appendChild(errorEl);
    }

    return;
  }

  closePdfSearch();
  pdfRenderToken += 1;
  activePdfRenderSession = null;
  activePdfOutline = null;
  applyEpubViewerColors("inherit-theme");
  applyPdfViewerBackground("inherit-theme");
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
  const epubViewerEl = document.querySelector<HTMLElement>("#epub-viewer");
  const currentBook = viewerState.currentBook;

  if (!frame || !pdfjsViewerEl || !epubViewerEl || !currentBook) {
    return false;
  }

  if (currentBook.sourceType === "epub") {
    return (
      epubViewerEl.hidden ||
      epubViewerEl.dataset.filePath !== currentBook.filePath ||
      activeEpubBook === null
    );
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
          searchQuery: "",
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

  const enabledExternalSources = lastAppConfig?.enabledExternalSources ?? [];
  const kindleEnabled = enabledExternalSources.includes("kindle");
  const externalBooks = snapshot.books.filter((book) => book.sourceType !== "pdf");
  const kindleCount = externalBooks.filter((book) => book.sourceType === "kindle").length;
  const customSources = snapshot.customSources ?? [];
  const hasExternalSection = (kindleEnabled && kindleCount > 0) || customSources.length > 0;

  if (hasExternalSection) {
    const externalHeader = document.createElement("p");
    externalHeader.className = "nav-section-title";
    externalHeader.innerHTML =
      '<i class="fa-solid fa-up-right-from-square" aria-hidden="true"></i><span>EXTERNAL</span>';
    navEl.appendChild(externalHeader);

    if (kindleEnabled && kindleCount > 0) {
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

    for (const source of customSources) {
      const count = externalBooks.filter((book) => book.sourceType === source.id).length;
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
      button.classList.toggle("is-active", viewerState.activeExternalSource === source.id);
      button.innerHTML =
        `<span><i class="${source.icon}" aria-hidden="true"></i> ${source.name}</span><small>` +
        String(count) +
        "</small>";
      button.addEventListener("click", () => {
        void navigateToState(
          {
            bookFilePath: null,
            activeDirectory: null,
            activeTag: null,
            activeExternalSource: source.id,
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

type LibraryViewMode = "list" | "grid";

function getLibraryViewMode(): LibraryViewMode {
  return localStorage.getItem("riida.libraryViewMode") === "grid" ? "grid" : "list";
}

function setLibraryViewMode(mode: LibraryViewMode) {
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

  const metaEl = document.createElement("small");
  metaEl.className = "book-meta";
  metaEl.textContent = book.sourceType === "pdf" ? formatFileSize(book.fileSize) : "";

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
  copyEl.appendChild(tagsRowEl);
  if (metaEl.textContent) {
    copyEl.appendChild(metaEl);
  }

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

function hideBookGridPopup(immediate: boolean) {
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

  const viewMode = getLibraryViewMode();
  const listEl = document.createElement("ul");
  listEl.className = viewMode === "grid" ? "books grid-view" : "books";

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
    titleEl.textContent = book.title ?? book.fileName;

    const pathEl = document.createElement("span");
    pathEl.textContent = book.locationLabel ?? formatBookLocation(book.filePath, cachedHomeDir);

    const metaEl = document.createElement("small");
    metaEl.className = "book-meta";
    metaEl.textContent = book.sourceType === "pdf" ? formatFileSize(book.fileSize) : "";

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
    itemEl.appendChild(thumbEl);
    itemEl.appendChild(bodyEl);

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

  const libraryAddKindleEl = document.querySelector<HTMLButtonElement>("#library-add-kindle");
  if (libraryAddKindleEl) {
    libraryAddKindleEl.hidden = viewerState.activeExternalSource !== "kindle";
  }
  const libraryAddCustomEl = document.querySelector<HTMLButtonElement>("#library-add-custom");
  if (libraryAddCustomEl) {
    const activeCustomSource =
      viewerState.activeExternalSource && viewerState.activeExternalSource !== "kindle"
        ? ((lastSnapshot?.customSources ?? []).find(
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
  const viewerScrollModeEl = document.querySelector<HTMLSelectElement>("#viewer-scroll-mode");
  const viewerCoverModeEl = document.querySelector<HTMLInputElement>("#viewer-cover-mode");
  const viewerEpubFontSizeEl = document.querySelector<HTMLInputElement>("#viewer-epub-font-size");
  const viewerEpubFontSizeOutputEl = document.querySelector<HTMLOutputElement>(
    "#viewer-epub-font-size-output",
  );
  const viewerBackgroundInheritEl = document.querySelector<HTMLInputElement>(
    "#viewer-background-inherit",
  );
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
  const bookMetadataDeleteEl = document.querySelector<HTMLButtonElement>("#book-metadata-delete");
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

  const searchSuggestionsEl = document.querySelector<HTMLElement>("#library-search-suggestions");

  let activeSuggestionIndex = -1;
  let currentSuggestions: SearchSuggestion[] = [];

  function renderSearchSuggestions() {
    if (!searchInput || !searchSuggestionsEl) return;
    const cursor = searchInput.selectionStart ?? searchInput.value.length;
    const valueSource = buildValueSource(lastSnapshot?.books ?? []);
    currentSuggestions = computeSuggestions(searchInput.value, cursor, valueSource);
    activeSuggestionIndex = -1;

    searchSuggestionsEl.innerHTML = "";
    const hasSuggestions = currentSuggestions.length > 0;
    searchSuggestionsEl.hidden = !hasSuggestions;
    searchInput.setAttribute("aria-expanded", hasSuggestions ? "true" : "false");

    for (let i = 0; i < currentSuggestions.length; i++) {
      const s = currentSuggestions[i];
      if (!s) continue;
      const li = document.createElement("li");
      li.role = "option";
      li.setAttribute("aria-selected", "false");

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "library-search-suggestion";

      const label = document.createElement("span");
      label.className = "library-search-suggestion-label";

      if (s.kind === "field") {
        label.textContent = s.completion;
        const hint = document.createElement("span");
        hint.className = "library-search-suggestion-hint";
        hint.textContent = "field";
        btn.append(label, hint);
      } else {
        label.textContent = s.completion;
        const hint = document.createElement("span");
        hint.className = "library-search-suggestion-hint";
        hint.textContent = s.field;
        btn.append(label, hint);
      }

      btn.addEventListener("mousedown", (e) => {
        e.preventDefault(); // keep input focus
        applySearchSuggestion(i);
      });

      li.appendChild(btn);
      searchSuggestionsEl.appendChild(li);
    }
  }

  function applySearchSuggestion(index: number) {
    if (!searchInput || index < 0 || index >= currentSuggestions.length) return;
    const suggestion = currentSuggestions[index];
    if (!suggestion) return;
    const { value } = applySuggestion(
      searchInput.value,
      searchInput.selectionStart ?? searchInput.value.length,
      suggestion,
    );
    // Field completions end with ":" — don't add a space so the user can type the value directly.
    // Value completions end with the value itself — add a space to start the next token.
    const isFieldCompletion = suggestion.kind === "field";
    const finalValue = isFieldCompletion || value.endsWith(" ") ? value : `${value} `;
    searchInput.value = finalValue;
    searchInput.setSelectionRange(finalValue.length, finalValue.length);
    closeSearchSuggestions();
    void navigateToState(
      {
        bookFilePath: null,
        activeDirectory: null,
        activeTag: null,
        activeExternalSource: null,
        activeTagDirectOnly: false,
        searchQuery: searchInput.value,
      },
      "replace",
    );
    renderSearchSuggestions();
  }

  function setActiveSuggestion(index: number) {
    if (!searchSuggestionsEl) return;
    const items = searchSuggestionsEl.querySelectorAll<HTMLButtonElement>(
      ".library-search-suggestion",
    );
    items.forEach((btn, i) => {
      const selected = i === index;
      btn.setAttribute("aria-selected", selected ? "true" : "false");
      btn.parentElement?.setAttribute("aria-selected", selected ? "true" : "false");
    });
    activeSuggestionIndex = index;
  }

  function closeSearchSuggestions() {
    if (!searchSuggestionsEl || !searchInput) return;
    searchSuggestionsEl.hidden = true;
    searchInput.setAttribute("aria-expanded", "false");
    currentSuggestions = [];
    activeSuggestionIndex = -1;
  }

  let librarySearchTimer: number | null = null;

  searchInput?.addEventListener("input", () => {
    renderSearchSuggestions();
    if (librarySearchTimer !== null) window.clearTimeout(librarySearchTimer);
    librarySearchTimer = window.setTimeout(() => {
      librarySearchTimer = null;
      void navigateToState(
        {
          bookFilePath: null,
          activeDirectory: null,
          activeTag: null,
          activeExternalSource: null,
          activeTagDirectOnly: false,
          searchQuery: searchInput.value,
        },
        "replace",
      );
    }, 150);
  });

  searchInput?.addEventListener("keydown", (e) => {
    if (searchSuggestionsEl?.hidden) return;
    const count = currentSuggestions.length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveSuggestion((activeSuggestionIndex + 1) % count);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveSuggestion((activeSuggestionIndex - 1 + count) % count);
    } else if (e.key === "Enter" && activeSuggestionIndex >= 0) {
      e.preventDefault();
      applySearchSuggestion(activeSuggestionIndex);
    } else if (e.key === "Escape") {
      closeSearchSuggestions();
    }
  });

  searchInput?.addEventListener("blur", () => {
    // Delay so mousedown on suggestion fires first
    setTimeout(closeSearchSuggestions, 150);
  });

  searchInput?.addEventListener("focus", () => {
    if (searchInput.value) renderSearchSuggestions();
  });

  searchInput?.addEventListener("click", () => {
    renderSearchSuggestions();
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

  const libraryViewToggleEl = document.querySelector<HTMLButtonElement>("#library-view-toggle");
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
      if (lastSnapshot) {
        renderApp();
      }
    });
  }

  libraryAddKindleEl?.addEventListener("click", () => {
    openNewKindleBookEditor();
  });

  const libraryAddCustomEl2 = document.querySelector<HTMLButtonElement>("#library-add-custom");
  libraryAddCustomEl2?.addEventListener("click", () => {
    const source =
      viewerState.activeExternalSource && viewerState.activeExternalSource !== "kindle"
        ? (lastSnapshot?.customSources ?? []).find((s) => s.id === viewerState.activeExternalSource)
        : undefined;
    if (source) {
      openNewCustomBookEditor(source);
    }
  });

  const configAddCustomSourceEl = document.querySelector<HTMLButtonElement>(
    "#config-add-custom-source",
  );
  configAddCustomSourceEl?.addEventListener("click", () => openCustomSourceEditor());

  const customSourceSaveEl = document.querySelector<HTMLButtonElement>("#custom-source-save");
  customSourceSaveEl?.addEventListener("click", () => void saveCustomSource());

  const customSourceCancelEl = document.querySelector<HTMLButtonElement>("#custom-source-cancel");
  customSourceCancelEl?.addEventListener("click", () => closeCustomSourceEditor());

  const customSourceNameEl = document.querySelector<HTMLInputElement>("#custom-source-name");
  customSourceNameEl?.addEventListener("input", () => {
    customSourceEditorState.name = customSourceNameEl.value;
  });

  const iconPickerEl = document.querySelector<HTMLElement>("#custom-source-icon-picker");
  if (iconPickerEl && iconPickerEl.childElementCount === 0) {
    for (const icon of CUSTOM_SOURCE_ICONS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "custom-source-icon-option";
      btn.dataset.icon = icon.cls;
      btn.title = icon.label;
      btn.innerHTML = `<i class="${icon.cls}" aria-hidden="true"></i>`;
      btn.addEventListener("click", () => {
        customSourceEditorState.icon = icon.cls;
        syncCustomSourceEditorUi();
      });
      iconPickerEl.appendChild(btn);
    }
  }

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
        theme: lastAppConfig?.theme ?? "default",
        enabledExternalSources: lastAppConfig?.enabledExternalSources ?? ["kindle"],
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
  bookMetadataDeleteEl?.addEventListener("click", () => {
    void deleteBookMetadataChanges();
  });
  document
    .querySelector<HTMLButtonElement>("#book-metadata-epub-import")
    ?.addEventListener("click", () => {
      const { filePath, loadToken } = bookMetadataEditorState;
      if (!filePath) return;
      void importMetadataFromEpub(filePath, loadToken, { overwriteNonEmpty: true });
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
  bookMetadataReleaseDateEl?.addEventListener("blur", () => {
    const normalized = normalizeReleaseDateInput(bookMetadataReleaseDateEl.value);
    if (normalized !== bookMetadataReleaseDateEl.value) {
      bookMetadataReleaseDateEl.value = normalized;
      bookMetadataEditorState.releaseDate = normalized;
    }
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

  document.querySelector<HTMLButtonElement>("#epub-toc-toggle")?.addEventListener("click", () => {
    tocPanelOpen = !tocPanelOpen;
    syncTocUi();
  });

  const rerenderPdfJs = () => {
    const sourceType = currentViewerSettingsSourceType();
    syncViewerSettingsUi();
    if (sourceType === "pdf" && lastSnapshot?.pdfRenderer === "pdfjs" && viewerState.currentBook) {
      void renderCurrentPage();
    }
  };

  const persistViewerSettings = async () => {
    const currentFilePath = viewerState.currentBook?.filePath ?? null;
    const sourceType = currentViewerSettingsSourceType() ?? viewerSettings.sourceType;

    if (viewerSettings.scope === "file" && currentFilePath) {
      const payload = await invoke<ViewerSettingsPayload>("save_file_viewer_preferences", {
        filePath: currentFilePath,
        sourceType,
        preferences: currentViewerPreferences(),
      });
      applyViewerSettingsPayload(payload, sourceType, "file");
      return;
    }

    const payload = await invoke<ViewerSettingsPayload>("save_default_viewer_preferences", {
      currentFilePath,
      sourceType,
      preferences: currentViewerPreferences(),
    });
    applyViewerSettingsPayload(payload, sourceType, "global");
  };

  const updateViewerSettings = (mutate: () => void, options: { rerenderPdf?: boolean } = {}) => {
    const { rerenderPdf = true } = options;
    mutate();
    syncViewerSettingsUi();
    syncImmediatePdfBackgroundPreview();
    void persistViewerSettings()
      .catch((error) => {
        console.error("Failed to save viewer preferences:", error);
      })
      .finally(() => {
        if (rerenderPdf) {
          rerenderPdfJs();
        }
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
    updateViewerSettings(
      () => {
        mutateEditingViewerSettings((preferences) => {
          preferences.verticalGapMode =
            viewerVerticalGapModeEl.value as ViewerSettings["verticalGapMode"];
        });
        syncImmediateViewerLayoutPreview();
      },
      { rerenderPdf: false },
    );
  });

  viewerCoverModeEl?.addEventListener("change", () => {
    updateViewerSettings(() => {
      mutateEditingViewerSettings((preferences) => {
        preferences.treatFirstPageAsCover = viewerCoverModeEl.checked;
      });
    });
  });

  viewerScrollModeEl?.addEventListener("change", () => {
    updateViewerSettings(
      () => {
        mutateEditingViewerSettings((preferences) => {
          preferences.scrollMode = viewerScrollModeEl.value as ViewerSettings["scrollMode"];
        });
        syncImmediatePdfScrollMode();
      },
      { rerenderPdf: false },
    );
  });

  viewerEpubFontSizeEl?.addEventListener("input", () => {
    const fontSize = Number(viewerEpubFontSizeEl.value);
    if (viewerEpubFontSizeOutputEl) {
      viewerEpubFontSizeOutputEl.value = `${fontSize}%`;
    }
    mutateEditingViewerSettings((preferences) => {
      preferences.epubFontSize = fontSize;
    });
    applyEpubFontSize(fontSize);
  });

  viewerEpubFontSizeEl?.addEventListener("change", () => {
    updateViewerSettings(
      () => {
        mutateEditingViewerSettings((preferences) => {
          preferences.epubFontSize = Number(viewerEpubFontSizeEl.value);
        });
      },
      { rerenderPdf: false },
    );
  });

  bindViewerBackgroundOptionGroup("viewer-background-mode", (value) => {
    updateViewerSettings(
      () => {
        mutateEditingViewerSettings((preferences) => {
          preferences.backgroundMode = value;
        });
      },
      { rerenderPdf: false },
    );
  });

  viewerBackgroundInheritEl?.addEventListener("change", () => {
    updateViewerSettings(
      () => {
        mutateEditingViewerSettings((preferences) => {
          preferences.backgroundMode = viewerBackgroundInheritEl.checked
            ? "inherit-theme"
            : preferredExplicitViewerBackgroundMode(preferences.backgroundMode);
        });
      },
      { rerenderPdf: false },
    );
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

  const pdfSearchInputEl = document.querySelector<HTMLInputElement>("#pdf-search-input");
  const pdfSearchPrevEl = document.querySelector<HTMLButtonElement>("#pdf-search-prev");
  const pdfSearchNextEl = document.querySelector<HTMLButtonElement>("#pdf-search-next");
  const pdfSearchCloseEl = document.querySelector<HTMLButtonElement>("#pdf-search-close");

  pdfSearchInputEl?.addEventListener("input", () => {
    const query = pdfSearchInputEl.value;
    pdfSearchState.query = query;
    if (pdfSearchState.searchTimer !== null) {
      window.clearTimeout(pdfSearchState.searchTimer);
    }
    pdfSearchState.searchTimer = window.setTimeout(() => {
      void executePdfSearch(query);
    }, 200);
  });

  pdfSearchInputEl?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      if (event.shiftKey) {
        navigatePdfSearchBackward();
      } else {
        navigatePdfSearchForward();
      }
    }
  });

  pdfSearchPrevEl?.addEventListener("click", () => navigatePdfSearchBackward());
  pdfSearchNextEl?.addEventListener("click", () => navigatePdfSearchForward());
  pdfSearchCloseEl?.addEventListener("click", () => closePdfSearch());

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

    if (event.key === "Escape" && pdfSearchState.isOpen) {
      closePdfSearch();
      return;
    }

    if (
      isPdfSearchShortcut(event) &&
      lastSnapshot?.pdfRenderer === "pdfjs" &&
      viewerState.currentBook
    ) {
      event.preventDefault();
      openPdfSearch();
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
      return;
    }

    if (handlePdfPagedKey(event)) {
      return;
    }

    if (viewerState.currentBook?.sourceType === "epub" && activeEpubRendition) {
      // DPFJ guide §ページ進行方向の遵守: in rtl books ArrowLeft advances reading order.
      const wantsNext = activeEpubIsRtl ? isEpubPrevPageKey(event) : isEpubNextPageKey(event);
      const wantsPrev = activeEpubIsRtl ? isEpubNextPageKey(event) : isEpubPrevPageKey(event);
      if (wantsNext) {
        event.preventDefault();
        void activeEpubRendition.next();
      } else if (wantsPrev) {
        event.preventDefault();
        void activeEpubRendition.prev();
      }
    }
  });

  // When the EPUB viewer is active, prevent keyboard focus from being
  // captured by the epub.js iframe.  If the window loses focus to one of
  // those iframes, return focus to the window so that the global keydown
  // handler above keeps working.
  // Deferred with setTimeout(0) so the focus steal happens after any click
  // sequence (mousedown → mouseup → click) completes — otherwise stealing
  // focus during mousedown would suppress the click event in the iframe.
  window.addEventListener("blur", () => {
    if (!activeEpubRendition) return;
    const epubViewerEl = document.querySelector("#epub-viewer");
    const active = document.activeElement;
    if (active instanceof HTMLIFrameElement && epubViewerEl?.contains(active)) {
      setTimeout(() => {
        if (activeEpubRendition) window.focus();
      }, 0);
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

    resizeEpubRendition();
  });

  // When the sidebar opens or closes the CSS grid transition changes the
  // right-pane width.  Call resize() once the transition finishes so
  // epub.js recalculates its column layout for the new dimensions.
  document.querySelector(".two-pane")?.addEventListener("transitionend", (e) => {
    if ((e as TransitionEvent).propertyName === "grid-template-columns") {
      resizeEpubRendition();
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

  try {
    await loadAppConfig();
  } catch (error) {
    applyAppTheme("default");
    console.error("failed to load app config", error);
  } finally {
    finishStartupPhase();
  }

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
    cachedAppName = await getName();
    cachedAppVersion = await getVersion();
  } catch (error) {
    console.error("failed to load app metadata", error);
  }
  syncAboutUi();
});
