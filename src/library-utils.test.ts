import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  parseAbsoluteDateSeconds,
  parseRelativeDurationSeconds,
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

describe("parseRelativeDurationSeconds", () => {
  it("parses Gmail-style d/w/m/y units", () => {
    expect(parseRelativeDurationSeconds("7d")).toBe(7 * 86400);
    expect(parseRelativeDurationSeconds("2w")).toBe(2 * 7 * 86400);
    expect(parseRelativeDurationSeconds("3m")).toBe(3 * 30 * 86400);
    expect(parseRelativeDurationSeconds("1y")).toBe(365 * 86400);
  });

  it("parses named aliases", () => {
    expect(parseRelativeDurationSeconds("today")).toBe(86400);
    expect(parseRelativeDurationSeconds("week")).toBe(7 * 86400);
    expect(parseRelativeDurationSeconds("month")).toBe(30 * 86400);
    expect(parseRelativeDurationSeconds("year")).toBe(365 * 86400);
  });

  it("is case-insensitive and ignores surrounding whitespace", () => {
    expect(parseRelativeDurationSeconds("  7D  ")).toBe(7 * 86400);
    expect(parseRelativeDurationSeconds("WEEK")).toBe(7 * 86400);
  });

  it("returns null for unrecognised input", () => {
    expect(parseRelativeDurationSeconds("")).toBeNull();
    expect(parseRelativeDurationSeconds("7x")).toBeNull();
    expect(parseRelativeDurationSeconds("never")).toBeNull();
    expect(parseRelativeDurationSeconds("-1d")).toBeNull();
    expect(parseRelativeDurationSeconds("1.5d")).toBeNull();
  });
});

describe("parseAbsoluteDateSeconds", () => {
  it("parses YYYY/MM/DD at local midnight", () => {
    const ts = parseAbsoluteDateSeconds("2026/01/15");
    expect(ts).not.toBeNull();
    const d = new Date((ts as number) * 1000);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(0);
    expect(d.getDate()).toBe(15);
    expect(d.getHours()).toBe(0);
  });

  it("parses YYYY-MM-DD identically", () => {
    expect(parseAbsoluteDateSeconds("2026-01-15")).toBe(parseAbsoluteDateSeconds("2026/01/15"));
  });

  it("accepts single-digit months and days", () => {
    expect(parseAbsoluteDateSeconds("2026/1/5")).toBe(parseAbsoluteDateSeconds("2026/01/05"));
  });

  it("rejects mixed separators, malformed input, and impossible dates", () => {
    expect(parseAbsoluteDateSeconds("2026/01-15")).toBeNull();
    expect(parseAbsoluteDateSeconds("2026")).toBeNull();
    expect(parseAbsoluteDateSeconds("2026/13/01")).toBeNull();
    expect(parseAbsoluteDateSeconds("2026/02/30")).toBeNull();
    expect(parseAbsoluteDateSeconds("")).toBeNull();
  });
});

