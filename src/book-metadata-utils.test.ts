import { describe, expect, test } from "vitest";
import {
  isValidMetadataReleaseDate,
  joinMetadataAuthors,
  normalizeMetadataAuthorsText,
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
