// Library-shell state shared across feature modules. State that a single
// feature owns lives in that feature's module instead.

import { DEFAULT_VIEWER_SETTINGS } from "../viewer-settings-utils";
import type {
  AppConfigPayload,
  ImageEpubSession,
  LibrarySnapshot,
  PdfOutlineNode,
  PdfRenderSession,
  ReadingPosition,
  ViewerSettingsState,
  ViewerState,
} from "./types";

export const viewerState: ViewerState = {
  books: [],
  currentBook: null,
  activeDirectory: null,
  activeTag: null,
  activeExternalSource: null,
  activeShelf: null,
  activeTagDirectOnly: false,
  searchQuery: "",
  expandedDirectories: new Set<string>(),
  expandedTags: new Set<string>(),
  sidebarCollapsed: false,
  isAppSettingsOpen: false,
  isAboutOpen: false,
  isLibraryWelcomeRequested: false,
  libraryErrorMessage: null,
  shelves: [],
};

export const viewerSettings: ViewerSettingsState = {
  ...DEFAULT_VIEWER_SETTINGS,
  globalDraft: { ...DEFAULT_VIEWER_SETTINGS },
  fileDraft: { ...DEFAULT_VIEWER_SETTINGS },
  scope: "file",
  hasFileOverride: false,
  treatFirstPageAsCover: true,
  isSettingsOpen: false,
  sourceType: "pdf",
};

// Mutable state that more than one feature reassigns. State only one feature
// writes stays with that feature; these are the values shared across them.
type AppState = {
  lastSnapshot: LibrarySnapshot | null;
  lastAppConfig: AppConfigPayload | null;
  activeReadingPosition: ReadingPosition | null;
  // One-shot jump target consumed by openBook when a full-text hit opens a book
  // at a specific location instead of its saved reading position.
  pendingViewerJump: { filePath: string; page?: number; cfi?: string } | null;
  activePdfOutline: PdfOutlineNode[] | null;
  tocPanelOpen: boolean;
  activeEpubTotalPages: number | null;
  // True when the active EPUB's spine page-progression-direction is "rtl".
  // DPFJ guide §ページ進行方向の遵守: page direction is governed by OPF spine, not writing-mode.
  // In rtl books, ArrowLeft advances the reading order (next page) while ArrowRight goes back.
  activeEpubIsRtl: boolean;
  // The open document of each viewer engine. The engine module that renders it
  // is the only writer; the reading-position, TOC, search and navigation
  // modules below it read the handle here.
  activePdfRenderSession: PdfRenderSession | null;
  pdfRenderInProgress: boolean;
  activeEpubBook: import("epubjs").Book | null;
  activeEpubRendition: import("epubjs").Rendition | null;
  activeImageEpub: ImageEpubSession | null;
};

export const appState: AppState = {
  lastSnapshot: null,
  lastAppConfig: null,
  activeReadingPosition: null,
  pendingViewerJump: null,
  activePdfOutline: null,
  tocPanelOpen: false,
  activeEpubTotalPages: null,
  activeEpubIsRtl: false,
  activePdfRenderSession: null,
  pdfRenderInProgress: false,
  activeEpubBook: null,
  activeEpubRendition: null,
  activeImageEpub: null,
};
