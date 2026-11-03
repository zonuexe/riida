// Viewer settings panel and the global/per-file viewer preferences.

import { invoke } from "@tauri-apps/api/core";
import {
  applyViewerSettingsPayloadToState,
  DEFAULT_VIEWER_SETTINGS,
  normalizeViewerSourceType,
  preferredExplicitViewerBackgroundMode,
  switchViewerSettingsScopeInState,
  type ViewerBackgroundMode,
  viewerColorPaletteForMode,
  viewerExtraVerticalGap,
  type ViewerSettings,
  type ViewerSettingsPayload,
  type ViewerSettingsScope,
  type ViewerSourceType,
} from "../viewer-settings-utils";
import { applyEpubFontSize, applyEpubViewerColors, resizeEpubRendition } from "./epub-viewer";
import { rebuildImageEpub } from "./image-epub-viewer";
import { syncImmediatePdfScrollMode } from "./pdf-viewer";
import { currentAppTheme } from "./settings";
import { appState, viewerSettings, viewerState } from "./state";
import { syncTocUi } from "./toc";
import { renderCurrentPage } from "./viewer";

let viewerSettingsLoadToken = 0;

export function currentViewerSettingsSourceType(): ViewerSourceType | null {
  const currentBook = viewerState.currentBook;
  if (!currentBook) {
    return null;
  }

  return normalizeViewerSourceType(currentBook.sourceType);
}

export function applyPdfViewerBackground(backgroundMode: ViewerBackgroundMode) {
  const palette = viewerColorPaletteForMode(backgroundMode, currentAppTheme());

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

export function applyViewerVerticalGapMode(mode: ViewerSettings["verticalGapMode"]) {
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
    if (appState.activeEpubRendition) {
      requestAnimationFrame(() => resizeEpubRendition());
    }
  }
}

function setCheckedViewerBackgroundOption(groupName: string, value: ViewerBackgroundMode) {
  const input = document.querySelector<HTMLInputElement>(
    `input[name="${groupName}"][value="${value}"]`,
  );
  if (input) {
    input.checked = true;
  }
}

function syncViewerBackgroundControls(
  groupName: string,
  inheritCheckboxId: string,
  backgroundMode: ViewerBackgroundMode,
) {
  const inheritCheckbox = document.querySelector<HTMLInputElement>(`#${inheritCheckboxId}`);
  const group = document.querySelector<HTMLElement>(`#${groupName}`);
  const isInherited = backgroundMode === "inherit-theme";
  const explicitMode = preferredExplicitViewerBackgroundMode(backgroundMode, currentAppTheme());

  if (inheritCheckbox) {
    inheritCheckbox.checked = isInherited;
  }

  setCheckedViewerBackgroundOption(groupName, explicitMode);
  group?.classList.toggle("is-disabled", isInherited);
}

function syncImmediatePdfBackgroundPreview() {
  const sourceType = currentViewerSettingsSourceType();
  if (sourceType === "pdf" && appState.lastSnapshot?.pdfRenderer === "pdfjs") {
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

export function syncViewerSettingsUi() {
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
  const deskewModeEl = document.querySelector<HTMLInputElement>("#viewer-deskew-mode");
  const trimModeEl = document.querySelector<HTMLInputElement>("#viewer-trim-mode");
  const epubFontSizeEl = document.querySelector<HTMLInputElement>("#viewer-epub-font-size");
  const epubFontSizeOutputEl = document.querySelector<HTMLOutputElement>(
    "#viewer-epub-font-size-output",
  );
  const sourceType = currentViewerSettingsSourceType();
  const isPdfViewerSettingsAvailable =
    sourceType === "pdf" && appState.lastSnapshot?.pdfRenderer === "pdfjs";
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

  if (deskewModeEl) {
    deskewModeEl.checked = editingPreferences.deskewMode === "auto";
  }

  if (trimModeEl) {
    trimModeEl.checked = editingPreferences.trimMode === "auto";
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

export function currentViewerPreferences(): ViewerSettings {
  return {
    ...(viewerSettings.scope === "file" ? viewerSettings.fileDraft : viewerSettings.globalDraft),
  };
}

export function setViewerDraft(scope: ViewerSettingsScope, preferences: ViewerSettings) {
  if (scope === "file") {
    viewerSettings.fileDraft = { ...preferences };
    return;
  }

  viewerSettings.globalDraft = { ...preferences };
}

export function applyViewerPreferences(
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
  viewerSettings.deskewMode = preferences.deskewMode;
  viewerSettings.trimMode = preferences.trimMode;
  syncImmediatePdfScrollMode();
  viewerSettings.scope = scope;
  viewerSettings.hasFileOverride = hasFileOverride;
  viewerSettings.sourceType = sourceType;
}

export function applyViewerSettingsPayload(
  payload: ViewerSettingsPayload,
  sourceType: ViewerSourceType,
  preferredScope: ViewerSettingsScope = payload.usesFileOverride ? "file" : "global",
) {
  const nextState = applyViewerSettingsPayloadToState(payload, preferredScope);
  applyViewerPreferences(nextState, nextState.scope, nextState.hasFileOverride, sourceType);
  viewerSettings.globalDraft = nextState.globalDraft;
  viewerSettings.fileDraft = nextState.fileDraft;
}

export async function loadViewerSettingsForCurrentBook() {
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

export function initViewerSettingsPanel() {
  const viewerSettingsToggleEl =
    document.querySelector<HTMLButtonElement>("#viewer-settings-toggle");
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
  const viewerDeskewModeEl = document.querySelector<HTMLInputElement>("#viewer-deskew-mode");
  const viewerTrimModeEl = document.querySelector<HTMLInputElement>("#viewer-trim-mode");
  const viewerEpubFontSizeEl = document.querySelector<HTMLInputElement>("#viewer-epub-font-size");
  const viewerEpubFontSizeOutputEl = document.querySelector<HTMLOutputElement>(
    "#viewer-epub-font-size-output",
  );
  const viewerBackgroundInheritEl = document.querySelector<HTMLInputElement>(
    "#viewer-background-inherit",
  );

  viewerSettingsToggleEl?.addEventListener("click", () => {
    const isOpening = !viewerSettings.isSettingsOpen;
    viewerSettings.isSettingsOpen = isOpening;
    if (isOpening) {
      viewerSettings.scope = "file";
    }
    syncViewerSettingsUi();
  });

  const rerenderPdfJs = () => {
    const sourceType = currentViewerSettingsSourceType();
    syncViewerSettingsUi();
    if (
      sourceType === "pdf" &&
      appState.lastSnapshot?.pdfRenderer === "pdfjs" &&
      viewerState.currentBook
    ) {
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
        rebuildImageEpub();
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

  viewerDeskewModeEl?.addEventListener("change", () => {
    updateViewerSettings(() => {
      mutateEditingViewerSettings((preferences) => {
        preferences.deskewMode = viewerDeskewModeEl.checked ? "auto" : "off";
      });
    });
  });

  viewerTrimModeEl?.addEventListener("change", () => {
    updateViewerSettings(() => {
      mutateEditingViewerSettings((preferences) => {
        preferences.trimMode = viewerTrimModeEl.checked ? "auto" : "off";
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
            : preferredExplicitViewerBackgroundMode(preferences.backgroundMode, currentAppTheme());
        });
      },
      { rerenderPdf: false },
    );
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
}
