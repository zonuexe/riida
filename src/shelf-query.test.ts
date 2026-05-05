import { describe, expect, it } from "vitest";
import { composeShelfQuery, decomposeShelfQuery } from "./shelf-query.ts";

describe("composeShelfQuery", () => {
  it("returns empty string when no usable rows", () => {
    expect(composeShelfQuery("all", [])).toBe("");
    expect(composeShelfQuery("any", [{ field: "title", negate: false, value: "  " }])).toBe("");
  });

  it("renders a single field row without operator", () => {
    expect(composeShelfQuery("all", [{ field: "title", negate: false, value: "rust" }])).toBe(
      "title:rust",
    );
  });

  it("renders a negated single row with leading dash", () => {
    expect(composeShelfQuery("all", [{ field: "tag", negate: true, value: "done" }])).toBe(
      "-tag:done",
    );
  });

  it("joins multiple All rows with AND", () => {
    expect(
      composeShelfQuery("all", [
        { field: "title", negate: false, value: "rust" },
        { field: "tag", negate: true, value: "done" },
      ]),
    ).toBe("title:rust AND -tag:done");
  });

  it("joins multiple Any rows with OR", () => {
    expect(
      composeShelfQuery("any", [
        { field: "tag", negate: false, value: "rust" },
        { field: "tag", negate: false, value: "go" },
      ]),
    ).toBe("tag:rust OR tag:go");
  });

  it("quotes values containing whitespace", () => {
    expect(
      composeShelfQuery("all", [{ field: "author", negate: false, value: "Robert Martin" }]),
    ).toBe('author:"Robert Martin"');
  });

  it("renders free-text rows without a field prefix", () => {
    expect(composeShelfQuery("all", [{ field: "free", negate: false, value: "rust" }])).toBe(
      "rust",
    );
  });
});

describe("decomposeShelfQuery", () => {
  it("returns empty rows for empty input", () => {
    expect(decomposeShelfQuery("")).toEqual({ mode: "all", rows: [] });
    expect(decomposeShelfQuery("   ")).toEqual({ mode: "all", rows: [] });
  });

  it("recognises a single field token", () => {
    expect(decomposeShelfQuery("title:rust")).toEqual({
      mode: "all",
      rows: [{ field: "title", negate: false, value: "rust" }],
    });
  });

  it("recognises a flat AND of simple terms", () => {
    expect(decomposeShelfQuery("title:rust -tag:done")).toEqual({
      mode: "all",
      rows: [
        { field: "title", negate: false, value: "rust" },
        { field: "tag", negate: true, value: "done" },
      ],
    });
  });

  it("recognises a flat OR of simple terms", () => {
    expect(decomposeShelfQuery("tag:rust OR tag:go")).toEqual({
      mode: "any",
      rows: [
        { field: "tag", negate: false, value: "rust" },
        { field: "tag", negate: false, value: "go" },
      ],
    });
  });

  it("recognises free-text rows", () => {
    expect(decomposeShelfQuery("rust OR go")).toEqual({
      mode: "any",
      rows: [
        { field: "free", negate: false, value: "rust" },
        { field: "free", negate: false, value: "go" },
      ],
    });
  });

  it("falls back to null for grouped or mixed queries", () => {
    expect(decomposeShelfQuery("(tag:rust OR tag:go) -tag:done")).toBeNull();
  });

  it("falls back to null when read: field is used (not yet structured)", () => {
    expect(decomposeShelfQuery("read:week")).toBeNull();
  });

  it("round-trips compose → decompose", () => {
    const rows = [
      { field: "title" as const, negate: false, value: "rust" },
      { field: "tag" as const, negate: true, value: "done" },
    ];
    const composed = composeShelfQuery("all", rows);
    expect(decomposeShelfQuery(composed)).toEqual({ mode: "all", rows });
  });
});
