// Global and per-file viewer preferences: loading them, the drafts the settings
// panel edits, syncing the panel's controls, and applying them to the viewers.

import { invoke } from "@tauri-apps/api/core";
import {
  applyViewerSettingsPayloadToState,
  DEFAULT_VIEWER_SETTINGS,
  preferredExplicitViewerBackgroundMode,
  type ViewerBackgroundMode,
  type ViewerColorPalette,
  viewerColorPaletteForMode,
  viewerExtraVerticalGap,
  type ViewerSettings,
  type ViewerSettingsPayload,
  type ViewerSettingsScope,
  type ViewerSourceType,
} from "../viewer-settings-utils";
import { currentViewerStage } from "./dom";
import {
  appState,
  currentAppTheme,
  currentViewerSettingsSourceType,
  viewerSettings,
  viewerState,
} from "./state";
import { syncTocUi } from "./toc";

let viewerSettingsLoadToken = 0;

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

// Applying preferences to the live epub.js rendition and PDF stage. The
// engines call these while they render, so they sit here below the engines.

export function applyEpubColorsToDocument(doc: Document, palette: ViewerColorPalette) {
  const root = doc.documentElement;
  const body = doc.body;

  root?.style.setProperty("background-color", palette.background, "important");
  root?.style.setProperty("color", palette.foreground, "important");
  body?.style.setProperty("background-color", palette.background, "important");
  body?.style.setProperty("color", palette.foreground, "important");

  const linkEls = doc.querySelectorAll<HTMLAnchorElement>("a[href]");
  for (const linkEl of linkEls) {
    linkEl.style.setProperty("color", palette.link, "important");
  }
}

export function applyEpubViewerColors(backgroundMode: ViewerBackgroundMode) {
  const epubViewerEl = document.querySelector<HTMLElement>("#epub-viewer");
  const mainPaneEl = document.querySelector<HTMLElement>("#main-pane");
  const palette = viewerColorPaletteForMode(backgroundMode, currentAppTheme());

  if (backgroundMode === "inherit-theme") {
    mainPaneEl?.style.removeProperty("background-color");
    epubViewerEl?.style.removeProperty("background-color");
  } else {
    if (mainPaneEl) {
      mainPaneEl.style.backgroundColor = palette.background;
    }
    if (epubViewerEl) {
      epubViewerEl.style.backgroundColor = palette.background;
    }
  }

  const contentsList = appState.activeEpubRendition
    ? ((appState.activeEpubRendition.getContents() as unknown as import("epubjs").Contents[]) ?? [])
    : [];
  for (const contents of contentsList) {
    if (contents.document) {
      applyEpubColorsToDocument(contents.document, palette);
    }
  }
}

export function applyEpubFontSize(fontSize: number) {
  if (!appState.activeEpubRendition) return;
  appState.activeEpubRendition.themes.fontSize(`${fontSize}%`);
}

export function resizeEpubRendition() {
  if (!appState.activeEpubRendition) return;
  const el = document.querySelector<HTMLElement>("#epub-viewer");
  if (!el) return;
  appState.activeEpubRendition.resize(el.clientWidth, el.clientHeight);
}

export function syncImmediatePdfScrollMode() {
  const stageEl = currentViewerStage();
  if (!stageEl) {
    return;
  }
  stageEl.dataset.scrollMode = viewerSettings.scrollMode;
}
