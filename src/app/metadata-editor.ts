// Book metadata editor, single and bulk, including JSON and EPUB import.

import { invoke } from "@tauri-apps/api/core";
import { confirm, message } from "@tauri-apps/plugin-dialog";
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
} from "../book-metadata-utils";
import type { StatusTone } from "../dom-form-utils";
import { applyStatusMessage, syncControlValue } from "./dom";
import { refreshSnapshot } from "./library-data";
import { appState, viewerState } from "./state";
import type { BookMetadataPayload, BookSummary, CustomSource } from "./types";

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

function setBookMetadataStatus(message: string, tone: StatusTone = "neutral") {
  const statusEl = document.querySelector<HTMLElement>("#book-metadata-status");
  if (!statusEl) {
    return;
  }

  bookMetadataEditorState.statusMessage = message;
  applyStatusMessage(statusEl, message, tone);
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

export function initLibraryAddButtons() {
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

export function initBookMetadataEditor() {
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
