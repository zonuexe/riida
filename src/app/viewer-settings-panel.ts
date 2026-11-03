// The viewer settings panel: its controls, scope tabs and live previews. It
// sits above the viewers because a change re-renders or rebuilds the open book.

import { invoke } from "@tauri-apps/api/core";
import {
  preferredExplicitViewerBackgroundMode,
  switchViewerSettingsScopeInState,
  type ViewerBackgroundMode,
  type ViewerSettings,
  type ViewerSettingsPayload,
  type ViewerSettingsScope,
} from "../viewer-settings-utils";
import { rebuildImageEpub } from "./image-epub-viewer";
import {
  appState,
  currentAppTheme,
  currentViewerSettingsSourceType,
  viewerSettings,
  viewerState,
} from "./state";
import {
  applyEpubFontSize,
  applyEpubViewerColors,
  applyPdfViewerBackground,
  applyViewerSettingsPayload,
  applyViewerVerticalGapMode,
  currentViewerPreferences,
  setViewerDraft,
  syncImmediatePdfScrollMode,
  syncViewerSettingsUi,
} from "./viewer-settings";
import { renderCurrentPage } from "./viewer";
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
