// Per-book tag editor and the sidebar tag manager (rename, delete).

import { invoke } from "@tauri-apps/api/core";
import { confirm, message } from "@tauri-apps/plugin-dialog";
import type { StatusTone } from "../dom-form-utils";
import { deriveTags } from "../library-utils";
import { suggestTagCompletions } from "../tag-suggestions";
import { countBooksWithTagOrDescendants, validateTagValue } from "../tag-utils";
import { applyStatusMessage, syncControlValue } from "./dom";
import { renderApp } from "./library";
import { refreshSnapshot, updateBookTagsInState } from "./library-data";
import { appState, viewerState } from "./state";
import type { BookSummary } from "./types";

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

function setTagEditorStatus(message: string, tone: StatusTone = "neutral") {
  const statusEl = document.querySelector<HTMLElement>("#tag-editor-status");
  if (!statusEl) {
    return;
  }

  tagEditorState.statusMessage = message;
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

export function closeTagEditor() {
  tagEditorState.isOpen = false;
  tagEditorState.filePath = null;
  tagEditorState.books = null;
  tagEditorState.input = "";
  setTagEditorStatus("");
  syncTagEditorUi();
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

export function initTagEditor() {
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
