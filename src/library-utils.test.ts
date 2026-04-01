import { describe, expect, it } from "vitest";
import {
  deriveDirectories,
  filterVisibleBooks,
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
    },
    {
      fileName: "Rust Book.pdf",
      filePath: "/Books/Tech/Rust Book.pdf",
    },
    {
      fileName: "Novel.pdf",
      filePath: "/Books/Fiction/Novel.pdf",
    },
  ];

  it("matches normalized search text against file name and path", () => {
    const results = filterVisibleBooks(books, null, "WEB+DB PRESS");

    expect(results).toEqual([books[0]]);
  });

  it("applies directory filtering before search matching", () => {
    const results = filterVisibleBooks(books, "/Books/Tech", "rust");

    expect(results).toEqual([books[1]]);
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
