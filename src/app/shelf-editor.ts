// Editor for saved-search shelves.

import { invoke } from "@tauri-apps/api/core";
import { confirm } from "@tauri-apps/plugin-dialog";
import {
  deriveLanguages,
  derivePublishers,
  deriveSources,
  deriveTags,
  filterVisibleBooks,
} from "../library-utils";
import { suggestTagCompletions } from "../tag-suggestions";
import {
  composeShelfQuery,
  decomposeShelfQuery,
  type ShelfCondition,
  type ShelfFieldKey,
  type ShelfMode,
} from "../shelf-query.ts";
import { syncControlValue } from "./dom";
import { refreshShelves } from "./library-data";
import { navigateToState } from "./navigation";
import { renderApp } from "./shell";
import { appState, viewerState } from "./state";
import type { Shelf } from "./types";

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

export function initShelfEditor() {
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
