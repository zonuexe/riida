// Shared epub.js runtime loader.
//
// Both src/main.ts (library shell) and src/main-viewer.ts (standalone
// viewer window) consume this module. Each Tauri webview has its own
// JavaScript context, so the cached promise is intentionally per-window —
// epub.js instances in two windows don't share state.

let epubJsModulePromise: Promise<typeof import("epubjs")> | null = null;

export async function loadEpubJs(): Promise<typeof import("epubjs")> {
  epubJsModulePromise ??= import("epubjs");
  return epubJsModulePromise;
}
