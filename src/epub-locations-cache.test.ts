import { describe, expect, it, vi } from "vitest";
import {
  epubLocationsStorageKey,
  loadCachedEpubLocations,
  saveCachedEpubLocations,
  type LocationsStorage,
} from "./epub-locations-cache";

function memoryStorage(): LocationsStorage & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    getItem: (key: string) => (store.has(key) ? (store.get(key) ?? null) : null),
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  };
}

describe("epubLocationsStorageKey", () => {
  it("encodes file size and path", () => {
    expect(epubLocationsStorageKey("/books/foo.epub", 12345)).toBe(
      "riida:epub-locations:12345:/books/foo.epub",
    );
  });

  it("changes when file size changes (cache invalidation)", () => {
    const a = epubLocationsStorageKey("/books/foo.epub", 1);
    const b = epubLocationsStorageKey("/books/foo.epub", 2);
    expect(a).not.toBe(b);
  });
});

describe("loadCachedEpubLocations", () => {
  it("returns the previously stored serialization", () => {
    const storage = memoryStorage();
    storage.store.set(epubLocationsStorageKey("/books/foo.epub", 42), '["cfi:1"]');
    expect(loadCachedEpubLocations("/books/foo.epub", 42, storage)).toBe('["cfi:1"]');
  });

  it("returns null for empty / invalid identity", () => {
    const storage = memoryStorage();
    expect(loadCachedEpubLocations("", 42, storage)).toBeNull();
    expect(loadCachedEpubLocations("/books/foo.epub", 0, storage)).toBeNull();
    expect(loadCachedEpubLocations("/books/foo.epub", Number.NaN, storage)).toBeNull();
    expect(
      loadCachedEpubLocations("/books/foo.epub", Number.POSITIVE_INFINITY, storage),
    ).toBeNull();
  });

  it("returns null when storage access throws", () => {
    const throwing: LocationsStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        // unused
      },
    };
    expect(loadCachedEpubLocations("/books/foo.epub", 42, throwing)).toBeNull();
  });

  it("returns null when no storage is available", () => {
    expect(loadCachedEpubLocations("/books/foo.epub", 42, null)).toBeNull();
  });
});

describe("saveCachedEpubLocations", () => {
  it("writes the serialization at the canonical key", () => {
    const storage = memoryStorage();
    saveCachedEpubLocations("/books/foo.epub", 42, '["cfi:1"]', storage);
    expect(storage.store.get(epubLocationsStorageKey("/books/foo.epub", 42))).toBe('["cfi:1"]');
  });

  it("skips writes for empty / invalid input", () => {
    const storage = memoryStorage();
    saveCachedEpubLocations("", 42, "x", storage);
    saveCachedEpubLocations("/books/foo.epub", 0, "x", storage);
    saveCachedEpubLocations("/books/foo.epub", 42, "", storage);
    expect(storage.store.size).toBe(0);
  });

  it("swallows storage errors", () => {
    const setItem = vi.fn<(key: string, value: string) => void>(() => {
      throw new Error("quota");
    });
    const failing: LocationsStorage = {
      getItem: () => null,
      setItem,
    };
    expect(() => saveCachedEpubLocations("/books/foo.epub", 42, "[]", failing)).not.toThrow();
    expect(setItem).toHaveBeenCalledOnce();
  });
});
