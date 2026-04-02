import { describe, expect, it } from "vitest";
import { suggestTagCompletions } from "./tag-suggestions";

describe("suggestTagCompletions", () => {
  const existingTags = [
    "language",
    "language/lean",
    "language/rust",
    "math/lean",
    "type",
    "programming/type",
  ];

  it("matches prefixes, infixes, and suffixes", () => {
    expect(suggestTagCompletions(existingTags, "lean", [])).toEqual(["math/lean", "language/lean"]);
    expect(suggestTagCompletions(existingTags, "type", [])).toEqual(["type", "programming/type"]);
    expect(suggestTagCompletions(existingTags, "rust", [])).toEqual(["language/rust"]);
  });

  it("excludes already selected tags", () => {
    expect(suggestTagCompletions(existingTags, "lean", ["language/lean"])).toEqual(["math/lean"]);
  });

  it("returns empty suggestions for a blank query", () => {
    expect(suggestTagCompletions(existingTags, "   ", [])).toEqual([]);
  });
});
