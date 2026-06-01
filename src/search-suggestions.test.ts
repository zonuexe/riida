import { describe, expect, it } from "vitest";
import { applySuggestion, buildValueSource, computeSuggestions } from "./search-suggestions";

describe("buildValueSource", () => {
  it("collects, dedupes, and sorts values across books", () => {
    const source = buildValueSource([
      {
        publisher: "Packt",
        authors: ["Bob", "Alice"],
        language: "en",
        tags: ["tech"],
        sourceType: "pdf",
      },
      {
        publisher: "O Reilly",
        authors: ["Alice"],
        language: "ja",
        tags: ["tech", "fiction"],
        sourceType: "kindle",
      },
    ]);

    expect(source.publisher).toEqual(["O Reilly", "Packt"]);
    expect(source.author).toEqual(["Alice", "Bob"]);
    expect(source.lang).toEqual(["en", "ja"]);
    expect(source.tag).toEqual(["fiction", "tech"]);
    expect(source.source).toEqual(["kindle", "pdf"]);
  });

  it("ignores null, undefined, and missing fields", () => {
    const source = buildValueSource([
      { publisher: null, language: undefined },
      { authors: undefined, tags: undefined },
      {},
    ]);

    expect(source).toEqual({ publisher: [], author: [], lang: [], tag: [], source: [] });
  });
});

const EMPTY_SOURCE = { publisher: [], author: [], lang: [], tag: [], source: [] };

describe("computeSuggestions — field names", () => {
  it("suggests field names by prefix", () => {
    const suggestions = computeSuggestions("t", 1, EMPTY_SOURCE);
    expect(suggestions).toEqual([
      { kind: "field", completion: "tag:" },
      { kind: "field", completion: "title:" },
    ]);
  });

  it("returns nothing for an empty fragment", () => {
    expect(computeSuggestions("", 0, EMPTY_SOURCE)).toEqual([]);
    expect(computeSuggestions("tag:x ", 6, EMPTY_SOURCE)).toEqual([]);
  });

  it("only considers the token under the cursor", () => {
    // The cursor sits at the end of the second token "au".
    const suggestions = computeSuggestions("title:foo au", 12, EMPTY_SOURCE);
    expect(suggestions).toEqual([{ kind: "field", completion: "author:" }]);
  });
});

describe("computeSuggestions — field values", () => {
  const source = {
    ...EMPTY_SOURCE,
    publisher: ["O Reilly", "Packt"],
    tag: ["fiction", "tech"],
  };

  it("matches known values case- and separator-insensitively", () => {
    // "O Reilly" normalizes to "oreilly", so "or" matches it.
    const suggestions = computeSuggestions("publisher:or", 12, source);
    expect(suggestions).toEqual([{ kind: "value", field: "publisher", completion: "O Reilly" }]);
  });

  it("strips a leading negation before matching values", () => {
    const suggestions = computeSuggestions("-tag:fic", 8, source);
    expect(suggestions).toEqual([{ kind: "value", field: "tag", completion: "fiction" }]);
  });

  it("suggests read: keywords from the fixed set", () => {
    expect(computeSuggestions("read:we", 7, EMPTY_SOURCE)).toEqual([
      { kind: "value", field: "read", completion: "week" },
    ]);
    // An empty value prefix offers every keyword.
    expect(computeSuggestions("read:", 5, EMPTY_SOURCE).map((s) => s.completion)).toEqual([
      "today",
      "week",
      "month",
      "year",
      "never",
    ]);
  });

  it("returns nothing for an unknown field", () => {
    expect(computeSuggestions("bogus:x", 7, source)).toEqual([]);
  });

  it("respects the limit", () => {
    const many = { ...EMPTY_SOURCE, tag: ["t1", "t2", "t3", "t4", "t5"] };
    expect(computeSuggestions("tag:t", 5, many, 2)).toHaveLength(2);
  });
});

describe("applySuggestion", () => {
  it("replaces the fragment with a field completion and moves the cursor", () => {
    expect(applySuggestion("ti", 2, { kind: "field", completion: "title:" })).toEqual({
      value: "title:",
      cursor: 6,
    });
  });

  it("preserves a leading negation when completing a field", () => {
    expect(applySuggestion("-ti", 3, { kind: "field", completion: "title:" })).toEqual({
      value: "-title:",
      cursor: 7,
    });
  });

  it("quotes value completions that contain spaces", () => {
    expect(
      applySuggestion("publisher:o", 11, {
        kind: "value",
        field: "publisher",
        completion: "O Reilly",
      }),
    ).toEqual({ value: 'publisher:"O Reilly"', cursor: 20 });
  });

  it("does not quote single-word value completions", () => {
    expect(
      applySuggestion("publisher:p", 11, {
        kind: "value",
        field: "publisher",
        completion: "Packt",
      }),
    ).toEqual({ value: "publisher:Packt", cursor: 15 });
  });

  it("only rewrites the token under the cursor, leaving the rest intact", () => {
    expect(
      applySuggestion("tag:fi extra", 6, { kind: "value", field: "tag", completion: "fiction" }),
    ).toEqual({ value: "tag:fiction extra", cursor: 11 });
  });
});
