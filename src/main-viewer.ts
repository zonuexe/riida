// Entry point for the standalone viewer window (v0.6.0 work-in-progress).
//
// This file intentionally stays minimal: it parses the spawn-time URL
// parameters, applies the persisted theme, and renders a placeholder so the
// multi-window plumbing (Rust window-spawn command + vite multi-entry build)
// can be wired up and verified end-to-end before the real viewer
// implementation is migrated out of src/main.ts.

import "./vendor/fontawesome/css/fontawesome.min.css";
import "./vendor/fontawesome/css/solid.min.css";
import { applyAppTheme, loadPersistedAppTheme } from "./app-theme";

type ViewerLaunchParams = {
  filePath: string | null;
  source: string | null;
};

function readLaunchParams(search: string): ViewerLaunchParams {
  const params = new URLSearchParams(search);
  const filePath = params.get("file");
  const source = params.get("source");
  return {
    filePath: filePath && filePath.length > 0 ? filePath : null,
    source: source && source.length > 0 ? source : null,
  };
}

function renderPlaceholder({ filePath, source }: ViewerLaunchParams): void {
  const targetEl = document.querySelector<HTMLElement>("#viewer-window-target");
  if (!targetEl) return;

  if (!filePath) {
    targetEl.textContent = "No file specified.";
    return;
  }

  const label = source ? `${filePath} (source: ${source})` : filePath;
  targetEl.textContent = label;
}

function boot(): void {
  const cachedTheme = loadPersistedAppTheme();
  if (cachedTheme) {
    applyAppTheme(cachedTheme);
  }

  renderPlaceholder(readLaunchParams(window.location.search));

  document.body.dataset.startup = "ready";
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
}

export const __testables = { readLaunchParams };
