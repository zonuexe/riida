import { describe, expect, it } from "vitest";
import {
  deriveDirectories,
  deriveLanguages,
  derivePublishers,
  deriveSources,
  deriveTags,
  describeEmptyLibraryState,
  filterVisibleBooks,
  formatBookLocation,
  formatFileSize,
  normalizeSearchText,
} from "./library-utils";

describe("formatFileSize", () => {
  it("formats bytes and larger units", () => {
    expect(formatFileSize(999)).toBe("999 B");
    expect(formatFileSize(1024)).toBe("1.0 KB");
    expect(formatFileSize(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("formatBookLocation", () => {
  it("shows the parent directory and collapses the home directory", () => {
    expect(
      formatBookLocation("/Users/example/Dropbox/EBook/BOOKSCAN/title.pdf", "/Users/example"),
    ).toBe("~/Dropbox/EBook/BOOKSCAN");
  });

  it("omits the file name even without a home directory hint", () => {
    expect(formatBookLocation("/Books/Tech/Rust Book.pdf", null)).toBe("/Books/Tech");
  });
});

describe("normalizeSearchText", () => {
  it("normalizes case, width, and separators", () => {
    expect(normalizeSearchText("WEB+DB PRESS")).toBe("web+dbpress");
    expect(normalizeSearchText("ＷＥＢ＿ＤＢ-Press/Vol.1")).toBe("webdbpressvol1");
  });
});

describe("filterVisibleBooks", () => {
  const books = [
    {
      fileName: "WEB+DB-PRESS-Vol.131.pdf",
      filePath: "/Books/Tech/WEB+DB-PRESS-Vol.131.pdf",
      tags: ["magazine", "tech"],
      sourceType: "pdf",
    },
    {
      fileName: "Rust Book.pdf",
      filePath: "/Books/Tech/Rust Book.pdf",
      tags: ["tech"],
      sourceType: "pdf",
    },
    {
      fileName: "Novel.pdf",
      filePath: "/Books/Fiction/Novel.pdf",
      tags: ["fiction"],
      sourceType: "pdf",
    },
    {
      fileName: "bit 1995年09月号",
      filePath: "kindle:B09MLLNP2B",
      tags: ["magazine"],
      locationLabel: "Kindle library",
      authors: ["石田晴久", "竹内郁雄"],
      sourceType: "kindle",
    },
    {
      fileName: "Nested.pdf",
      filePath: "/Books/Tech/Rust/Nested.pdf",
      tags: ["tech"],
      sourceType: "pdf",
    },
  ];

  it("matches normalized search text against file name and path", () => {
    const results = filterVisibleBooks(books, null, null, null, false, "WEB+DB PRESS");

    expect(results).toEqual([books[0]]);
  });

  it("applies directory filtering before search matching", () => {
    const results = filterVisibleBooks(books, "/Books/Tech", null, null, false, "rust");

    expect(results).toEqual([books[1]]);
  });

  it("only lists books placed directly inside the active directory", () => {
    const results = filterVisibleBooks(books, "/Books/Tech", null, null, false, "");

    expect(results).toEqual([books[0], books[1]]);
  });

  it("filters by active tag", () => {
    const results = filterVisibleBooks(books, null, "tech", null, false, "");

    expect(results).toEqual([books[0], books[1], books[4]]);
  });

  it("matches search text against optional location labels and authors", () => {
    expect(filterVisibleBooks(books, null, null, null, false, "Kindle")).toEqual([books[3]]);
    expect(filterVisibleBooks(books, null, null, null, false, "竹内")).toEqual([books[3]]);
  });

  it("filters by external source", () => {
    expect(filterVisibleBooks(books, null, null, "kindle", false, "")).toEqual([books[3]]);
  });

  it("matches title field against the file name when metadata title is empty", () => {
    const results = filterVisibleBooks(books, null, null, null, false, "title:rust");
    expect(results).toEqual([books[1]]);
  });

  it("supports OR between free tokens", () => {
    const results = filterVisibleBooks(books, null, null, null, false, "rust OR novel");
    expect(results).toEqual([books[1], books[2], books[4]]);
  });

  it("supports OR between field tokens", () => {
    const results = filterVisibleBooks(
      books,
      null,
      null,
      null,
      false,
      "tag:fiction OR tag:magazine",
    );
    expect(results).toEqual([books[0], books[2], books[3]]);
  });

  it("supports parenthesised grouping with negation", () => {
    const results = filterVisibleBooks(
      books,
      null,
      null,
      null,
      false,
      "(tag:tech OR tag:magazine) -source:kindle",
    );
    expect(results).toEqual([books[0], books[1], books[4]]);
  });

  it("supports explicit AND keyword equivalent to whitespace", () => {
    const explicit = filterVisibleBooks(books, null, null, null, false, "tag:tech AND rust");
    const implicit = filterVisibleBooks(books, null, null, null, false, "tag:tech rust");
    expect(explicit).toEqual(implicit);
  });

  it("falls back to free-text on malformed query", () => {
    // Unclosed paren — safe parser treats the whole string as a free token.
    const results = filterVisibleBooks(books, null, null, null, false, "(rust");
    expect(results).toEqual([]);
  });

  it("can restrict parent tags to directly tagged files only", () => {
    const booksWithHierarchicalTags = [
      { fileName: "One.pdf", filePath: "/Books/One.pdf", tags: ["language/lean"] },
      { fileName: "Two.pdf", filePath: "/Books/Two.pdf", tags: ["language"] },
    ];

    expect(
      filterVisibleBooks(booksWithHierarchicalTags, null, "language", null, false, ""),
    ).toEqual(booksWithHierarchicalTags);
    expect(filterVisibleBooks(booksWithHierarchicalTags, null, "language", null, true, "")).toEqual(
      [booksWithHierarchicalTags[1]],
    );
  });
});

describe("deriveDirectories", () => {
  it("builds nested directory counts under configured roots", () => {
    const directories = deriveDirectories({
      libraryRoots: ["/Books"],
      books: [
        { filePath: "/Books/Tech/Rust Book.pdf" },
        { filePath: "/Books/Tech/WEB+DB-PRESS-Vol.131.pdf" },
        { filePath: "/Books/Fiction/Novel.pdf" },
      ],
    });

    expect(directories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "/Books",
          depth: 0,
          count: 3,
          hasChildren: true,
        }),
        expect.objectContaining({
          path: "/Books/Tech",
          depth: 0,
          count: 2,
        }),
        expect.objectContaining({
          path: "/Books/Fiction",
          depth: 0,
          count: 1,
        }),
      ]),
    );
  });

  it("prefers the longest matching library root", () => {
    const directories = deriveDirectories({
      libraryRoots: ["/Books", "/Books/Tech"],
      books: [{ filePath: "/Books/Tech/Rust/Deep Dive.pdf" }],
    });

    expect(directories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "/Books/Tech",
          count: 1,
          depth: 0,
        }),
        expect.objectContaining({
          path: "/Books/Tech/Rust",
          count: 1,
          depth: 0,
        }),
      ]),
    );
  });
});

