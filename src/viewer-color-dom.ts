// Applies viewer background presets to the DOM. Shared by the library shell
// and the standalone viewer window.

import type { AppTheme } from "./app-config-utils";
import {
  type ViewerBackgroundMode,
  type ViewerColorPalette,
  viewerColorPaletteForMode,
} from "./viewer-settings-utils";

/**
 * Paint the reading surface behind PDF pages: the `#main-pane` background.
 * "inherit-theme" removes the override so the app theme shows through.
 */
export function applyPdfViewerBackground(
  backgroundMode: ViewerBackgroundMode,
  appTheme: AppTheme | null,
): void {
  const mainPaneEl = document.querySelector<HTMLElement>("#main-pane");
  if (!mainPaneEl) {
    return;
  }

  if (backgroundMode === "inherit-theme") {
    mainPaneEl.style.removeProperty("background-color");
    return;
  }

  mainPaneEl.style.backgroundColor = viewerColorPaletteForMode(backgroundMode, appTheme).background;
}

/**
 * Force an EPUB section document's background, body text and link colours
 * to the palette. All `!important` so the book's own CSS does not win.
 */
export function applyEpubColorsToDocument(doc: Document, palette: ViewerColorPalette): void {
  for (const el of [doc.documentElement, doc.body]) {
    el?.style.setProperty("background-color", palette.background, "important");
    el?.style.setProperty("color", palette.foreground, "important");
  }

  for (const linkEl of doc.querySelectorAll<HTMLElement>("a[href]")) {
    linkEl.style.setProperty("color", palette.link, "important");
  }
}
