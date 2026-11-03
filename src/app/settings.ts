// App Settings sheet: library roots, external sources, theme and renderer.

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { addLibraryRoot, buildAppConfigDraft, normalizeAppTheme } from "../app-config-utils";
import { applyAppTheme, persistAppTheme } from "../app-theme";
import type { StatusTone } from "../dom-form-utils";
import { deleteCustomSource, openCustomSourceEditor } from "./custom-sources";
import { applyStatusMessage } from "./dom";
import { refreshFulltextStatus } from "./fulltext";
import { collapseHomePath } from "./home-path";
import { renderApp } from "./shell";
import { appState, viewerState } from "./state";
import type { AppConfigPayload, LibrarySnapshot } from "./types";

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

export function syncAppSettingsUi() {
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

export async function loadAppConfig() {
  appState.lastAppConfig = await invoke<AppConfigPayload>("load_app_config");
  const theme = normalizeAppTheme(appState.lastAppConfig.theme);
  applyAppTheme(theme);
  persistAppTheme(theme);
  syncAppSettingsUi();
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

export const closeAppSettings = () => {
  viewerState.isAppSettingsOpen = false;
  setAppSettingsStatus("");
  syncAppSettingsUi();
};

export function initAppSettings() {
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
