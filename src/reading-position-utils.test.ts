import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import {
  clampReadingPositionOffsetRatio,
  computePageOffsetRatio,
  loadCachedReadingPosition,
  parseCachedReadingPosition,
  readingPositionStorageKey,
  saveCachedReadingPosition,
  selectAnchorPageIndex,
  selectHeadSidePageInSpread,
  type ReadingPositionLike,
  type ReadingPositionStorage,
} from "./reading-position-utils";

function memoryStorage(): ReadingPositionStorage & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    getItem: (key: string) => (store.has(key) ? (store.get(key) ?? null) : null),
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  };
}

describe("readingPositionStorageKey", () => {
  it("namespaces the file path", () => {
    expect(readingPositionStorageKey("/Books/Rust.pdf")).toBe(
      "riida:reading-position:/Books/Rust.pdf",
    );
  });
});

describe("clampReadingPositionOffsetRatio", () => {
  it("clamps values into the 0..1 range", () => {
    expect(clampReadingPositionOffsetRatio(-0.5)).toBe(0);
    expect(clampReadingPositionOffsetRatio(0.25)).toBe(0.25);
    expect(clampReadingPositionOffsetRatio(1.5)).toBe(1);
  });
});

describe("parseCachedReadingPosition", () => {
  it("returns null for empty or invalid JSON", () => {
    expect(parseCachedReadingPosition(null)).toBeNull();
    expect(parseCachedReadingPosition("not json")).toBeNull();
  });

  it("returns null for incomplete payloads", () => {
    expect(parseCachedReadingPosition(JSON.stringify({ filePath: "/Books/Rust.pdf" }))).toBeNull();
  });

  it("parses a valid payload and clamps the offset ratio", () => {
    expect(
      parseCachedReadingPosition(
        JSON.stringify({
          filePath: "/Books/Rust.pdf",
          pageNumber: 12,
          pageOffsetRatio: 1.4,
          updatedAt: 123,
        }),
      ),
    ).toEqual({
      filePath: "/Books/Rust.pdf",
      pageNumber: 12,
      pageOffsetRatio: 1,
      cfi: null,
      updatedAt: 123,
    });
  });
});

describe("selectAnchorPageIndex", () => {
  it("returns -1 for an empty page list", () => {
    expect(selectAnchorPageIndex([], 0)).toBe(-1);
  });

  it("returns the last index whose top is at or above the anchor line", () => {
    const tops = [0, 1000, 2000, 3000];
    expect(selectAnchorPageIndex(tops, 0)).toBe(0);
    expect(selectAnchorPageIndex(tops, 999)).toBe(0);
    expect(selectAnchorPageIndex(tops, 1000)).toBe(1);
    expect(selectAnchorPageIndex(tops, 2500)).toBe(2);
    expect(selectAnchorPageIndex(tops, 5000)).toBe(3);
  });

  it("returns the first index when the anchor line is above all pages", () => {
    expect(selectAnchorPageIndex([100, 200, 300], 50)).toBe(0);
  });

  it("never returns an index outside [0, length-1] for non-empty input", () => {
    fc.assert(
      fc.property(
        fc
          .array(fc.integer({ min: 0, max: 100_000 }), { minLength: 1, maxLength: 50 })
          .map((arr) => [...arr].sort((a, b) => a - b)),
        fc.integer({ min: -10_000, max: 200_000 }),
        (tops, anchor) => {
          const idx = selectAnchorPageIndex(tops, anchor);
          return idx >= 0 && idx < tops.length;
        },
      ),
    );
    expect(true).toBe(true);
  });
});

describe("computePageOffsetRatio", () => {
  it("returns 0 at the page's top edge", () => {
    expect(computePageOffsetRatio(1000, 1000, 800)).toBe(0);
  });

  it("returns 1 at the page's bottom edge", () => {
    expect(computePageOffsetRatio(1800, 1000, 800)).toBe(1);
  });

  it("clamps below 0 to 0 and above 1 to 1", () => {
    expect(computePageOffsetRatio(500, 1000, 800)).toBe(0);
    expect(computePageOffsetRatio(5000, 1000, 800)).toBe(1);
  });

  it("treats zero or negative pageHeight as 1 to avoid divide-by-zero", () => {
    expect(computePageOffsetRatio(0, 0, 0)).toBe(0);
    expect(computePageOffsetRatio(0, 0, -1)).toBe(0);
  });

  it("always returns a value in [0, 1]", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -10_000, max: 100_000 }),
        fc.integer({ min: 0, max: 100_000 }),
        fc.integer({ min: -100, max: 5000 }),
        (scrollTop, anchorTop, pageHeight) => {
          const r = computePageOffsetRatio(scrollTop, anchorTop, pageHeight);
          return r >= 0 && r <= 1;
        },
      ),
    );
    expect(true).toBe(true);
  });
});

