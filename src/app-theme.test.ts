import { describe, expect, it, vi } from "vitest";
import type { AppTheme } from "./app-config-utils";
import {
  APP_THEME_STORAGE_KEY,
  applyAppTheme,
  isDarkAppTheme,
  loadPersistedAppTheme,
  persistAppTheme,
  type ThemeStorage,
} from "./app-theme";

function memoryStorage(): ThemeStorage & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    getItem: (key: string) => (store.has(key) ? (store.get(key) ?? null) : null),
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  };
}

function fakeRoot(): HTMLElement {
  const dataset: Record<string, string | undefined> = {};
  const style: { colorScheme: string } = { colorScheme: "" };
  return {
    dataset,
    style,
  } as unknown as HTMLElement;
}

describe("APP_THEME_STORAGE_KEY", () => {
  it("matches the literal used by the inline early-theme script", () => {
    // Must stay in sync with the inline script in index.html / viewer.html.
    expect(APP_THEME_STORAGE_KEY).toBe("riida.appTheme");
  });
});

describe("isDarkAppTheme", () => {
  it("returns true for the dark themes", () => {
    expect(isDarkAppTheme("night-city")).toBe(true);
    expect(isDarkAppTheme("navy-blue")).toBe(true);
  });

  it("returns false for the light themes", () => {
    expect(isDarkAppTheme("default")).toBe(false);
    expect(isDarkAppTheme("snow-white")).toBe(false);
  });
});

describe("applyAppTheme", () => {
  it("sets dataset.theme and colorScheme on the provided root", () => {
    const root = fakeRoot();
    applyAppTheme("navy-blue", root);
    expect(root.dataset.theme).toBe("navy-blue");
    expect(root.style.colorScheme).toBe("dark");
  });

  it("uses light colorScheme for the light themes", () => {
    const root = fakeRoot();
    applyAppTheme("snow-white", root);
    expect(root.dataset.theme).toBe("snow-white");
    expect(root.style.colorScheme).toBe("light");
  });

  it("is a no-op when no root is available", () => {
    expect(() => applyAppTheme("default", null)).not.toThrow();
  });
});

describe("persistAppTheme", () => {
  it("writes the theme to storage under the canonical key", () => {
    const storage = memoryStorage();
    persistAppTheme("night-city", storage);
    expect(storage.store.get(APP_THEME_STORAGE_KEY)).toBe("night-city");
  });

  it("is a no-op when storage is unavailable", () => {
    expect(() => persistAppTheme("default", null)).not.toThrow();
  });

  it("swallows storage errors", () => {
    const setItem = vi.fn<(key: string, value: string) => void>(() => {
      throw new Error("quota");
    });
    expect(() => persistAppTheme("default", { getItem: () => null, setItem })).not.toThrow();
    expect(setItem).toHaveBeenCalledOnce();
  });
});

describe("loadPersistedAppTheme", () => {
  it("returns the stored theme normalized", () => {
    const storage = memoryStorage();
    storage.store.set(APP_THEME_STORAGE_KEY, "navy-blue");
    expect(loadPersistedAppTheme(storage)).toBe<AppTheme>("navy-blue");
  });

  it("normalizes unknown stored values to 'default'", () => {
    const storage = memoryStorage();
    storage.store.set(APP_THEME_STORAGE_KEY, "mystery");
    expect(loadPersistedAppTheme(storage)).toBe<AppTheme>("default");
  });

  it("returns null when nothing is stored", () => {
    expect(loadPersistedAppTheme(memoryStorage())).toBeNull();
  });

  it("returns null when storage is unavailable", () => {
    expect(loadPersistedAppTheme(null)).toBeNull();
  });

  it("returns null when storage access throws", () => {
    const throwing: ThemeStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        // unused
      },
    };
    expect(loadPersistedAppTheme(throwing)).toBeNull();
  });
});
