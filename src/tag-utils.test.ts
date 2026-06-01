import { describe, expect, it } from "vitest";
import { countBooksWithTagOrDescendants, validateTagValue } from "./tag-utils";

describe("validateTagValue", () => {
  it("accepts non-empty plain and hierarchical tags", () => {
    expect(validateTagValue("tech")).toEqual({ ok: true, value: "tech" });
    expect(validateTagValue(" language/lean ")).toEqual({
      ok: true,
      value: "language/lean",
    });
  });

  it("rejects empty tag values", () => {
    expect(validateTagValue("")).toEqual({
      ok: false,
      message: "Tags cannot be empty.",
    });
    expect(validateTagValue("   ")).toEqual({
      ok: false,
      message: "Tags cannot be empty.",
    });
  });

  it("rejects invalid slash placement", () => {
    const expected = {
      ok: false as const,
      message: "Tags cannot start or end with '/', be just '/', or contain '//'.",
    };

    expect(validateTagValue("/")).toEqual(expected);
    expect(validateTagValue("/foo")).toEqual(expected);
    expect(validateTagValue("foo/")).toEqual(expected);
    expect(validateTagValue("foo//bar")).toEqual(expected);
  });
});

describe("countBooksWithTagOrDescendants", () => {
  const books = [
    { filePath: "/a.pdf", tags: ["tech", "tech/rust"] },
    { filePath: "/b.pdf", tags: ["tech/rust"] },
    { filePath: "/c.pdf", tags: ["technology"] },
    { filePath: "/d.pdf", tags: ["language/lean", "tech"] },
    { filePath: "/e.pdf" },
  ];

  it("counts the tag itself and its descendants without prefix-only false matches", () => {
    const stats = countBooksWithTagOrDescendants(books, "tech");
    // /c.pdf "technology" must NOT match "tech" — only exact or "tech/..."
    expect(stats.bookCount).toBe(3);
    expect(stats.affectedTags).toEqual(["tech", "tech/rust"]);
  });

  it("counts a descendant tag in isolation", () => {
    const stats = countBooksWithTagOrDescendants(books, "tech/rust");
    expect(stats.bookCount).toBe(2);
    expect(stats.affectedTags).toEqual(["tech/rust"]);
  });

  it("deduplicates books that carry multiple matching tags", () => {
    // /a.pdf carries both "tech" and "tech/rust"; it must contribute 1, not 2.
    const stats = countBooksWithTagOrDescendants(
      [{ filePath: "/a.pdf", tags: ["tech", "tech/rust", "tech/go"] }],
      "tech",
    );
    expect(stats.bookCount).toBe(1);
    expect(stats.affectedTags).toEqual(["tech", "tech/go", "tech/rust"]);
  });

  it("returns empty stats for an unknown tag", () => {
    expect(countBooksWithTagOrDescendants(books, "missing")).toEqual({
      bookCount: 0,
      affectedTags: [],
    });
  });

  it("handles books without a tags array", () => {
    const stats = countBooksWithTagOrDescendants([{ filePath: "/x.pdf" }], "tech");
    expect(stats).toEqual({ bookCount: 0, affectedTags: [] });
  });
});
