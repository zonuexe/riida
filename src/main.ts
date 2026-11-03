import "./vendor/fontawesome/css/fontawesome.min.css";
import "./vendor/fontawesome/css/brands.min.css";
import "./vendor/fontawesome/css/regular.min.css";
import "./vendor/fontawesome/css/solid.min.css";
import { invoke } from "@tauri-apps/api/core";
import { getName, getVersion } from "@tauri-apps/api/app";
import { type DragDropEvent, getCurrentWebview } from "@tauri-apps/api/webview";
import { confirm, message, open } from "@tauri-apps/plugin-dialog";
import {
  addLibraryRoot,
  type AppTheme,
  buildAppConfigDraft,
  normalizeAppTheme,
} from "./app-config-utils";
import { applyAppTheme, persistAppTheme } from "./app-theme";
import { describeAddLibraryRootError } from "./i18n";
import {
  applyBookMetadataImport,
  BOOK_METADATA_DRAFT_KEYS,
  BOOK_METADATA_IMPORT_EXAMPLE,
  type BookMetadataDraft,
  isBookMetadataDraftEmpty,
  joinMetadataAuthors,
  mergeBookMetadataFormValues,
  normalizeMetadataAuthorsText,
  normalizeReleaseDateInput,
  parseBookMetadataImport,
  validateBookMetadataDraft,
} from "./book-metadata-utils";
import { type StatusTone, statusToneAttribute } from "./dom-form-utils";
import {
  deriveLanguages,
  derivePublishers,
  deriveSources,
  deriveTags,
  filterVisibleBooks,
  folderDisplayName,
} from "./library-utils";
import { suggestTagCompletions } from "./tag-suggestions";
import {
  composeShelfQuery,
  decomposeShelfQuery,
  type ShelfCondition,
  type ShelfFieldKey,
  type ShelfMode,
} from "./shelf-query.ts";
import { countBooksWithTagOrDescendants, validateTagValue } from "./tag-utils";
import { registerThumbnailEvents } from "./app/book-list";
import { applyStatusMessage, finishStartupPhase, syncControlValue } from "./app/dom";
import { initEpubFocusGuard } from "./app/epub-viewer";
import {
  initFulltextSettings,
  refreshFulltextStatus,
  registerFulltextEvents,
} from "./app/fulltext";
import { collapseHomePath, primeHomeDirCache } from "./app/home-path";
import { initGlobalShortcuts } from "./app/keyboard";
import { initLibrarySearch } from "./app/library-search";
import { initBulkSelection, initLibraryViewControls } from "./app/library-view";
import {
  hasActiveLibraryFilter,
  refreshShelves,
  refreshSnapshot,
  registerLibraryEvents,
  renderApp,
  updateBookTagsInState,
} from "./app/library";
import { applyStaticTranslations, t, uiLocale } from "./app/locale";
import {
  initHistoryPopstate,
  initNavigationControls,
  loadInitialLibraryState,
  navigateToState,
} from "./app/navigation";
import { initNotes } from "./app/notes";
import { initPdfSearch } from "./app/pdf-search";
import { initPdfStageScroll } from "./app/pdf-viewer";
import { initFlushOnUnload } from "./app/reading-position";
import { initShellControls, initSidebarControls } from "./app/sidebar";
import { appState, viewerState } from "./app/state";
import { initTocToggle } from "./app/toc";
import type {
  AppConfigPayload,
  BookMetadataPayload,
  BookSummary,
  CustomSource,
  LibrarySnapshot,
  Shelf,
} from "./app/types";
import { initViewerSettingsPanel } from "./app/viewer-settings";
import { initViewerEditorButtons, initViewerPageJump, initViewerResize } from "./app/viewer";

type BookTagsPayload = {
  filePath: string;
  tags: string[];
};

type TagEditorState = {
  isOpen: boolean;
  filePath: string | null;
  books: BookSummary[] | null;
  bookTitle: string;
  tags: string[];
  input: string;
  statusMessage: string;
};

type TagManagerState = {
  isOpen: boolean;
  tagId: string;
  affectedBooks: number;
  affectedTags: string[];
  renameInput: string;
  statusMessage: string;
  statusTone: "info" | "error";
};

type MetadataFieldPolicy = "fill-empty" | "overwrite-all";

