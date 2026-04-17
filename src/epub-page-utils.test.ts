import { describe, expect, it } from "vitest";
import {
  clampEpubPageNumber,
  epubLocationIndexFromPageNumber,
  epubPageNumberFromLocation,
} from "./epub-page-utils";

describe("clampEpubPageNumber", () => {
  it("keeps values inside the known page range", () => {
    expect(clampEpubPageNumber(3, 10)).toBe(3);
    expect(clampEpubPageNumber(0, 10)).toBe(1);
    expect(clampEpubPageNumber(18, 10)).toBe(10);
  });
});

describe("epubLocationIndexFromPageNumber", () => {
  it("converts a one-based page number to a zero-based location index", () => {
    expect(epubLocationIndexFromPageNumber(1, 10)).toBe(0);
    expect(epubLocationIndexFromPageNumber(5, 10)).toBe(4);
  });
});

describe("epubPageNumberFromLocation", () => {
  it("converts a zero-based location index back to a one-based page number", () => {
    expect(epubPageNumberFromLocation(0, 10)).toBe(1);
    expect(epubPageNumberFromLocation(4, 10)).toBe(5);
  });

  it("falls back to the first page when the location is missing", () => {
    expect(epubPageNumberFromLocation(null, 10)).toBe(1);
  });
});