describe("filterVisibleBooks — time-based operators", () => {
  // Fixed wall-clock so relative computations are deterministic.
  const NOW = new Date("2026-05-12T12:00:00").getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const nowSeconds = Math.floor(NOW / 1000);
  const daysAgo = (n: number) => nowSeconds - n * 86400;

  const books = [
    {
      fileName: "Recent.pdf",
      filePath: "/Books/Recent.pdf",
      lastReadAt: daysAgo(2),
      indexedAt: daysAgo(400),
    },
    {
      fileName: "MidWeek.pdf",
      filePath: "/Books/MidWeek.pdf",
      lastReadAt: daysAgo(6),
      indexedAt: daysAgo(100),
    },
    {
      fileName: "Older.pdf",
      filePath: "/Books/Older.pdf",
      lastReadAt: daysAgo(60),
      indexedAt: daysAgo(30),
    },
    {
      fileName: "AncientUnread.pdf",
      filePath: "/Books/AncientUnread.pdf",
      lastReadAt: null,
      indexedAt: daysAgo(800),
    },
  ];

  it("newer_than:7d matches books read in the last 7 days", () => {
    const results = filterVisibleBooks(books, null, null, null, false, "newer_than:7d");
    expect(results.map((b) => b.fileName)).toEqual(["Recent.pdf", "MidWeek.pdf"]);
  });

  it("older_than:1m matches books last read more than 30 days ago, excluding never-read", () => {
    const results = filterVisibleBooks(books, null, null, null, false, "older_than:1m");
    expect(results.map((b) => b.fileName)).toEqual(["Older.pdf"]);
  });

  it("after:YYYY/MM/DD matches books read at or after the local-midnight cutoff", () => {
    // NOW = 2026-05-12, so "after:2026/04/01" includes Recent (2d) and MidWeek (6d).
    const results = filterVisibleBooks(books, null, null, null, false, "after:2026/04/01");
    expect(results.map((b) => b.fileName)).toEqual(["Recent.pdf", "MidWeek.pdf"]);
  });

  it("before:YYYY/MM/DD matches books read strictly before the cutoff", () => {
    const results = filterVisibleBooks(books, null, null, null, false, "before:2026/04/01");
    expect(results.map((b) => b.fileName)).toEqual(["Older.pdf"]);
  });

  it("ISO-style YYYY-MM-DD is accepted equivalently", () => {
    expect(filterVisibleBooks(books, null, null, null, false, "after:2026-04-01")).toEqual(
      filterVisibleBooks(books, null, null, null, false, "after:2026/04/01"),
    );
  });

  it("newer/older are Gmail-style aliases for after/before", () => {
    expect(filterVisibleBooks(books, null, null, null, false, "newer:2026/04/01")).toEqual(
      filterVisibleBooks(books, null, null, null, false, "after:2026/04/01"),
    );
    expect(filterVisibleBooks(books, null, null, null, false, "older:2026/04/01")).toEqual(
      filterVisibleBooks(books, null, null, null, false, "before:2026/04/01"),
    );
  });

  it("never-read books are excluded from all time predicates", () => {
    expect(
      filterVisibleBooks(books, null, null, null, false, "newer_than:99y").map((b) => b.fileName),
    ).not.toContain("AncientUnread.pdf");
    expect(
      filterVisibleBooks(books, null, null, null, false, "older_than:1d").map((b) => b.fileName),
    ).not.toContain("AncientUnread.pdf");
    expect(
      filterVisibleBooks(books, null, null, null, false, "before:2030/01/01").map(
        (b) => b.fileName,
      ),
    ).not.toContain("AncientUnread.pdf");
  });

  it("read:never still matches books with no reading history", () => {
    const results = filterVisibleBooks(books, null, null, null, false, "read:never");
    expect(results.map((b) => b.fileName)).toEqual(["AncientUnread.pdf"]);
  });

  it("added_newer_than targets indexed_at, not last_read_at", () => {
    // Recent.pdf was read 2 days ago but indexed 400 days ago, so it
    // matches newer_than:1m but not added_newer_than:1m.
    expect(
      filterVisibleBooks(books, null, null, null, false, "added_newer_than:1m").map(
        (b) => b.fileName,
      ),
    ).toEqual(["Older.pdf"]);
  });

  it("added_after targets indexed_at", () => {
    // Older.pdf indexed 30 days before NOW (≈2026-04-12) → on/after 2026-04-01.
    const results = filterVisibleBooks(books, null, null, null, false, "added_after:2026/04/01");
    expect(results.map((b) => b.fileName)).toEqual(["Older.pdf"]);
  });

  it("composes with AND/OR/NOT and other fields", () => {
    const results = filterVisibleBooks(
      books,
      null,
      null,
      null,
      false,
      "newer_than:1w AND -file:MidWeek",
    );
    expect(results.map((b) => b.fileName)).toEqual(["Recent.pdf"]);
  });

  it("invalid date values do not match any book and do not throw", () => {
    expect(filterVisibleBooks(books, null, null, null, false, "after:not-a-date")).toEqual([]);
    expect(filterVisibleBooks(books, null, null, null, false, "newer_than:7x")).toEqual([]);
  });

  it("existing read:Nd shorthand keeps working", () => {
    const results = filterVisibleBooks(books, null, null, null, false, "read:7d");
    expect(results.map((b) => b.fileName)).toEqual(["Recent.pdf", "MidWeek.pdf"]);
  });

  it("read:1y now resolves the new y unit", () => {
    const results = filterVisibleBooks(books, null, null, null, false, "read:1y");
    expect(results.map((b) => b.fileName)).toEqual(["Recent.pdf", "MidWeek.pdf", "Older.pdf"]);
  });
});