type BookMetadataEditorState = {
  isOpen: boolean;
  filePath: string | null;
  books: BookSummary[] | null;
  existingMetadataMap: Map<string, BookMetadataPayload>;
  fieldPolicies: Partial<Record<string, MetadataFieldPolicy>>;
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

let cachedAppName = "riida";
let cachedAppVersion = "0.9.3";
const buildDate = __BUILD_DATE__;
let cachedLicenseText = "Loading license text...";
let cachedThirdPartyRustText = "Loading Rust notices...";
let cachedThirdPartyJsText = "Loading JavaScript notices...";
export function currentAppTheme(): AppTheme {
  return normalizeAppTheme(appState.lastAppConfig?.theme ?? "default");
}

let isTagEditorComposing = false;

export const tagEditorState: TagEditorState = {
  isOpen: false,
  filePath: null,
  books: null,
  bookTitle: "",
  tags: [],
  input: "",
  statusMessage: "",
};
const tagManagerState: TagManagerState = {
  isOpen: false,
  tagId: "",
  affectedBooks: 0,
  affectedTags: [],
  renameInput: "",
  statusMessage: "",
  statusTone: "info",
};
let isTagManagerComposing = false;
const bookMetadataEditorState: BookMetadataEditorState = {
  isOpen: false,
  filePath: null,
  books: null,
  existingMetadataMap: new Map(),
  fieldPolicies: {},
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

type ShelfEditorState = {
  isOpen: boolean;
  id: string | null;
  name: string;
  query: string;
  icon: string;
  mode: ShelfMode;
  rows: ShelfCondition[];
  statusMessage: string;
  statusTone: "info" | "error" | "success";
};

const SHELF_DEFAULT_ICON = "fa-solid fa-bookmark";

const SHELF_ICONS: ReadonlyArray<{ cls: string; label: string }> = [
  { cls: "fa-solid fa-bookmark", label: "Bookmark" },
  { cls: "fa-regular fa-bookmark", label: "Bookmark (regular)" },
  { cls: "fa-solid fa-star", label: "Star" },
  { cls: "fa-solid fa-heart", label: "Heart" },
  { cls: "fa-solid fa-fire", label: "Fire" },
  { cls: "fa-solid fa-flag", label: "Flag" },
  { cls: "fa-solid fa-tag", label: "Tag" },
  { cls: "fa-solid fa-folder", label: "Folder" },
  { cls: "fa-solid fa-list", label: "List" },
  { cls: "fa-solid fa-magnifying-glass", label: "Search" },
  { cls: "fa-solid fa-eye", label: "Eye" },
  { cls: "fa-solid fa-clock", label: "Clock" },
  { cls: "fa-solid fa-graduation-cap", label: "Graduation cap" },
  { cls: "fa-solid fa-microscope", label: "Microscope" },
  { cls: "fa-solid fa-flask", label: "Flask" },
  { cls: "fa-solid fa-feather", label: "Feather" },
  { cls: "fa-solid fa-leaf", label: "Leaf" },
  { cls: "fa-solid fa-mug-hot", label: "Mug" },
  { cls: "fa-solid fa-square-root-variable", label: "Square root" },
  { cls: "fa-solid fa-superscript", label: "Superscript" },
  { cls: "fa-solid fa-robot", label: "Robot" },
  { cls: "fa-solid fa-chess-knight", label: "Chess knight" },
  { cls: "fa-regular fa-chess-knight", label: "Chess knight (regular)" },
  { cls: "fa-regular fa-compass", label: "Compass" },
  { cls: "fa-solid fa-person-running", label: "Running" },
  { cls: "fa-solid fa-code", label: "Code" },
  { cls: "fa-solid fa-terminal", label: "Terminal" },
  { cls: "fa-brands fa-square-github", label: "GitHub" },
];

const shelfEditorState: ShelfEditorState = {
  isOpen: false,
  id: null,
  name: "",
  query: "",
  icon: SHELF_DEFAULT_ICON,
  mode: "all",
  rows: [],
  statusMessage: "",
  statusTone: "info",
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

function renderLibraryRootsList() {
  const listEl = document.querySelector<HTMLElement>("#config-library-roots-list");
  if (!listEl) {
    return;
  }

  listEl.innerHTML = "";
  const roots = appState.lastAppConfig?.libraryRoots ?? [];

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
      if (!appState.lastAppConfig) {
        return;
      }

      if (appState.lastAppConfig.libraryRoots.length <= 1) {
        setAppSettingsStatus("At least one library root is required.", "error");
        return;
      }

      appState.lastAppConfig = {
        ...appState.lastAppConfig,
        libraryRoots: appState.lastAppConfig.libraryRoots.filter(
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

function setAppSettingsStatus(message: string, tone: StatusTone = "neutral") {
  const statusEl = document.querySelector<HTMLElement>("#app-settings-status");
  if (!statusEl) {
    return;
  }

  applyStatusMessage(statusEl, message, tone);
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

  if (appState.lastAppConfig) {
    if (excludedPatternsEl) {
      excludedPatternsEl.value = appState.lastAppConfig.excludedPatterns.join("\n");
    }
    if (pdfRendererEl) {
      pdfRendererEl.value = appState.lastAppConfig.pdfRenderer;
    }
    if (themeEl) {
      themeEl.value = appState.lastAppConfig.theme;
    }
    if (configPathEl) {
      configPathEl.innerHTML = `Config file: <code>${appState.lastAppConfig.configPath}</code>`;
    }
    if (kindleEnabledEl) {
      kindleEnabledEl.checked = appState.lastAppConfig.enabledExternalSources.includes("kindle");
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
  const sources = appState.lastSnapshot?.customSources ?? [];
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
  const titleEl = document.querySelector<HTMLElement>("#custom-source-editor-heading");
  const nameEl = document.querySelector<HTMLInputElement>("#custom-source-name");
  const statusEl = document.querySelector<HTMLElement>("#custom-source-status");
  const deleteEl = document.querySelector<HTMLButtonElement>("#custom-source-delete");
  if (modalEl) {
    modalEl.hidden = !customSourceEditorState.isOpen;
  }
  if (titleEl) {
    titleEl.textContent = customSourceEditorState.id ? "Edit source" : "New source";
  }
  if (deleteEl) {
    deleteEl.hidden = !customSourceEditorState.id;
  }
  syncControlValue(nameEl, customSourceEditorState.name);
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

export function openCustomSourceEditor(source?: CustomSource) {
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
    const snapshot = await invoke<LibrarySnapshot>("load_library_snapshot");
    appState.lastSnapshot = snapshot;
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
    const snapshot = await invoke<LibrarySnapshot>("load_library_snapshot");
    appState.lastSnapshot = snapshot;
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

async function deleteCustomSourceFromEditor() {
  const id = customSourceEditorState.id;
  if (!id) return;
  const source: CustomSource = {
    id,
    name: customSourceEditorState.name,
    icon: customSourceEditorState.icon,
  };
  await deleteCustomSource(source);
  if (!viewerState.activeExternalSource || viewerState.activeExternalSource !== id) {
    closeCustomSourceEditor();
  } else {
    closeCustomSourceEditor();
  }
}

const SHELF_FIELD_OPTIONS: ReadonlyArray<{ value: ShelfFieldKey; label: string }> = [
  { value: "free", label: "Any field" },
  { value: "title", label: "Title" },
  { value: "author", label: "Author" },
  { value: "publisher", label: "Publisher" },
  { value: "tag", label: "Tag" },
  { value: "lang", label: "Language" },
  { value: "file", label: "File name" },
  { value: "path", label: "File path" },
  { value: "source", label: "Source" },
];

function effectiveShelfQuery(): string {
  if (shelfEditorState.mode === "custom") {
    return shelfEditorState.query.trim();
  }
  return composeShelfQuery(shelfEditorState.mode, shelfEditorState.rows);
}

function renderShelfConditionRows() {
  const container = document.querySelector<HTMLElement>("#shelf-editor-conditions");
  if (!container) return;
  container.innerHTML = "";
  shelfEditorState.rows.forEach((row, index) => {
    const rowEl = document.createElement("div");
    rowEl.className = "shelf-editor-condition-row";

    const fieldEl = document.createElement("select");
    fieldEl.className = "shelf-editor-condition-field";
    for (const opt of SHELF_FIELD_OPTIONS) {
      const optionEl = document.createElement("option");
      optionEl.value = opt.value;
      optionEl.textContent = opt.label;
      if (opt.value === row.field) optionEl.selected = true;
      fieldEl.appendChild(optionEl);
    }
    fieldEl.addEventListener("change", () => {
      shelfEditorState.rows[index] = { ...row, field: fieldEl.value as ShelfFieldKey };
      syncShelfEditorUi();
    });

    const opEl = document.createElement("select");
    opEl.className = "shelf-editor-condition-op";
    const includesOpt = document.createElement("option");
    includesOpt.value = "includes";
    includesOpt.textContent = "contains";
    const excludesOpt = document.createElement("option");
    excludesOpt.value = "excludes";
    excludesOpt.textContent = "does not contain";
    opEl.appendChild(includesOpt);
    opEl.appendChild(excludesOpt);
    opEl.value = row.negate ? "excludes" : "includes";
    opEl.addEventListener("change", () => {
      shelfEditorState.rows[index] = { ...row, negate: opEl.value === "excludes" };
      syncShelfEditorUi();
    });

    const valueWrap = document.createElement("div");
    valueWrap.className = "shelf-editor-condition-value-wrap";

    const valueEl = document.createElement("input");
    valueEl.type = "text";
    valueEl.className = "shelf-editor-condition-value";
    valueEl.value = row.value;
    valueEl.placeholder = "value";
    valueEl.autocomplete = "off";

    const suggestionsEl = document.createElement("div");
    suggestionsEl.className = "shelf-editor-condition-suggestions";
    suggestionsEl.hidden = true;

    const updateSuggestions = () => {
      const candidates = getShelfFieldSuggestionCandidates(row.field);
      if (candidates.length === 0) {
        suggestionsEl.hidden = true;
        suggestionsEl.innerHTML = "";
        return;
      }
      const trimmed = valueEl.value.trim();
      const matches =
        trimmed.length === 0
          ? candidates.slice(0, 8)
          : suggestTagCompletions(candidates, valueEl.value, [], 8);
      suggestionsEl.innerHTML = "";
      if (matches.length === 0) {
        suggestionsEl.hidden = true;
        return;
      }
      for (const match of matches) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "shelf-editor-condition-suggestion";
        btn.textContent = match;
        btn.addEventListener("mousedown", (event) => {
          // Prevent input blur before click handler runs.
          event.preventDefault();
        });
        btn.addEventListener("click", () => {
          shelfEditorState.rows[index] = { ...row, value: match };
          valueEl.value = match;
          suggestionsEl.hidden = true;
          updateShelfPreview();
          valueEl.focus();
        });
        suggestionsEl.appendChild(btn);
      }
      suggestionsEl.hidden = false;
    };

    valueEl.addEventListener("input", () => {
      shelfEditorState.rows[index] = { ...row, value: valueEl.value };
      updateSuggestions();
      // Skip full re-render to keep input focus; just refresh preview.
      updateShelfPreview();
    });
    valueEl.addEventListener("focus", updateSuggestions);
    valueEl.addEventListener("blur", () => {
      // Delay so suggestion clicks can fire first.
      setTimeout(() => {
        suggestionsEl.hidden = true;
      }, 120);
    });

    valueWrap.appendChild(valueEl);
    valueWrap.appendChild(suggestionsEl);

    const removeEl = document.createElement("button");
    removeEl.type = "button";
    removeEl.className = "shelf-editor-condition-remove";
    removeEl.setAttribute("aria-label", "Remove condition");
    removeEl.title = "Remove condition";
    removeEl.innerHTML = '<i class="fa-solid fa-xmark" aria-hidden="true"></i>';
    removeEl.addEventListener("click", () => {
      shelfEditorState.rows.splice(index, 1);
      syncShelfEditorUi();
    });

    rowEl.appendChild(fieldEl);
    rowEl.appendChild(opEl);
    rowEl.appendChild(valueWrap);
    rowEl.appendChild(removeEl);
    container.appendChild(rowEl);
  });
}

function getShelfFieldSuggestionCandidates(field: ShelfFieldKey): string[] {
  if (!appState.lastSnapshot) return [];
  if (field === "tag") {
    return deriveTags(appState.lastSnapshot.books)
      .filter((tag) => tag.explicit)
      .map((tag) => tag.id);
  }
  if (field === "publisher") {
    return derivePublishers(appState.lastSnapshot.books);
  }
  if (field === "lang") {
    return deriveLanguages(appState.lastSnapshot.books);
  }
  if (field === "source") {
    return deriveSources(appState.lastSnapshot.books);
  }
  return [];
}

function updateShelfPreview() {
  const previewEl = document.querySelector<HTMLElement>("#shelf-editor-preview");
  if (!previewEl) return;
  if (!shelfEditorState.isOpen || !appState.lastSnapshot) {
    previewEl.hidden = true;
    return;
  }
  const query = effectiveShelfQuery();
  if (query.length === 0) {
    previewEl.hidden = true;
    return;
  }
  const matched = filterVisibleBooks(appState.lastSnapshot.books, null, null, null, false, query);
  previewEl.hidden = false;
  previewEl.dataset.tone = "info";
  previewEl.textContent = `Preview: ${matched.length} book${matched.length === 1 ? "" : "s"} match`;
}

function syncShelfEditorUi() {
  const modalEl = document.querySelector<HTMLElement>("#shelf-editor-modal");
  const titleEl = document.querySelector<HTMLElement>("#shelf-editor-title");
  const nameEl = document.querySelector<HTMLInputElement>("#shelf-editor-name");
  const queryEl = document.querySelector<HTMLTextAreaElement>("#shelf-editor-query");
  const queryFieldEl = document.querySelector<HTMLElement>("#shelf-editor-query-field");
  const conditionsFieldEl = document.querySelector<HTMLElement>("#shelf-editor-conditions-field");
  const statusEl = document.querySelector<HTMLElement>("#shelf-editor-status");
  const deleteEl = document.querySelector<HTMLButtonElement>("#shelf-editor-delete");
  const modeEl = document.querySelector<HTMLElement>("#shelf-editor-mode");
  if (modalEl) modalEl.hidden = !shelfEditorState.isOpen;
  if (titleEl) titleEl.textContent = shelfEditorState.id ? "Edit shelf" : "New shelf";
  syncControlValue(nameEl, shelfEditorState.name);
  if (deleteEl) deleteEl.hidden = !shelfEditorState.id;
  if (modeEl) {
    for (const btn of modeEl.querySelectorAll<HTMLButtonElement>(".shelf-editor-mode-btn")) {
      const active = btn.dataset.mode === shelfEditorState.mode;
      btn.setAttribute("aria-selected", active ? "true" : "false");
      btn.classList.toggle("is-selected", active);
    }
  }
  const iconPickerEl = document.querySelector<HTMLElement>("#shelf-editor-icon-picker");
  if (iconPickerEl) {
    for (const btn of iconPickerEl.querySelectorAll<HTMLButtonElement>("[data-icon]")) {
      btn.classList.toggle("is-selected", btn.dataset.icon === shelfEditorState.icon);
    }
  }
  const isCustom = shelfEditorState.mode === "custom";
  if (queryFieldEl) queryFieldEl.hidden = !isCustom;
  if (conditionsFieldEl) conditionsFieldEl.hidden = isCustom;
  syncControlValue(queryEl, shelfEditorState.query);
  if (!isCustom) renderShelfConditionRows();
  if (statusEl) {
    statusEl.hidden = shelfEditorState.statusMessage.length === 0;
    statusEl.textContent = shelfEditorState.statusMessage;
    statusEl.dataset.tone = shelfEditorState.statusTone;
  }
  updateShelfPreview();
}

function setShelfEditorMode(nextMode: ShelfMode) {
  if (nextMode === shelfEditorState.mode) return;
  if (nextMode === "custom") {
    shelfEditorState.query = composeShelfQuery(shelfEditorState.mode, shelfEditorState.rows);
    shelfEditorState.mode = "custom";
    shelfEditorState.statusMessage = "";
  } else {
    if (shelfEditorState.mode === "custom") {
      const decomposed = decomposeShelfQuery(shelfEditorState.query);
      if (decomposed) {
        shelfEditorState.rows = decomposed.rows;
        shelfEditorState.mode = nextMode;
        shelfEditorState.statusMessage = "";
      } else {
        shelfEditorState.statusMessage =
          "This query is too complex to edit as conditions. Stay in Custom mode or simplify the query first.";
        shelfEditorState.statusTone = "error";
        syncShelfEditorUi();
        return;
      }
    } else {
      shelfEditorState.mode = nextMode;
    }
  }
  syncShelfEditorUi();
}

export function openShelfEditor(shelf?: Shelf, presetQuery?: string) {
  shelfEditorState.isOpen = true;
  shelfEditorState.id = shelf?.id ?? null;
  shelfEditorState.name = shelf?.name ?? "";
  const initialQuery = shelf?.query ?? presetQuery ?? "";
  shelfEditorState.query = initialQuery;
  shelfEditorState.icon = shelf?.icon ?? SHELF_DEFAULT_ICON;
  shelfEditorState.statusMessage = "";
  shelfEditorState.statusTone = "info";

  const decomposed = decomposeShelfQuery(initialQuery);
  if (decomposed) {
    shelfEditorState.mode = decomposed.rows.length === 0 ? "all" : decomposed.mode;
    shelfEditorState.rows = decomposed.rows;
  } else {
    shelfEditorState.mode = "custom";
    shelfEditorState.rows = [];
  }

  syncShelfEditorUi();
  setTimeout(() => {
    const nameEl = document.querySelector<HTMLInputElement>("#shelf-editor-name");
    nameEl?.focus();
    nameEl?.select();
  }, 0);
}

function closeShelfEditor() {
  shelfEditorState.isOpen = false;
  syncShelfEditorUi();
}

async function saveShelfFromEditor() {
  const nameEl = document.querySelector<HTMLInputElement>("#shelf-editor-name");
  const queryEl = document.querySelector<HTMLTextAreaElement>("#shelf-editor-query");
  const name = (nameEl?.value ?? shelfEditorState.name).trim();
  if (shelfEditorState.mode === "custom" && queryEl) {
    shelfEditorState.query = queryEl.value;
  }
  const query = effectiveShelfQuery();
  if (!name) {
    shelfEditorState.statusMessage = "Name is required.";
    shelfEditorState.statusTone = "error";
    syncShelfEditorUi();
    return;
  }
  if (!query) {
    shelfEditorState.statusMessage = "Query is required.";
    shelfEditorState.statusTone = "error";
    syncShelfEditorUi();
    return;
  }
  try {
    const saved = await invoke<Shelf>("save_shelf", {
      draft: { id: shelfEditorState.id, name, query, icon: shelfEditorState.icon },
    });
    await refreshShelves();
    closeShelfEditor();
    void navigateToState(
      {
        bookFilePath: null,
        activeDirectory: null,
        activeTag: null,
        activeExternalSource: null,
        activeShelf: saved.id,
        activeTagDirectOnly: false,
        searchQuery: "",
      },
      "push",
    );
  } catch (error) {
    shelfEditorState.statusMessage = `Failed to save: ${String(error)}`;
    shelfEditorState.statusTone = "error";
    syncShelfEditorUi();
  }
}

async function deleteShelfFromEditor() {
  if (!shelfEditorState.id) return;
  const confirmed = await confirm(`Delete shelf "${shelfEditorState.name}"?`, {
    title: "Delete shelf",
    kind: "warning",
    okLabel: "Delete",
    cancelLabel: "Cancel",
  });
  if (!confirmed) return;
  const id = shelfEditorState.id;
  try {
    await invoke("delete_shelf", { id });
    await refreshShelves();
    if (viewerState.activeShelf === id) {
      void navigateToState(
        {
          bookFilePath: null,
          activeDirectory: null,
          activeTag: null,
          activeExternalSource: null,
          activeShelf: null,
          activeTagDirectOnly: false,
          searchQuery: "",
        },
        "push",
      );
    } else {
      renderApp();
    }
    closeShelfEditor();
  } catch (error) {
    shelfEditorState.statusMessage = `Failed to delete: ${String(error)}`;
    shelfEditorState.statusTone = "error";
    syncShelfEditorUi();
  }
}

function setTagEditorStatus(message: string, tone: StatusTone = "neutral") {
  const statusEl = document.querySelector<HTMLElement>("#tag-editor-status");
  if (!statusEl) {
    return;
  }

  tagEditorState.statusMessage = message;
  applyStatusMessage(statusEl, message, tone);
}

function setBookMetadataStatus(message: string, tone: StatusTone = "neutral") {
  const statusEl = document.querySelector<HTMLElement>("#book-metadata-status");
  if (!statusEl) {
    return;
  }

  bookMetadataEditorState.statusMessage = message;
  applyStatusMessage(statusEl, message, tone);
}

export function syncTagEditorUi() {
  const modalEl = document.querySelector<HTMLElement>("#tag-editor-modal");
  const bookEl = document.querySelector<HTMLElement>("#tag-editor-book");
  const multiInfoEl = document.querySelector<HTMLElement>("#tag-editor-multi-info");
  const listEl = document.querySelector<HTMLElement>("#tag-editor-list");
  const inputEl = document.querySelector<HTMLInputElement>("#tag-editor-input");
  const suggestionsEl = document.querySelector<HTMLElement>("#tag-editor-suggestions");

  if (modalEl) {
    modalEl.hidden = !tagEditorState.isOpen;
  }

  const isMulti = tagEditorState.books !== null;
  if (bookEl) {
    bookEl.hidden = isMulti;
  }
  if (multiInfoEl) {
    multiInfoEl.hidden = !isMulti;
    if (isMulti) {
      const n = tagEditorState.books!.length;
      multiInfoEl.textContent = `The tags below will be added to all ${n} selected books.`;
    }
  }

  if (inputEl) {
    inputEl.value = tagEditorState.input;
  }

  if (suggestionsEl) {
    suggestionsEl.innerHTML = "";
    const explicitTags = deriveTags(appState.lastSnapshot?.books ?? viewerState.books)
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

export function openTagManager(tagId: string) {
  const books = appState.lastSnapshot?.books ?? viewerState.books;
  const stats = countBooksWithTagOrDescendants(books, tagId);
  tagManagerState.isOpen = true;
  tagManagerState.tagId = tagId;
  tagManagerState.affectedBooks = stats.bookCount;
  tagManagerState.affectedTags = stats.affectedTags;
  tagManagerState.renameInput = tagId;
  tagManagerState.statusMessage = "";
  tagManagerState.statusTone = "info";
  syncTagManagerUi();
  setTimeout(() => {
    const inputEl = document.querySelector<HTMLInputElement>("#tag-manager-rename-input");
    inputEl?.focus();
    inputEl?.select();
  }, 0);
}

function closeTagManager() {
  tagManagerState.isOpen = false;
  syncTagManagerUi();
}

function setTagManagerStatus(message: string, tone: "info" | "error" = "info") {
  tagManagerState.statusMessage = message;
  tagManagerState.statusTone = tone;
  syncTagManagerUi();
}

function syncTagManagerUi() {
  const modalEl = document.querySelector<HTMLElement>("#tag-manager-modal");
  const tagEl = document.querySelector<HTMLElement>("#tag-manager-tag");
  const infoEl = document.querySelector<HTMLElement>("#tag-manager-info");
  const inputEl = document.querySelector<HTMLInputElement>("#tag-manager-rename-input");
  const statusEl = document.querySelector<HTMLElement>("#tag-manager-status");
  const renameBtn = document.querySelector<HTMLButtonElement>("#tag-manager-rename");
  const deleteBtn = document.querySelector<HTMLButtonElement>("#tag-manager-delete");

  if (modalEl) {
    modalEl.hidden = !tagManagerState.isOpen;
  }
  if (tagEl) {
    tagEl.textContent = tagManagerState.tagId;
  }
  if (infoEl) {
    const bookCount = tagManagerState.affectedBooks;
    const tagCount = tagManagerState.affectedTags.length;
    if (bookCount === 0) {
      infoEl.textContent = "No books currently use this tag.";
    } else {
      const booksPart = `${bookCount} book${bookCount === 1 ? "" : "s"}`;
      if (tagCount <= 1) {
        infoEl.textContent = `This affects ${booksPart}.`;
      } else {
        infoEl.textContent =
          `This affects ${booksPart} and ${tagCount} tags ` +
          `(including sub-tags: ${tagManagerState.affectedTags.slice(0, 5).join(", ")}` +
          `${tagCount > 5 ? ", …" : ""}).`;
      }
    }
  }
  syncControlValue(inputEl, tagManagerState.renameInput);
  if (statusEl) {
    const hasStatus = tagManagerState.statusMessage.length > 0;
    statusEl.hidden = !hasStatus;
    statusEl.textContent = tagManagerState.statusMessage;
    statusEl.dataset.tone = tagManagerState.statusTone;
  }
  const canAct = tagManagerState.affectedBooks > 0;
  if (renameBtn) {
    renameBtn.disabled = !canAct;
  }
  if (deleteBtn) {
    deleteBtn.disabled = !canAct;
  }
}

async function renameTagFromManager() {
  const oldTag = tagManagerState.tagId;
  const newTag = tagManagerState.renameInput.trim();
  const validation = validateTagValue(newTag);
  if (!validation.ok) {
    setTagManagerStatus(validation.message, "error");
    return;
  }
  if (validation.value === oldTag) {
    setTagManagerStatus("Enter a different name to rename the tag.", "error");
    return;
  }
  try {
    const affected = await invoke<number>("rename_tag_globally", {
      oldTag,
      newTag: validation.value,
    });
    await refreshSnapshot();
    remapActiveTagAfterRename(oldTag, validation.value);
    closeTagManager();
    renderApp();
    void message(
      `Renamed "${oldTag}" to "${validation.value}" on ${affected} book${
        affected === 1 ? "" : "s"
      }.`,
      { title: "Tag renamed" },
    );
  } catch (error) {
    setTagManagerStatus(`Failed to rename: ${String(error)}`, "error");
  }
}

async function deleteTagFromManager() {
  const target = tagManagerState.tagId;
  const bookCount = tagManagerState.affectedBooks;
  const tagCount = tagManagerState.affectedTags.length;
  const detail =
    tagCount > 1
      ? ` This will also remove ${tagCount - 1} sub-tag${tagCount - 1 === 1 ? "" : "s"}.`
      : "";
  const confirmed = await confirm(
    `Remove "${target}" from ${bookCount} book${bookCount === 1 ? "" : "s"}?${detail}`,
    {
      title: "Delete tag",
      kind: "warning",
      okLabel: "Delete",
      cancelLabel: "Cancel",
    },
  );
  if (!confirmed) {
    return;
  }
  try {
    const affected = await invoke<number>("delete_tag_globally", { tag: target });
    await refreshSnapshot();
    clearActiveTagAfterDelete(target);
    closeTagManager();
    renderApp();
    void message(`Removed "${target}" from ${affected} book${affected === 1 ? "" : "s"}.`, {
      title: "Tag deleted",
    });
  } catch (error) {
    setTagManagerStatus(`Failed to delete: ${String(error)}`, "error");
  }
}

function remapActiveTagAfterRename(oldTag: string, newTag: string) {
  const active = viewerState.activeTag;
  if (!active) return;
  if (active === oldTag) {
    viewerState.activeTag = newTag;
  } else if (active.startsWith(`${oldTag}/`)) {
    viewerState.activeTag = `${newTag}${active.slice(oldTag.length)}`;
  }
}

function clearActiveTagAfterDelete(tag: string) {
  const active = viewerState.activeTag;
  if (!active) return;
  if (active === tag || active.startsWith(`${tag}/`)) {
    viewerState.activeTag = null;
    viewerState.activeTagDirectOnly = false;
  }
}

export function syncBookMetadataEditorUi() {
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
  const isMulti = bookMetadataEditorState.books !== null;
  const modalEl2 = document.querySelector<HTMLElement>("#book-metadata-modal");
  if (modalEl2) {
    modalEl2.classList.toggle("is-multi", isMulti);
  }

  const multiInfoEl = document.querySelector<HTMLElement>("#book-metadata-multi-info");
  if (multiInfoEl) {
    multiInfoEl.hidden = !isMulti;
    if (isMulti) {
      const n = bookMetadataEditorState.books!.length;
      multiInfoEl.textContent = `Editing ${n} books. Only filled fields will be applied.`;
    }
  }

  if (!isMulti) {
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

  if (isMulti) {
    syncMultiMetadataFieldPolicies();
  } else {
    clearMultiMetadataFieldPolicies();
  }
}

type MetadataFieldDef = {
  inputId: string;
  fieldKey: string;
  existingValues: (m: BookMetadataPayload) => string;
};

const METADATA_FIELD_DEFS: MetadataFieldDef[] = [
  { inputId: "book-metadata-title", fieldKey: "title", existingValues: (m) => m.title },
  {
    inputId: "book-metadata-authors",
    fieldKey: "authorsText",
    existingValues: (m) => joinMetadataAuthors(m.authors),
  },
  {
    inputId: "book-metadata-description",
    fieldKey: "description",
    existingValues: (m) => m.description,
  },
  { inputId: "book-metadata-publisher", fieldKey: "publisher", existingValues: (m) => m.publisher },
  {
    inputId: "book-metadata-release-date",
    fieldKey: "releaseDate",
    existingValues: (m) => m.releaseDate,
  },
  { inputId: "book-metadata-language", fieldKey: "language", existingValues: (m) => m.language },
  { inputId: "book-metadata-url", fieldKey: "url", existingValues: (m) => m.url },
  { inputId: "book-metadata-asin", fieldKey: "asin", existingValues: (m) => m.asin },
  { inputId: "book-metadata-cover-url", fieldKey: "coverUrl", existingValues: (m) => m.coverUrl },
];

function syncMultiMetadataFieldPolicies() {
  const existingList = [...bookMetadataEditorState.existingMetadataMap.values()];

  for (const def of METADATA_FIELD_DEFS) {
    const inputEl = document.querySelector(`#${def.inputId}`);
    if (!inputEl) continue;
    const parentEl = inputEl.closest<HTMLElement>(".app-settings-field");
    if (!parentEl) continue;

    const hasConflict = existingList.some((m) => def.existingValues(m).trim() !== "");
    let policyRowEl = parentEl.querySelector<HTMLElement>(".field-policy-row");

    if (!hasConflict) {
      policyRowEl?.remove();
      continue;
    }

    const currentPolicy: MetadataFieldPolicy =
      (bookMetadataEditorState.fieldPolicies[def.fieldKey] as MetadataFieldPolicy | undefined) ??
      "fill-empty";

    if (!policyRowEl) {
      policyRowEl = document.createElement("div");
      policyRowEl.className = "field-policy-row";
      const fieldKey = def.fieldKey;
      policyRowEl.innerHTML = `
        <span class="field-policy-label">Some books already have a value:</span>
        <label class="field-policy-option">
          <input type="radio" name="policy-${fieldKey}" value="fill-empty">
          Fill empty only
        </label>
        <label class="field-policy-option">
          <input type="radio" name="policy-${fieldKey}" value="overwrite-all">
          Overwrite all
        </label>
      `;
      for (const radio of policyRowEl.querySelectorAll<HTMLInputElement>("input[type=radio]")) {
        radio.addEventListener("change", () => {
          if (radio.checked) {
            bookMetadataEditorState.fieldPolicies[fieldKey] = radio.value as MetadataFieldPolicy;
          }
        });
      }
      parentEl.appendChild(policyRowEl);
    }

    for (const radio of policyRowEl.querySelectorAll<HTMLInputElement>("input[type=radio]")) {
      radio.checked = radio.value === currentPolicy;
    }
  }
}

function clearMultiMetadataFieldPolicies() {
  for (const def of METADATA_FIELD_DEFS) {
    const inputEl = document.querySelector(`#${def.inputId}`);
    if (!inputEl) continue;
    const parentEl = inputEl.closest<HTMLElement>(".app-settings-field");
    parentEl?.querySelector(".field-policy-row")?.remove();
  }
}

function bookSourceDisplayName(sourceType: string): string {
  if (sourceType === "kindle") return "Kindle";
  const custom = appState.lastSnapshot?.customSources.find((s) => s.id === sourceType);
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

export function openTagEditorForBooks(books: BookSummary[]) {
  tagEditorState.isOpen = true;
  tagEditorState.filePath = null;
  tagEditorState.books = books;
  tagEditorState.bookTitle = `${books.length} books`;
  tagEditorState.tags = [];
  tagEditorState.input = "";
  setTagEditorStatus("");
  syncTagEditorUi();
}

export async function openBookMetadataEditorForBooks(books: BookSummary[]) {
  const loadToken = bookMetadataEditorState.loadToken + 1;
  bookMetadataEditorState.loadToken = loadToken;
  bookMetadataEditorState.isOpen = true;
  bookMetadataEditorState.filePath = null;
  bookMetadataEditorState.books = books;
  bookMetadataEditorState.existingMetadataMap = new Map();
  bookMetadataEditorState.fieldPolicies = {};
  bookMetadataEditorState.bookTitle = `${books.length} books`;
  bookMetadataEditorState.sourceType = "pdf";
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
  setBookMetadataStatus("Loading existing metadata...");
  syncBookMetadataEditorUi();

  try {
    const results = await Promise.all(
      books.map((b) => invoke<BookMetadataPayload>("load_book_metadata", { filePath: b.filePath })),
    );
    if (bookMetadataEditorState.loadToken !== loadToken) return;
    const map = new Map<string, BookMetadataPayload>();
    for (let i = 0; i < books.length; i++) {
      const result = results[i];
      const book = books[i];
      if (result && book) map.set(book.filePath, result);
    }
    bookMetadataEditorState.existingMetadataMap = map;
    setBookMetadataStatus("");
    syncBookMetadataEditorUi();
  } catch (error) {
    if (bookMetadataEditorState.loadToken !== loadToken) return;
    setBookMetadataStatus(`Failed to load metadata: ${String(error)}`, "error");
  }
}

export function openTagEditor(book: BookSummary) {
  tagEditorState.isOpen = true;
  tagEditorState.filePath = book.filePath;
  tagEditorState.books = null;
  tagEditorState.bookTitle = book.fileName;
  tagEditorState.tags = [...book.tags];
  tagEditorState.input = "";
  setTagEditorStatus("");
  syncTagEditorUi();
}

export async function openBookMetadataEditor(book: BookSummary) {
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

export function closeTagEditor() {
  tagEditorState.isOpen = false;
  tagEditorState.filePath = null;
  tagEditorState.books = null;
  tagEditorState.input = "";
  setTagEditorStatus("");
  syncTagEditorUi();
}

function closeBookMetadataEditor() {
  bookMetadataEditorState.isOpen = false;
  bookMetadataEditorState.filePath = null;
  bookMetadataEditorState.books = null;
  bookMetadataEditorState.existingMetadataMap = new Map();
  bookMetadataEditorState.fieldPolicies = {};
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

function buildBookMetadataDraftFromForm(): BookMetadataDraft {
  const readField = (id: string) =>
    document.querySelector<HTMLInputElement | HTMLTextAreaElement>(id)?.value;

  return mergeBookMetadataFormValues(
    {
      title: readField("#book-metadata-title"),
      authorsText: readField("#book-metadata-authors"),
      description: readField("#book-metadata-description"),
      publisher: readField("#book-metadata-publisher"),
      releaseDate: readField("#book-metadata-release-date"),
      language: readField("#book-metadata-language"),
      url: readField("#book-metadata-url"),
      asin: readField("#book-metadata-asin"),
      coverUrl: readField("#book-metadata-cover-url"),
    },
    bookMetadataEditorState,
  );
}

function applyBookMetadataDraftToState(draft: BookMetadataDraft) {
  for (const key of BOOK_METADATA_DRAFT_KEYS) {
    bookMetadataEditorState[key] = draft[key];
  }
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

async function saveTagEditorChanges() {
  for (const tag of tagEditorState.tags) {
    const result = validateTagValue(tag);
    if (!result.ok) {
      setTagEditorStatus(result.message, "error");
      return;
    }
  }

  if (tagEditorState.books !== null) {
    if (tagEditorState.tags.length === 0) {
      setTagEditorStatus("Add at least one tag to apply to the selected books.", "error");
      return;
    }
    try {
      for (const book of tagEditorState.books) {
        const merged = [...new Set([...book.tags, ...tagEditorState.tags])];
        const payload = await invoke<BookTagsPayload>("save_book_tags", {
          filePath: book.filePath,
          tags: merged,
        });
        updateBookTagsInState(payload.filePath, payload.tags);
      }
      closeTagEditor();
      renderApp();
    } catch (error) {
      setTagEditorStatus(`Failed to save tags: ${String(error)}`, "error");
    }
    return;
  }

  if (!tagEditorState.filePath) {
    return;
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

async function saveBookMetadataChangesMulti() {
  const draft = buildBookMetadataDraftFromForm();
  const books = bookMetadataEditorState.books!;
  const existingMap = bookMetadataEditorState.existingMetadataMap;

  // Determine which fields the user actually filled
  type DraftKey = keyof typeof draft;
  const filledFields: DraftKey[] = (Object.keys(draft) as DraftKey[]).filter(
    (k) => draft[k].trim() !== "",
  );
  if (filledFields.length === 0) {
    setBookMetadataStatus("Fill in at least one field before saving.", "error");
    return;
  }

  function resolveField(fieldKey: string, userValue: string, existingValue: string): string {
    const policy: MetadataFieldPolicy =
      (bookMetadataEditorState.fieldPolicies[fieldKey] as MetadataFieldPolicy | undefined) ??
      "fill-empty";
    if (!userValue.trim()) return existingValue;
    if (policy === "fill-empty" && existingValue.trim()) return existingValue;
    return userValue;
  }

  try {
    for (const book of books) {
      const existing = existingMap.get(book.filePath);
      if (!existing) continue;
      const existingAuthors = joinMetadataAuthors(existing.authors);
      const resolvedAuthorsText = resolveField("authorsText", draft.authorsText, existingAuthors);
      await invoke<BookMetadataPayload>("save_book_metadata", {
        input: {
          filePath: book.filePath,
          sourceType: null,
          title: resolveField("title", draft.title, existing.title),
          authors: normalizeMetadataAuthorsText(resolvedAuthorsText),
          description: resolveField("description", draft.description, existing.description),
          publisher: resolveField("publisher", draft.publisher, existing.publisher),
          releaseDate: resolveField("releaseDate", draft.releaseDate, existing.releaseDate),
          language: resolveField("language", draft.language, existing.language),
          url: resolveField("url", draft.url, existing.url),
          asin: resolveField("asin", draft.asin, existing.asin),
          coverUrl: resolveField("coverUrl", draft.coverUrl, existing.coverUrl),
        },
      });
    }
    closeBookMetadataEditor();
    await refreshSnapshot();
  } catch (error) {
    setBookMetadataStatus(`Failed to save: ${String(error)}`, "error");
  }
}

async function saveBookMetadataChanges() {
  if (bookMetadataEditorState.books !== null) {
    await saveBookMetadataChangesMulti();
    return;
  }

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

  if (!bookMetadataEditorState.filePath && draft.asin.trim()) {
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
      ? appState.lastSnapshot?.customSources.find(
          (s) => s.id === bookMetadataEditorState.sourceType,
        )
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
            releaseDate: payload.releaseDate || null,
            language: payload.language || null,
            lastReadAt: null,
            indexedAt: Math.floor(Date.now() / 1000),
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
  appState.lastAppConfig = await invoke<AppConfigPayload>("load_app_config");
  const theme = normalizeAppTheme(appState.lastAppConfig.theme);
  applyAppTheme(theme);
  persistAppTheme(theme);
  syncAppSettingsUi();
}

let libraryRootAddInFlight = false;
let libraryDropStatusTimer: ReturnType<typeof setTimeout> | null = null;

function isLibraryWelcomeVisible() {
  const welcomeEl = document.querySelector<HTMLElement>("#library-welcome");
  return Boolean(welcomeEl && !welcomeEl.hidden && !viewerState.currentBook);
}

function setLibraryDropOverlay(
  state: { phase: "drag" | "status"; message: string; tone?: StatusTone } | null,
) {
  const overlayEl = document.querySelector<HTMLElement>("#library-drop-overlay");
  const messageEl = document.querySelector<HTMLElement>("#library-drop-overlay-message");
  if (libraryDropStatusTimer !== null) {
    clearTimeout(libraryDropStatusTimer);
    libraryDropStatusTimer = null;
  }
  if (state?.phase === "drag") {
    document.body.dataset.libraryDrag = "active";
  } else {
    delete document.body.dataset.libraryDrag;
  }
  if (!overlayEl || !messageEl) {
    return;
  }
  if (!state) {
    overlayEl.hidden = true;
    return;
  }
  overlayEl.hidden = false;
  overlayEl.dataset.phase = state.phase;
  const toneAttr = statusToneAttribute(state.tone ?? "neutral");
  if (toneAttr === null) {
    delete overlayEl.dataset.tone;
  } else {
    overlayEl.dataset.tone = toneAttr;
  }
  messageEl.textContent = state.message;
}

// The welcome screen carries its own status line; elsewhere the overlay
// shrinks to a status pill that fades out once the outcome is known.
function reportLibraryAddStatus(message: string, tone: StatusTone) {
  const welcomeStatusEl = document.querySelector<HTMLElement>("#library-welcome-status");
  if (isLibraryWelcomeVisible() && welcomeStatusEl) {
    setLibraryDropOverlay(null);
    applyStatusMessage(welcomeStatusEl, message, tone);
    return;
  }
  setLibraryDropOverlay({ phase: "status", message, tone });
  if (tone !== "neutral") {
    libraryDropStatusTimer = setTimeout(
      () => {
        libraryDropStatusTimer = null;
        setLibraryDropOverlay(null);
      },
      tone === "error" ? 6000 : 3000,
    );
  }
}

function syncLibraryWelcomeControls() {
  const chooseEl = document.querySelector<HTMLButtonElement>("#library-welcome-choose");
  if (chooseEl) {
    chooseEl.disabled = libraryRootAddInFlight;
  }
}

/** Adds dropped or chosen folders as library roots, scanning each one. */
async function addLibraryRoots(paths: string[]) {
  if (libraryRootAddInFlight || paths.length === 0) {
    return;
  }
  libraryRootAddInFlight = true;
  syncLibraryWelcomeControls();
  const errors: string[] = [];
  const added: string[] = [];
  try {
    for (const path of paths) {
      const name = folderDisplayName(path);
      reportLibraryAddStatus(t("status.scanning", { name }), "neutral");
      try {
        appState.lastAppConfig = await invoke<AppConfigPayload>("add_library_root", { path });
        added.push(path);
      } catch (error) {
        errors.push(describeAddLibraryRootError(uiLocale, error, name));
      }
    }
  } finally {
    libraryRootAddInFlight = false;
    syncLibraryWelcomeControls();
  }

  if (added.length > 0 && viewerState.isLibraryWelcomeRequested) {
    viewerState.isLibraryWelcomeRequested = false;
    renderApp();
  }

  // The scan's `library-updated` event has already re-rendered the library.
  const [onlyAdded] = added;
  if (errors.length > 0) {
    reportLibraryAddStatus(errors.join(" "), "error");
  } else if (added.length === 1 && onlyAdded) {
    reportLibraryAddStatus(t("status.addedOne", { name: folderDisplayName(onlyAdded) }), "success");
  } else {
    reportLibraryAddStatus(t("status.addedMany", { count: added.length }), "success");
  }
}

function handleLibraryDragDrop(event: DragDropEvent) {
  // The Settings form edits its own draft of the root list; a drop would
  // silently replace it, so drops are ignored while it is open.
  if (viewerState.isAppSettingsOpen || libraryRootAddInFlight) {
    return;
  }
  switch (event.type) {
    case "enter":
      if (event.paths.length > 0) {
        setLibraryDropOverlay({
          phase: "drag",
          message:
            event.paths.length === 1
              ? t("drop.one")
              : t("drop.many", { count: event.paths.length }),
        });
      }
      break;
    case "over":
      break;
    case "leave":
      if (document.body.dataset.libraryDrag === "active") {
        setLibraryDropOverlay(null);
      }
      break;
    case "drop":
      setLibraryDropOverlay(null);
      void addLibraryRoots(event.paths);
      break;
  }
}

async function saveAppSettingsFromForm() {
  const excludedPatternsEl = document.querySelector<HTMLTextAreaElement>(
    "#config-excluded-patterns",
  );
  const pdfRendererEl = document.querySelector<HTMLSelectElement>("#config-pdf-renderer");
  const themeEl = document.querySelector<HTMLSelectElement>("#config-theme");
  const kindleEnabledEl = document.querySelector<HTMLInputElement>("#config-kindle-enabled");

  const libraryRoots = [...(appState.lastAppConfig?.libraryRoots ?? [])];

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

    appState.lastAppConfig = payload;
    applyAppTheme(payload.theme);
    persistAppTheme(payload.theme);
    const snapshot = await invoke<LibrarySnapshot>("load_library_snapshot");
    appState.lastSnapshot = snapshot;
    viewerState.books = snapshot.books;
    renderApp();
    viewerState.isAppSettingsOpen = false;
    setAppSettingsStatus("");
    syncAppSettingsUi();
  } catch (error) {
    setAppSettingsStatus(`Failed to save settings: ${String(error)}`, "error");
  }
}

function initLibraryAddButtons() {
  const libraryAddKindleEl = document.querySelector<HTMLButtonElement>("#library-add-kindle");
  const libraryAddCustomEl2 = document.querySelector<HTMLButtonElement>("#library-add-custom");

  libraryAddKindleEl?.addEventListener("click", () => {
    openNewKindleBookEditor();
  });
  libraryAddCustomEl2?.addEventListener("click", () => {
    const source =
      viewerState.activeExternalSource && viewerState.activeExternalSource !== "kindle"
        ? (appState.lastSnapshot?.customSources ?? []).find(
            (s) => s.id === viewerState.activeExternalSource,
          )
        : undefined;
    if (source) {
      openNewCustomBookEditor(source);
    }
  });
}

function initCustomSourceEditor() {
  const configAddCustomSourceEl = document.querySelector<HTMLButtonElement>(
    "#config-add-custom-source",
  );
  const customSourceSaveEl = document.querySelector<HTMLButtonElement>("#custom-source-save");
  const customSourceCancelEl = document.querySelector<HTMLButtonElement>("#custom-source-cancel");
  const customSourceCloseEl = document.querySelector<HTMLButtonElement>("#custom-source-close");
  const customSourceBackdropEl = document.querySelector<HTMLElement>("#custom-source-backdrop");
  const customSourceDeleteEl = document.querySelector<HTMLButtonElement>("#custom-source-delete");
  const customSourceNameEl = document.querySelector<HTMLInputElement>("#custom-source-name");
  const iconPickerEl = document.querySelector<HTMLElement>("#custom-source-icon-picker");
  configAddCustomSourceEl?.addEventListener("click", () => openCustomSourceEditor());
  customSourceSaveEl?.addEventListener("click", () => void saveCustomSource());
  customSourceCancelEl?.addEventListener("click", () => closeCustomSourceEditor());
  customSourceCloseEl?.addEventListener("click", () => closeCustomSourceEditor());
  customSourceBackdropEl?.addEventListener("click", () => closeCustomSourceEditor());
  customSourceDeleteEl?.addEventListener("click", () => {
    void deleteCustomSourceFromEditor();
  });
  customSourceNameEl?.addEventListener("input", () => {
    customSourceEditorState.name = customSourceNameEl.value;
  });
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
}

export const closeAppSettings = () => {
  viewerState.isAppSettingsOpen = false;
  setAppSettingsStatus("");
  syncAppSettingsUi();
};
export const closeAbout = () => {
  viewerState.isAboutOpen = false;
  syncAboutUi();
};
function initAppSettings() {
  const appSettingsOpenEl = document.querySelector<HTMLButtonElement>("#app-settings-open");
  const appSettingsCloseEl = document.querySelector<HTMLButtonElement>("#app-settings-close");
  const appSettingsCancelEl = document.querySelector<HTMLButtonElement>("#app-settings-cancel");
  const appSettingsSaveEl = document.querySelector<HTMLButtonElement>("#app-settings-save");
  const appSettingsBackdropEl = document.querySelector<HTMLElement>("#app-settings-backdrop");
  const appSettingsAddRootEl = document.querySelector<HTMLButtonElement>(
    "#config-library-roots-add",
  );

  appSettingsOpenEl?.addEventListener("click", async () => {
    viewerState.isAppSettingsOpen = true;
    setAppSettingsStatus("");
    syncAppSettingsUi();
    void refreshFulltextStatus();
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
    const defaultPath =
      appState.lastAppConfig?.libraryRoots[appState.lastAppConfig.libraryRoots.length - 1] ?? "~/";

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
      const currentRoots = addLibraryRoot(
        appState.lastAppConfig?.libraryRoots ?? [],
        collapsedSelection,
      );
      appState.lastAppConfig = {
        configPath: appState.lastAppConfig?.configPath ?? "",
        configExists: appState.lastAppConfig?.configExists ?? false,
        libraryRoots: currentRoots,
        excludedPatterns: appState.lastAppConfig?.excludedPatterns ?? [],
        pdfRenderer: appState.lastAppConfig?.pdfRenderer ?? "native",
        theme: appState.lastAppConfig?.theme ?? "default",
        enabledExternalSources: appState.lastAppConfig?.enabledExternalSources ?? ["kindle"],
      };
      syncAppSettingsUi();
    } catch (error) {
      setAppSettingsStatus(`Failed to choose a folder: ${String(error)}`, "error");
    }
  });
}

function initLibraryWelcome() {
  document.querySelector("#config-library-welcome-open")?.addEventListener("click", () => {
    closeAppSettings();
    viewerState.isLibraryWelcomeRequested = true;
    const welcomeStatusEl = document.querySelector<HTMLElement>("#library-welcome-status");
    if (welcomeStatusEl) {
      applyStatusMessage(welcomeStatusEl, "");
    }
    if (viewerState.currentBook || hasActiveLibraryFilter()) {
      // Leaving the book or filter would otherwise cancel the request.
      void navigateToState(
        {
          bookFilePath: null,
          activeDirectory: null,
          activeTag: null,
          activeExternalSource: null,
          activeShelf: null,
          activeTagDirectOnly: false,
          searchQuery: "",
        },
        "push",
      ).then(() => {
        viewerState.isLibraryWelcomeRequested = true;
        renderApp();
      });
      return;
    }
    renderApp();
  });

  document.querySelector("#library-welcome-close")?.addEventListener("click", () => {
    viewerState.isLibraryWelcomeRequested = false;
    renderApp();
  });
}

function initAbout() {
  const appAboutOpenEl = document.querySelector<HTMLButtonElement>("#app-about-open");
  const appAboutCloseEl = document.querySelector<HTMLButtonElement>("#app-about-close");
  const appAboutDoneEl = document.querySelector<HTMLButtonElement>("#app-about-done");
  const appAboutBackdropEl = document.querySelector<HTMLElement>("#app-about-backdrop");

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
}

function initShelfEditor() {
  const shelfEditorCloseEl = document.querySelector<HTMLButtonElement>("#shelf-editor-close");
  const shelfEditorCancelEl = document.querySelector<HTMLButtonElement>("#shelf-editor-cancel");
  const shelfEditorBackdropEl = document.querySelector<HTMLElement>("#shelf-editor-backdrop");
  const shelfEditorSaveEl = document.querySelector<HTMLButtonElement>("#shelf-editor-save");
  const shelfEditorDeleteEl = document.querySelector<HTMLButtonElement>("#shelf-editor-delete");
  const shelfEditorNameEl = document.querySelector<HTMLInputElement>("#shelf-editor-name");
  const shelfEditorQueryEl = document.querySelector<HTMLTextAreaElement>("#shelf-editor-query");
  const shelfEditorModeEl = document.querySelector<HTMLElement>("#shelf-editor-mode");
  const shelfEditorAddConditionEl = document.querySelector<HTMLButtonElement>(
    "#shelf-editor-add-condition",
  );
  const shelfIconPickerEl = document.querySelector<HTMLElement>("#shelf-editor-icon-picker");
  shelfEditorCloseEl?.addEventListener("click", closeShelfEditor);
  shelfEditorCancelEl?.addEventListener("click", closeShelfEditor);
  shelfEditorBackdropEl?.addEventListener("click", closeShelfEditor);
  shelfEditorSaveEl?.addEventListener("click", () => {
    void saveShelfFromEditor();
  });
  shelfEditorDeleteEl?.addEventListener("click", () => {
    void deleteShelfFromEditor();
  });
  shelfEditorNameEl?.addEventListener("input", () => {
    shelfEditorState.name = shelfEditorNameEl.value;
  });
  shelfEditorQueryEl?.addEventListener("input", () => {
    shelfEditorState.query = shelfEditorQueryEl.value;
    updateShelfPreview();
  });
  shelfEditorModeEl?.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>(
      ".shelf-editor-mode-btn",
    );
    if (!target) return;
    const mode = target.dataset.mode as ShelfMode | undefined;
    if (!mode) return;
    setShelfEditorMode(mode);
  });
  if (shelfIconPickerEl && shelfIconPickerEl.childElementCount === 0) {
    for (const icon of SHELF_ICONS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "custom-source-icon-option";
      btn.dataset.icon = icon.cls;
      btn.title = icon.label;
      btn.innerHTML = `<i class="${icon.cls}" aria-hidden="true"></i>`;
      btn.addEventListener("click", () => {
        shelfEditorState.icon = icon.cls;
        syncShelfEditorUi();
      });
      shelfIconPickerEl.appendChild(btn);
    }
  }
  shelfEditorAddConditionEl?.addEventListener("click", () => {
    shelfEditorState.rows.push({ field: "free", negate: false, value: "" });
    syncShelfEditorUi();
    setTimeout(() => {
      const inputs = document.querySelectorAll<HTMLInputElement>(".shelf-editor-condition-value");
      inputs[inputs.length - 1]?.focus();
    }, 0);
  });
}

function initTagEditor() {
  const tagEditorBackdropEl = document.querySelector<HTMLElement>("#tag-editor-backdrop");
  const tagEditorCloseEl = document.querySelector<HTMLButtonElement>("#tag-editor-close");
  const tagEditorCancelEl = document.querySelector<HTMLButtonElement>("#tag-editor-cancel");
  const tagEditorSaveEl = document.querySelector<HTMLButtonElement>("#tag-editor-save");
  const tagEditorAddEl = document.querySelector<HTMLButtonElement>("#tag-editor-add");
  const tagEditorInputEl = document.querySelector<HTMLInputElement>("#tag-editor-input");
  const tagManagerBackdropEl = document.querySelector<HTMLElement>("#tag-manager-backdrop");
  const tagManagerCloseEl = document.querySelector<HTMLButtonElement>("#tag-manager-close");
  const tagManagerCancelEl = document.querySelector<HTMLButtonElement>("#tag-manager-cancel");
  const tagManagerRenameEl = document.querySelector<HTMLButtonElement>("#tag-manager-rename");
  const tagManagerDeleteEl = document.querySelector<HTMLButtonElement>("#tag-manager-delete");
  const tagManagerInputEl = document.querySelector<HTMLInputElement>("#tag-manager-rename-input");

  tagEditorCloseEl?.addEventListener("click", closeTagEditor);
  tagEditorCancelEl?.addEventListener("click", closeTagEditor);
  tagEditorBackdropEl?.addEventListener("click", closeTagEditor);
  tagEditorAddEl?.addEventListener("click", addTagFromEditorInput);
  tagEditorSaveEl?.addEventListener("click", () => {
    void saveTagEditorChanges();
  });
  tagManagerCloseEl?.addEventListener("click", closeTagManager);
  tagManagerCancelEl?.addEventListener("click", closeTagManager);
  tagManagerBackdropEl?.addEventListener("click", closeTagManager);
  tagManagerRenameEl?.addEventListener("click", () => {
    void renameTagFromManager();
  });
  tagManagerDeleteEl?.addEventListener("click", () => {
    void deleteTagFromManager();
  });
  tagManagerInputEl?.addEventListener("input", () => {
    tagManagerState.renameInput = tagManagerInputEl.value;
  });
  tagManagerInputEl?.addEventListener("compositionstart", () => {
    isTagManagerComposing = true;
  });
  tagManagerInputEl?.addEventListener("compositionend", () => {
    isTagManagerComposing = false;
  });
  tagManagerInputEl?.addEventListener("keydown", (event) => {
    if (
      event.key === "Enter" &&
      !event.isComposing &&
      !isTagManagerComposing &&
      event.keyCode !== 229
    ) {
      event.preventDefault();
      void renameTagFromManager();
    }
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
}

function initBookMetadataEditor() {
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
}

async function registerLibraryDrops() {
  await getCurrentWebview().onDragDropEvent((event) => {
    handleLibraryDragDrop(event.payload);
  });

  document.querySelector("#library-welcome-choose")?.addEventListener("click", async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        defaultPath: "~/",
        title: t("welcome.dialogTitle"),
      });
      const path = Array.isArray(selected) ? selected[0] : selected;
      if (path) {
        await addLibraryRoots([path]);
      }
    } catch (error) {
      reportLibraryAddStatus(t("status.chooseFailed", { error: String(error) }), "error");
    }
  });
}

async function loadAppMetadata() {
  try {
    cachedAppName = await getName();
    cachedAppVersion = await getVersion();
  } catch (error) {
    console.error("failed to load app metadata", error);
  }
  syncAboutUi();
}

window.addEventListener("DOMContentLoaded", async () => {
  applyStaticTranslations();
  await primeHomeDirCache();
  initBulkSelection();
  initLibrarySearch();
  initNavigationControls();
  initViewerPageJump();
  initShellControls();
  initPdfStageScroll();
  initLibraryViewControls();
  initLibraryAddButtons();
  initCustomSourceEditor();
  initSidebarControls();
  initAppSettings();
  initFulltextSettings();
  initLibraryWelcome();
  initAbout();
  initViewerEditorButtons();
  initShelfEditor();
  initTagEditor();
  initBookMetadataEditor();
  initViewerSettingsPanel();
  initTocToggle();
  initNotes();
  initPdfSearch();
  initGlobalShortcuts();
  initEpubFocusGuard();
  initViewerResize();
  initFlushOnUnload();
  await registerLibraryEvents();
  await registerLibraryDrops();
  await registerThumbnailEvents();
  await registerFulltextEvents();
  initHistoryPopstate();
  try {
    await loadAppConfig();
  } catch (error) {
    applyAppTheme("default");
    console.error("failed to load app config", error);
  } finally {
    finishStartupPhase();
  }

  await refreshShelves();
  loadInitialLibraryState();
  await loadAppMetadata();
});
