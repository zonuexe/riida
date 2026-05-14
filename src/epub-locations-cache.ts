// localStorage-backed cache for epub.js `book.locations.save()` blobs, keyed
// on (file size, file path). The size component invalidates the cache when an
// EPUB file is replaced in place, without having to track a content hash.

const STORAGE_PREFIX = "riida:epub-locations";

export function epubLocationsStorageKey(filePath: string, fileSize: number): string {
  return `${STORAGE_PREFIX}:${fileSize}:${filePath}`;
}

function hasValidIdentity(filePath: string, fileSize: number): boolean {
  return Boolean(filePath) && Number.isFinite(fileSize) && fileSize > 0;
}

export type LocationsStorage = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): LocationsStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadCachedEpubLocations(
  filePath: string,
  fileSize: number,
  storage: LocationsStorage | null = defaultStorage(),
): string | null {
  if (!hasValidIdentity(filePath, fileSize) || !storage) return null;
  try {
    return storage.getItem(epubLocationsStorageKey(filePath, fileSize));
  } catch {
    return null;
  }
}

export function saveCachedEpubLocations(
  filePath: string,
  fileSize: number,
  serialized: string,
  storage: LocationsStorage | null = defaultStorage(),
): void {
  if (!hasValidIdentity(filePath, fileSize) || !serialized || !storage) return;
  try {
    storage.setItem(epubLocationsStorageKey(filePath, fileSize), serialized);
  } catch {
    // localStorage full or unavailable — skip caching.
  }
}