const sampleReadingPosition: ReadingPositionLike = {
  filePath: "/Books/Rust.pdf",
  pageNumber: 12,
  pageOffsetRatio: 0.5,
  cfi: null,
  updatedAt: 1700_000_000,
};

describe("loadCachedReadingPosition", () => {
  it("returns the parsed position from storage", () => {
    const storage = memoryStorage();
    storage.store.set(
      readingPositionStorageKey(sampleReadingPosition.filePath),
      JSON.stringify(sampleReadingPosition),
    );
    expect(loadCachedReadingPosition(sampleReadingPosition.filePath, storage)).toEqual(
      sampleReadingPosition,
    );
  });

  it("returns null for an empty file path", () => {
    expect(loadCachedReadingPosition("", memoryStorage())).toBeNull();
  });

  it("returns null when no storage is available", () => {
    expect(loadCachedReadingPosition("/x.pdf", null)).toBeNull();
  });

  it("returns null when storage access throws", () => {
    const throwing: ReadingPositionStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        // unused
      },
    };
    expect(loadCachedReadingPosition("/x.pdf", throwing)).toBeNull();
  });

  it("returns null when the stored payload is malformed", () => {
    const storage = memoryStorage();
    storage.store.set(readingPositionStorageKey("/x.pdf"), "not json");
    expect(loadCachedReadingPosition("/x.pdf", storage)).toBeNull();
  });
});

describe("saveCachedReadingPosition", () => {
  it("serializes the position into storage under the canonical key", () => {
    const storage = memoryStorage();
    saveCachedReadingPosition(sampleReadingPosition, storage);
    const raw = storage.store.get(readingPositionStorageKey(sampleReadingPosition.filePath));
    expect(raw).toBeTypeOf("string");
    expect(JSON.parse(raw!)).toEqual(sampleReadingPosition);
  });

  it("skips writes for positions without a file path", () => {
    const storage = memoryStorage();
    saveCachedReadingPosition({ ...sampleReadingPosition, filePath: "" }, storage);
    expect(storage.store.size).toBe(0);
  });

  it("is a no-op when no storage is available", () => {
    expect(() => saveCachedReadingPosition(sampleReadingPosition, null)).not.toThrow();
  });

  it("swallows storage errors", () => {
    const setItem = vi.fn<(key: string, value: string) => void>(() => {
      throw new Error("quota");
    });
    expect(() =>
      saveCachedReadingPosition(sampleReadingPosition, { getItem: () => null, setItem }),
    ).not.toThrow();
    expect(setItem).toHaveBeenCalledOnce();
  });
});

describe("selectHeadSidePageInSpread", () => {
  it("returns the anchor when no candidate shares its offsetTop", () => {
    const anchor = { pageNumber: 5, offsetTop: 1000 };
    const candidates = [
      { pageNumber: 4, offsetTop: 800 },
      { pageNumber: 6, offsetTop: 1200 },
    ];
    expect(selectHeadSidePageInSpread(anchor, candidates)).toBe(anchor);
  });

  it("picks the smallest page number among entries sharing offsetTop", () => {
    const anchor = { pageNumber: 7, offsetTop: 1000 };
    const candidates = [
      { pageNumber: 6, offsetTop: 1000 },
      { pageNumber: 7, offsetTop: 1000 },
      { pageNumber: 8, offsetTop: 1200 },
    ];
    expect(selectHeadSidePageInSpread(anchor, candidates).pageNumber).toBe(6);
  });

  it("ignores non-positive page numbers", () => {
    const anchor = { pageNumber: 3, offsetTop: 500 };
    const candidates = [
      { pageNumber: 0, offsetTop: 500 },
      { pageNumber: -1, offsetTop: 500 },
      { pageNumber: 2, offsetTop: 500 },
    ];
    expect(selectHeadSidePageInSpread(anchor, candidates).pageNumber).toBe(2);
  });

  it("returns the anchor unchanged when candidates is empty", () => {
    const anchor = { pageNumber: 4, offsetTop: 200 };
    expect(selectHeadSidePageInSpread(anchor, [])).toBe(anchor);
  });
});
