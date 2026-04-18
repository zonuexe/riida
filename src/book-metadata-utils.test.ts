import { describe, expect, test } from "vitest";
import {
  applyBookMetadataImport,
  BOOK_METADATA_IMPORT_EXAMPLE,
  isBookMetadataDraftEmpty,
  isValidMetadataReleaseDate,
  joinMetadataAuthors,
  normalizeMetadataAuthorsText,
  normalizeReleaseDateInput,
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

describe("normalizeReleaseDateInput", () => {
  test("returns empty string unchanged", () => {
    expect(normalizeReleaseDateInput("")).toBe("");
    expect(normalizeReleaseDateInput("  ")).toBe("");
  });

  test("trims whitespace around a valid YYYY-MM-DD value", () => {
    expect(normalizeReleaseDateInput("  2020-08-10  ")).toBe("2020-08-10");
  });

  test("leaves already-valid YYYY-MM-DD unchanged", () => {
    expect(normalizeReleaseDateInput("2020-08-10")).toBe("2020-08-10");
  });

  test("converts Japanese date format", () => {
    expect(normalizeReleaseDateInput("2020年8月10日")).toBe("2020-08-10");
    expect(normalizeReleaseDateInput("2020年08月10日")).toBe("2020-08-10");
    expect(normalizeReleaseDateInput("2020年8月10")).toBe("2020-08-10");
  });

  test("converts slash-separated date", () => {
    expect(normalizeReleaseDateInput("2020/8/10")).toBe("2020-08-10");
    expect(normalizeReleaseDateInput("2020/08/10")).toBe("2020-08-10");
  });

  test("converts dot-separated date", () => {
    expect(normalizeReleaseDateInput("2020.08.10")).toBe("2020-08-10");
  });

  test("falls back to Date.parse for other recognizable formats", () => {
    expect(normalizeReleaseDateInput("Aug 10, 2020")).toBe("2020-08-10");
    expect(normalizeReleaseDateInput("2020-08-10T00:00:00Z")).toBe("2020-08-10");
  });

  test("returns unrecognized input trimmed but otherwise unchanged", () => {
    expect(normalizeReleaseDateInput("  hello  ")).toBe("hello");
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
        coverUrl: "",
      }),
    ).toEqual({
      ok: false,
      message: "Release date must use YYYY-MM-DD.",
    });
  });
});

describe("isBookMetadataDraftEmpty", () => {
  test("treats blank metadata as empty", () => {
    expect(
      isBookMetadataDraftEmpty({
        title: "",
        authorsText: " \n ",
        description: "",
        publisher: "",
        releaseDate: "",
        language: "",
        url: "",
        asin: "",
        coverUrl: "",
      }),
    ).toBe(true);
  });

  test("detects non-empty metadata fields", () => {
    expect(
      isBookMetadataDraftEmpty({
        title: "",
        authorsText: "",
        description: "",
        publisher: "",
        releaseDate: "",
        language: "",
        url: "",
        asin: "B012345678",
        coverUrl: "",
      }),
    ).toBe(false);
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
          coverUrl: "https://example.com/old.jpg",
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
      coverUrl: "https://example.com/old.jpg",
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
          coverUrl: "",
        },
        {
          authors: [" Alice ", "Bob", "Alice"],
        },
      ).authorsText,
    ).toBe("Alice\nBob");
  });
});
