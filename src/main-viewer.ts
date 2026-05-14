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

// The Rust open_viewer_window command injects an initialization script that
// sets this global on the new window before any other script runs. It is the
// authoritative source of spawn-time parameters; the query-string fallback is
// for tests and direct URL access during local development.
type InjectedLaunchParams = {
  filePath?: unknown;
  source?: unknown;
};

declare global {
  interface Window {
    __RIIDA_LAUNCH_PARAMS__?: InjectedLaunchParams;
  }
}

function coerceLaunchString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readLaunchParams(
  search: string,
  injected: InjectedLaunchParams | undefined = undefined,
): ViewerLaunchParams {
  if (injected) {
    return {
      filePath: coerceLaunchString(injected.filePath),
      source: coerceLaunchString(injected.source),
    };
  }
  const params = new URLSearchParams(search);
  return {
    filePath: coerceLaunchString(params.get("file")),
    source: coerceLaunchString(params.get("source")),
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

  renderPlaceholder(readLaunchParams(window.location.search, window.__RIIDA_LAUNCH_PARAMS__));

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
