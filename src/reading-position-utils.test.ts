import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  clampReadingPositionOffsetRatio,
  computePageOffsetRatio,
  parseCachedReadingPosition,
  readingPositionStorageKey,
  selectAnchorPageIndex,
} from "./reading-position-utils";

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
