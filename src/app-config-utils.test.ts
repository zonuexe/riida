import { describe, expect, test } from "vitest";
import {
  addLibraryRoot,
  buildAppConfigDraft,
  normalizeAppTheme,
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
    expect(
      buildAppConfigDraft(["~/Books"], " *.bak.pdf \n prefix_*\n", "pdfjs", "night-city", [
        "kindle",
      ]),
    ).toEqual({
      libraryRoots: ["~/Books"],
      excludedPatterns: ["*.bak.pdf", "prefix_*"],
      pdfRenderer: "pdfjs",
      theme: "night-city",
      enabledExternalSources: ["kindle"],
    });
  });

  test("falls back to defaults for unknown values", () => {
    expect(buildAppConfigDraft([], "", "unexpected", "unexpected", [])).toEqual({
      libraryRoots: [],
      excludedPatterns: [],
      pdfRenderer: "native",
      theme: "default",
      enabledExternalSources: [],
    });
  });
});

describe("normalizeAppTheme", () => {
  test("accepts supported theme ids", () => {
    expect(normalizeAppTheme("navy-blue")).toBe("navy-blue");
  });

  test("falls back to default for unknown values", () => {
    expect(normalizeAppTheme("sepia")).toBe("default");
  });
});