describe("deriveTags", () => {
  it("counts tags across books and includes implicit parent labels", () => {
    const tags = deriveTags([
      { tags: ["tech", "magazine/web"] },
      { tags: ["tech", "language/lean"] },
      { tags: ["fiction"] },
      { tags: [] },
    ]);

    expect(tags).toEqual([
      { id: "fiction", label: "fiction", count: 1, depth: 0, explicit: true, hasChildren: false },
      { id: "language", label: "language", count: 1, depth: 0, explicit: false, hasChildren: true },
      {
        id: "language/lean",
        label: "lean",
        count: 1,
        depth: 1,
        explicit: true,
        hasChildren: false,
      },
      { id: "magazine", label: "magazine", count: 1, depth: 0, explicit: false, hasChildren: true },
      { id: "magazine/web", label: "web", count: 1, depth: 1, explicit: true, hasChildren: false },
      { id: "tech", label: "tech", count: 2, depth: 0, explicit: true, hasChildren: false },
    ]);
  });
});

describe("describeEmptyLibraryState", () => {
  const baseInput = {
    libraryRoots: ["/books"],
    existingLibraryRoots: ["/books"],
    missingLibraryRoots: [],
    bookCount: 0,
    hasFilter: false,
    libraryErrorMessage: null as string | null,
  };

  it("returns 'No matching books.' when a filter is active", () => {
    const result = describeEmptyLibraryState({ ...baseInput, hasFilter: true });
    expect(result).toEqual({ message: "No matching books.", detail: null });
  });

  it("preserves a recorded library error message verbatim", () => {
    const result = describeEmptyLibraryState({
      ...baseInput,
      libraryErrorMessage: "Boom!",
    });
    expect(result).toEqual({ message: "Boom!", detail: null });
  });

  it("prompts onboarding when no library roots are configured", () => {
    const result = describeEmptyLibraryState({ ...baseInput, libraryRoots: [] });
    expect(result.message).toBe("No library folders selected yet.");
    expect(result.detail).toContain("Settings");
  });

  it("flags missing roots when none of the configured ones exist", () => {
    const result = describeEmptyLibraryState({
      ...baseInput,
      libraryRoots: ["/missing"],
      existingLibraryRoots: [],
    });
    expect(result.message).toBe("The configured library folders do not exist.");
  });

  it("uses the missing-roots detail when bookCount is 0 and some roots are missing", () => {
    const result = describeEmptyLibraryState({
      ...baseInput,
      missingLibraryRoots: ["/gone"],
    });
    expect(result.message).toBe("Your library is empty.");
    expect(result.detail).toContain("Some configured folders are missing");
  });

  it("uses the simple detail when bookCount is 0 and all roots exist", () => {
    const result = describeEmptyLibraryState(baseInput);
    expect(result.message).toBe("Your library is empty.");
    expect(result.detail).toContain("No PDFs were found");
  });

  it("filter takes precedence over missing-roots and library error", () => {
    const result = describeEmptyLibraryState({
      ...baseInput,
      hasFilter: true,
      libraryErrorMessage: "ignored",
      libraryRoots: [],
    });
    expect(result.message).toBe("No matching books.");
  });
});

describe("derivePublishers", () => {
  it("returns distinct non-empty publishers in Japanese-collation order", () => {
    expect(
      derivePublishers([
        { publisher: "技術評論社" },
        { publisher: "オライリー" },
        { publisher: "技術評論社" },
        { publisher: "  " },
        { publisher: null },
        { publisher: "ラムダノート" },
      ]),
    ).toEqual(["オライリー", "ラムダノート", "技術評論社"]);
  });
});

describe("deriveLanguages", () => {
  it("returns distinct non-empty languages", () => {
    expect(
      deriveLanguages([
        { language: "ja" },
        { language: "en" },
        { language: "ja" },
        { language: null },
        { language: "" },
      ]),
    ).toEqual(["en", "ja"]);
  });
});

describe("deriveSources", () => {
  it("returns distinct non-empty source types", () => {
    expect(
      deriveSources([
        { sourceType: "pdf" },
        { sourceType: "kindle" },
        { sourceType: "pdf" },
        { sourceType: "epub" },
      ]),
    ).toEqual(["epub", "kindle", "pdf"]);
  });
});
