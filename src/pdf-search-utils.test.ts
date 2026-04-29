import { describe, expect, test } from "vitest";
import fc from "fast-check";
import {
  buildPdfSearchPageIndex,
  findPdfSearchMatchesInPage,
  pickInitialMatchIndex,
  searchNormalize,
} from "./pdf-search-utils.ts";

describe("searchNormalize", () => {
  test("strips diacritics", () => {
    expect(searchNormalize("Café")).toBe("cafe");
    expect(searchNormalize("naïve")).toBe("naive");
  });

  test("normalizes half-width katakana to full-width via NFKC", () => {
    expect(searchNormalize("ｱｲｳ")).toBe("アイウ");
  });

  test("lower-cases ASCII", () => {
    expect(searchNormalize("Hello")).toBe("hello");
  });

  test("returns empty for empty input", () => {
    expect(searchNormalize("")).toBe("");
  });

  test("is idempotent on already-normalized strings", () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const once = searchNormalize(raw);
        return searchNormalize(once) === once;
      }),
    );
    expect(true).toBe(true);
  });
});

describe("buildPdfSearchPageIndex", () => {
  test("normalizedText length equals normChars length", () => {
    fc.assert(
      fc.property(fc.array(fc.record({ str: fc.string() })), (items) => {
        const index = buildPdfSearchPageIndex(items);
        return index.normalizedText.length === index.normChars.length;
      }),
    );
    expect(true).toBe(true);
  });

  test("itemIndex of every normChar points to a real item", () => {
    fc.assert(
      fc.property(fc.array(fc.record({ str: fc.string() })), (items) => {
        const index = buildPdfSearchPageIndex(items);
        return index.normChars.every((nc) => nc.itemIndex >= 0 && nc.itemIndex < items.length);
      }),
    );
    expect(true).toBe(true);
  });

  test("origOffset never exceeds origOffsetEnd", () => {
    fc.assert(
      fc.property(fc.array(fc.record({ str: fc.string() })), (items) => {
        const index = buildPdfSearchPageIndex(items);
        return index.normChars.every((nc) => nc.origOffset <= nc.origOffsetEnd);
      }),
    );
    expect(true).toBe(true);
  });

  test("empty items produce an empty index", () => {
    expect(buildPdfSearchPageIndex([])).toEqual({ normalizedText: "", normChars: [] });
  });

  test("ASCII items yield matching normalized text", () => {
    const index = buildPdfSearchPageIndex([{ str: "Hello" }, { str: " World" }]);
    expect(index.normalizedText).toBe("hello world");
    expect(index.normChars).toHaveLength("hello world".length);
  });
});

describe("findPdfSearchMatchesInPage", () => {
  test("returns no matches for empty query", () => {
    expect(findPdfSearchMatchesInPage("hello world", "", 1)).toEqual([]);
  });

  test("finds a single occurrence", () => {
    const matches = findPdfSearchMatchesInPage("hello world", "world", 3);
    expect(matches).toEqual([{ pageNumber: 3, normalizedStart: 6, normalizedEnd: 11 }]);
  });

  test("finds overlapping occurrences", () => {
    const matches = findPdfSearchMatchesInPage("aaaa", "aa", 1);
    expect(matches.map((m) => m.normalizedStart)).toEqual([0, 1, 2]);
  });

  test("every reported position contains the query", () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.string({ minLength: 1, maxLength: 5 }),
        fc.integer(),
        (text, q, p) => {
          const matches = findPdfSearchMatchesInPage(text, q, p);
          return matches.every(
            (m) => text.slice(m.normalizedStart, m.normalizedEnd) === q && m.pageNumber === p,
          );
        },
      ),
    );
    expect(true).toBe(true);
  });
});

describe("pickInitialMatchIndex", () => {
  const matches = [
    { pageNumber: 1, normalizedStart: 0, normalizedEnd: 1 },
    { pageNumber: 5, normalizedStart: 0, normalizedEnd: 1 },
    { pageNumber: 9, normalizedStart: 0, normalizedEnd: 1 },
  ];

  test("returns -1 for empty matches", () => {
    expect(pickInitialMatchIndex([], 5)).toBe(-1);
  });

  test("returns the first match at or after current page", () => {
    expect(pickInitialMatchIndex(matches, 1)).toBe(0);
    expect(pickInitialMatchIndex(matches, 4)).toBe(1);
    expect(pickInitialMatchIndex(matches, 5)).toBe(1);
    expect(pickInitialMatchIndex(matches, 9)).toBe(2);
  });

  test("falls back to the first match when current page is past the last match", () => {
    expect(pickInitialMatchIndex(matches, 100)).toBe(0);
  });
});
