import { describe, expect, test } from "vitest";
import {
  addLibraryRoot,
  buildAppConfigDraft,
  parseExcludedPatternsInput,
} from "./app-config-utils";

describe("parseExcludedPatternsInput", () => {
  test("splits lines and trims blank entries", () => {
    expect(parseExcludedPatternsInput("  *.bak.pdf \n\n prefix_*\n")).toEqual([
      "*.bak.pdf",
      "prefix_*",
    ]);
  });
});

describe("addLibraryRoot", () => {
  test("deduplicates roots while preserving order", () => {
    expect(addLibraryRoot(["~/Books", "/tmp/library"], "~/Books")).toEqual([
      "~/Books",
      "/tmp/library",
    ]);
  });

  test("appends a new root", () => {
    expect(addLibraryRoot(["~/Books"], "/tmp/library")).toEqual(["~/Books", "/tmp/library"]);
  });
});

describe("buildAppConfigDraft", () => {
  test("builds a normalized draft from form values", () => {
    expect(buildAppConfigDraft(["~/Books"], " *.bak.pdf \n prefix_*\n", "pdfjs")).toEqual({
      libraryRoots: ["~/Books"],
      excludedPatterns: ["*.bak.pdf", "prefix_*"],
      pdfRenderer: "pdfjs",
    });
  });

  test("falls back to native renderer for unknown values", () => {
    expect(buildAppConfigDraft([], "", "unexpected")).toEqual({
      libraryRoots: [],
      excludedPatterns: [],
      pdfRenderer: "native",
    });
  });
});
