import { describe, expect, test } from "vitest";
import {
  applyBookMetadataImport,
  BOOK_METADATA_IMPORT_EXAMPLE,
  isValidMetadataReleaseDate,
  joinMetadataAuthors,
  normalizeMetadataAuthorsText,
  parseBookMetadataImport,
  validateBookMetadataDraft,
} from "./book-metadata-utils";

describe("normalizeMetadataAuthorsText", () => {
  test("splits lines, trims values, and drops duplicates", () => {
    expect(normalizeMetadataAuthorsText(" Alice \nBob\n\nAlice\nCarol ")).toEqual([
      "Alice",
      "Bob",
      "Carol",
    ]);
  });
});

describe("joinMetadataAuthors", () => {
  test("joins authors using newlines", () => {
    expect(joinMetadataAuthors(["Alice", "Bob"])).toBe("Alice\nBob");
  });
});

describe("isValidMetadataReleaseDate", () => {
  test("accepts an empty value", () => {
    expect(isValidMetadataReleaseDate("")).toBe(true);
  });

  test("accepts a valid date", () => {
    expect(isValidMetadataReleaseDate("2026-04-04")).toBe(true);
  });

  test("rejects invalid formats and invalid calendar dates", () => {
    expect(isValidMetadataReleaseDate("2026/04/04")).toBe(false);
    expect(isValidMetadataReleaseDate("2026-02-29")).toBe(false);
    expect(isValidMetadataReleaseDate("2024-02-29")).toBe(true);
    expect(isValidMetadataReleaseDate("2026-13-01")).toBe(false);
    expect(isValidMetadataReleaseDate("2026-04-31")).toBe(false);
  });
});

describe("validateBookMetadataDraft", () => {
  test("returns a clear error for invalid release dates", () => {
    expect(
      validateBookMetadataDraft({
        title: "",
        authorsText: "",
        description: "",
        publisher: "",
        releaseDate: "2026-02-29",
        language: "",
        url: "",
        asin: "",
      }),
    ).toEqual({
      ok: false,
      message: "Release date must use YYYY-MM-DD.",
    });
  });
});

describe("parseBookMetadataImport", () => {
  test("accepts the example object", () => {
    const result = parseBookMetadataImport(BOOK_METADATA_IMPORT_EXAMPLE);
    expect(result.ok).toBe(true);
  });

  test("rejects invalid JSON and invalid field types", () => {
    expect(parseBookMetadataImport("{").ok).toBe(false);
    expect(parseBookMetadataImport(JSON.stringify({ authors: "Alice" }))).toEqual({
      ok: false,
      message: '"authors" must be an array of strings or null.',
    });
  });
});

describe("applyBookMetadataImport", () => {
  test("keeps missing keys unchanged and clears null values", () => {
    expect(
      applyBookMetadataImport(
        {
          title: "Old title",
          authorsText: "Alice\nBob",
          description: "Old description",
          publisher: "Old publisher",
          releaseDate: "2026-04-04",
          language: "ja",
          url: "https://example.com/old",
          asin: "OLDASIN",
        },
        {
          title: "New title",
          authors: null,
          publisher: "New publisher",
        },
      ),
    ).toEqual({
      title: "New title",
      authorsText: "",
      description: "Old description",
      publisher: "New publisher",
      releaseDate: "2026-04-04",
      language: "ja",
      url: "https://example.com/old",
      asin: "OLDASIN",
    });
  });

  test("normalizes imported authors", () => {
    expect(
      applyBookMetadataImport(
        {
          title: "",
          authorsText: "",
          description: "",
          publisher: "",
          releaseDate: "",
          language: "",
          url: "",
          asin: "",
        },
        {
          authors: [" Alice ", "Bob", "Alice"],
        },
      ).authorsText,
    ).toBe("Alice\nBob");
  });
});
