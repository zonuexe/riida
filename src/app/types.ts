// Payload and state shapes shared by the library-shell feature modules.

import type { AppTheme } from "../app-config-utils";
import type {
  ViewerSettings,
  ViewerSettingsScope,
  ViewerSourceType,
} from "../viewer-settings-utils";

export type CustomSource = {
  id: string;
  name: string;
  icon: string;
};

export type BookSummary = {
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
  releaseDate: string | null;
  language: string | null;
  lastReadAt: number | null;
  indexedAt: number;
};

export type LibrarySnapshot = {
  libraryRoots: string[];
  existingLibraryRoots: string[];
  missingLibraryRoots: string[];
  indexedCount: number;
  books: BookSummary[];
  excludedPatterns: string[];
  pdfRenderer: "native" | "pdfjs";
  customSources: CustomSource[];
};

export type NoteDocument = {
  filePath: string;
  format: string;
  content: string;
  updatedAt: number | null;
};

export type BookMetadataPayload = {
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

export type ReadingPosition = {
  filePath: string;
  pageNumber: number;
  pageOffsetRatio: number;
  cfi?: string | null;
  updatedAt: number | null;
};

export type Shelf = {
  id: string;
  name: string;
  query: string;
  icon: string | null;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
};

export type ViewerState = {
  books: BookSummary[];
  currentBook: BookSummary | null;
  activeDirectory: string | null;
  activeTag: string | null;
  activeExternalSource: string | null;
  activeShelf: string | null;
  activeTagDirectOnly: boolean;
  searchQuery: string;
  expandedDirectories: Set<string>;
  expandedTags: Set<string>;
  sidebarCollapsed: boolean;
  isAppSettingsOpen: boolean;
  isAboutOpen: boolean;
  /** The welcome screen was opened from Settings while a library exists. */
  isLibraryWelcomeRequested: boolean;
  libraryErrorMessage: string | null;
  shelves: Shelf[];
};

export type AppConfigPayload = {
  configPath: string;
  configExists: boolean;
  libraryRoots: string[];
  excludedPatterns: string[];
  pdfRenderer: "native" | "pdfjs";
  theme: AppTheme;
  enabledExternalSources: string[];
};

export type ViewerSettingsState = ViewerSettings & {
  globalDraft: ViewerSettings;
  fileDraft: ViewerSettings;
  scope: ViewerSettingsScope;
  hasFileOverride: boolean;
  isSettingsOpen: boolean;
  sourceType: ViewerSourceType;
};

export type NavigationState = {
  historyIndex: number;
  bookFilePath: string | null;
  epubCfi?: string | null;
  pdfPage?: number | null;
  activeDirectory: string | null;
  activeTag: string | null;
  activeExternalSource: string | null;
  activeShelf: string | null;
  activeTagDirectOnly: boolean;
  searchQuery: string;
};

export type PdfOutlineNode = {
  title: string;
  dest: string | unknown[] | null;
  items: PdfOutlineNode[];
};
