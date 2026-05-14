import { normalizeAppTheme, type AppTheme } from "./app-config-utils";

// Must match the literal hard-coded in the early-theme inline script in
// index.html (and any other HTML entries), which runs before the bundle is
// available for importing this module.
export const APP_THEME_STORAGE_KEY = "riida.appTheme";

export function isDarkAppTheme(theme: AppTheme): boolean {
  return theme === "night-city" || theme === "navy-blue";
}

export type ThemeStorage = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): ThemeStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function defaultRoot(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return document.documentElement;
}

export function applyAppTheme(theme: AppTheme, root: HTMLElement | null = defaultRoot()): void {
  if (!root) return;
  root.dataset.theme = theme;
  root.style.colorScheme = isDarkAppTheme(theme) ? "dark" : "light";
}

export function persistAppTheme(
  theme: AppTheme,
  storage: ThemeStorage | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(APP_THEME_STORAGE_KEY, theme);
  } catch {
    // Storage full or unavailable — skip persistence.
  }
}

export function loadPersistedAppTheme(
  storage: ThemeStorage | null = defaultStorage(),
): AppTheme | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(APP_THEME_STORAGE_KEY);
    if (raw === null) return null;
    return normalizeAppTheme(raw);
  } catch {
    return null;
  }
}
