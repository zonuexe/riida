// Collapses absolute paths under the home directory to `~/…` for display and
// config storage.

import { homeDir } from "@tauri-apps/api/path";

export let cachedHomeDir: string | null = null;

export async function collapseHomePath(path: string) {
  if (!cachedHomeDir) {
    try {
      cachedHomeDir = (await homeDir()).replace(/\/+$/, "");
    } catch {
      cachedHomeDir = "";
    }
  }

  if (!cachedHomeDir) {
    return path;
  }

  if (path === cachedHomeDir) {
    return "~";
  }

  if (path.startsWith(`${cachedHomeDir}/`)) {
    return `~/${path.slice(cachedHomeDir.length + 1)}`;
  }

  return path;
}

export async function primeHomeDirCache() {
  if (cachedHomeDir !== null) {
    return;
  }

  try {
    cachedHomeDir = (await homeDir()).replace(/\/+$/, "");
  } catch {
    cachedHomeDir = "";
  }
}
