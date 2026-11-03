// Editor for user-defined external sources.

import { invoke } from "@tauri-apps/api/core";
import { confirm, message } from "@tauri-apps/plugin-dialog";
import { syncControlValue } from "./dom";
import { renderApp, syncAppSettingsUi } from "./shell";
import { appState, viewerState } from "./state";
import type { CustomSource, LibrarySnapshot } from "./types";

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

export async function deleteCustomSource(source: CustomSource) {
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

export function initCustomSourceEditor() {
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
