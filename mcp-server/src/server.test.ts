import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import Database from "better-sqlite3";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import {
  createServer,
  type CreateServerOptions,
  isValidIsbn,
  normalizeIsbn,
  extractIsbnCandidates,
  chooseBestIsbn,
  parseColophonDate,
  parseColophonPublisher,
  parseColophon,
} from "./index.js";

// ---------------------------------------------------------------------------
// Test DB helpers
// ---------------------------------------------------------------------------

function tempDbPath(): string {
  return path.join(os.tmpdir(), `riida-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function createTestDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE books (
      file_path TEXT NOT NULL UNIQUE,
      file_name TEXT NOT NULL,
      file_size INTEGER,
      modified_at INTEGER,
      indexed_at INTEGER
    );
    CREATE TABLE book_metadata (
      file_path TEXT PRIMARY KEY,
      title TEXT DEFAULT '',
      authors_json TEXT DEFAULT '[]',
      description TEXT DEFAULT '',
      publisher TEXT DEFAULT '',
      release_date TEXT DEFAULT '',
      language TEXT DEFAULT '',
      url TEXT DEFAULT '',
      asin TEXT DEFAULT '',
      cover_url TEXT DEFAULT '',
      updated_at INTEGER
    );
    CREATE TABLE book_tags (
      file_path TEXT NOT NULL,
      tag TEXT NOT NULL,
      PRIMARY KEY (file_path, tag)
    );
  `);
  return db;
}

async function makeClient(
  dbPath: string,
  options: Pick<CreateServerOptions, "pdfExtractor" | "pdftotext"> = {},
): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const server = createServer({ dbPath, ...options });
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    cleanup: async () => {
      await client.close();
    },
  };
}

function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return client.callTool({ name, arguments: args }) as any;
}

function parseText(result: { content: Array<{ type: string; text: string }> }): unknown {
  return JSON.parse(result.content[0].text);
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe("tools/list", () => {
  let dbPath: string;
  let cleanup: () => Promise<void>;
  let client: Client;

  beforeEach(async () => {
    dbPath = tempDbPath();
    createTestDb(dbPath).close();
    ({ client, cleanup } = await makeClient(dbPath));
  });

  afterEach(async () => {
    await cleanup();
    fs.unlinkSync(dbPath);
  });

  it("exposes all 8 tools", async () => {
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("list_books_needing_metadata");
    expect(names).toContain("get_book_metadata");
    expect(names).toContain("read_pdf_pages");
    expect(names).toContain("read_pdf_colophon");
    expect(names).toContain("update_books_metadata");
    expect(names).toContain("search_books");
    expect(names).toContain("get_book_tags");
    expect(names).toContain("set_book_tags");
    expect(names).toHaveLength(8);
  });
});

// ---------------------------------------------------------------------------

describe("list_books_needing_metadata", () => {
  let dbPath: string;
  let db: Database.Database;
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    dbPath = tempDbPath();
    db = createTestDb(dbPath);
    ({ client, cleanup } = await makeClient(dbPath));
  });

  afterEach(async () => {
    await cleanup();
    db.close();
    fs.unlinkSync(dbPath);
  });

  it("returns books with no metadata row", async () => {
    db.prepare("INSERT INTO books (file_path, file_name) VALUES (?, ?)").run(
      "/books/novel.pdf",
      "novel.pdf",
    );

    const result = parseText(await callTool(client, "list_books_needing_metadata")) as {
      count: number;
      books: Array<{ file_path: string }>;
    };
    expect(result.count).toBe(1);
    expect(result.books[0].file_path).toBe("/books/novel.pdf");
  });

  it("returns books with empty title", async () => {
    db.prepare("INSERT INTO books (file_path, file_name) VALUES (?, ?)").run(
      "/books/untitled.pdf",
      "untitled.pdf",
    );
    db.prepare(
      "INSERT INTO book_metadata (file_path, title, authors_json) VALUES (?, '', '[\"著者\"]')",
    ).run("/books/untitled.pdf");

    const result = parseText(await callTool(client, "list_books_needing_metadata")) as {
      count: number;
    };
    expect(result.count).toBe(1);
  });

  it("returns books with empty authors", async () => {
    db.prepare("INSERT INTO books (file_path, file_name) VALUES (?, ?)").run(
      "/books/noauthor.pdf",
      "noauthor.pdf",
    );
    db.prepare(
      "INSERT INTO book_metadata (file_path, title, authors_json) VALUES (?, '書名', '[]')",
    ).run("/books/noauthor.pdf");

    const result = parseText(await callTool(client, "list_books_needing_metadata")) as {
      count: number;
    };
    expect(result.count).toBe(1);
  });

  it("excludes books that already have title and authors", async () => {
    db.prepare("INSERT INTO books (file_path, file_name) VALUES (?, ?)").run(
      "/books/complete.pdf",
      "complete.pdf",
    );
    db.prepare(
      "INSERT INTO book_metadata (file_path, title, authors_json) VALUES (?, '完全な本', '[\"著者名\"]')",
    ).run("/books/complete.pdf");

    const result = parseText(await callTool(client, "list_books_needing_metadata")) as {
      count: number;
    };
    expect(result.count).toBe(0);
  });

  it("respects the limit parameter", async () => {
    for (let i = 0; i < 5; i++) {
      db.prepare("INSERT INTO books (file_path, file_name) VALUES (?, ?)").run(
        `/books/book${i}.pdf`,
        `book${i}.pdf`,
      );
    }

    const result = parseText(
      await callTool(client, "list_books_needing_metadata", { limit: 3 }),
    ) as { count: number };
    expect(result.count).toBe(3);
  });

  it("includes path_parts and directory in results", async () => {
    db.prepare("INSERT INTO books (file_path, file_name) VALUES (?, ?)").run(
      "/library/sci-fi/book.pdf",
      "book.pdf",
    );

    const result = parseText(await callTool(client, "list_books_needing_metadata")) as {
      books: Array<{ directory: string; path_parts: string[] }>;
    };
    expect(result.books[0].directory).toBe("/library/sci-fi");
    expect(result.books[0].path_parts).toContain("sci-fi");
  });
});

// ---------------------------------------------------------------------------

describe("get_book_metadata", () => {
  let dbPath: string;
  let db: Database.Database;
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    dbPath = tempDbPath();
    db = createTestDb(dbPath);
    ({ client, cleanup } = await makeClient(dbPath));
  });

  afterEach(async () => {
    await cleanup();
    db.close();
    fs.unlinkSync(dbPath);
  });

  it("returns found: false for unknown path", async () => {
    const result = parseText(
      await callTool(client, "get_book_metadata", { file_path: "/books/missing.pdf" }),
    ) as { found: boolean };
    expect(result.found).toBe(false);
  });

  it("returns metadata with parsed authors array", async () => {
    db.prepare(
      `INSERT INTO book_metadata (file_path, title, authors_json, publisher, language)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("/books/mybook.pdf", "テスト書名", JSON.stringify(["著者A", "著者B"]), "出版社X", "ja");

    const result = parseText(
      await callTool(client, "get_book_metadata", { file_path: "/books/mybook.pdf" }),
    ) as { found: boolean; title: string; authors: string[]; publisher: string; language: string };

    expect(result.found).toBe(true);
    expect(result.title).toBe("テスト書名");
    expect(result.authors).toEqual(["著者A", "著者B"]);
    expect(result.publisher).toBe("出版社X");
    expect(result.language).toBe("ja");
  });
});

// ---------------------------------------------------------------------------

describe("update_books_metadata", () => {
  let dbPath: string;
  let db: Database.Database;
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    dbPath = tempDbPath();
    db = createTestDb(dbPath);
    ({ client, cleanup } = await makeClient(dbPath));
  });

  afterEach(async () => {
    await cleanup();
    db.close();
    fs.unlinkSync(dbPath);
  });

  it("inserts a new metadata row", async () => {
    const result = parseText(
      await callTool(client, "update_books_metadata", {
        books: [{ file_path: "/books/new.pdf", title: "新しい本", authors: ["新著者"], publisher: "新出版社", language: "ja" }],
      }),
    ) as { success: boolean; count: number; results: Array<{ file_path: string; updated: { title: string; authors: string[] } }> };

    expect(result.success).toBe(true);
    expect(result.count).toBe(1);
    expect(result.results[0].updated.title).toBe("新しい本");
    expect(result.results[0].updated.authors).toEqual(["新著者"]);

    const row = db
      .prepare<[string], { title: string }>("SELECT title FROM book_metadata WHERE file_path = ?")
      .get("/books/new.pdf");
    expect(row?.title).toBe("新しい本");
  });

  it("updates only the provided fields and preserves others", async () => {
    db.prepare(
      `INSERT INTO book_metadata (file_path, title, authors_json, publisher, url)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      "/books/existing.pdf",
      "元の書名",
      JSON.stringify(["元著者"]),
      "元出版社",
      "https://example.com",
    );

    await callTool(client, "update_books_metadata", {
      books: [{ file_path: "/books/existing.pdf", title: "改訂版書名" }],
    });

    const row = db
      .prepare<
        [string],
        { title: string; authors_json: string; publisher: string; url: string }
      >("SELECT title, authors_json, publisher, url FROM book_metadata WHERE file_path = ?")
      .get("/books/existing.pdf");

    expect(row?.title).toBe("改訂版書名");
    expect(JSON.parse(row?.authors_json ?? "[]")).toEqual(["元著者"]);
    expect(row?.publisher).toBe("元出版社");
    expect(row?.url).toBe("https://example.com");
  });

  it("sets updated_at timestamp", async () => {
    const before = Date.now();

    await callTool(client, "update_books_metadata", {
      books: [{ file_path: "/books/ts.pdf", title: "タイムスタンプ確認" }],
    });

    const after = Date.now();
    const row = db
      .prepare<[string], { updated_at: number }>(
        "SELECT updated_at FROM book_metadata WHERE file_path = ?",
      )
      .get("/books/ts.pdf");

    expect(row?.updated_at).toBeGreaterThanOrEqual(before);
    expect(row?.updated_at).toBeLessThanOrEqual(after);
  });

  it("updates multiple books in a single call", async () => {
    const result = parseText(
      await callTool(client, "update_books_metadata", {
        books: [
          { file_path: "/books/a.pdf", title: "本A", authors: ["著者A"], language: "ja" },
          { file_path: "/books/b.pdf", title: "本B", publisher: "出版社B", language: "ja" },
          { file_path: "/books/c.pdf", title: "本C", release_date: "2024-01-01", language: "ja" },
        ],
      }),
    ) as { success: boolean; count: number; results: Array<{ file_path: string }> };

    expect(result.success).toBe(true);
    expect(result.count).toBe(3);

    const rowA = db.prepare<[string], { title: string; language: string }>(
      "SELECT title, language FROM book_metadata WHERE file_path = ?",
    ).get("/books/a.pdf");
    const rowB = db.prepare<[string], { title: string; publisher: string }>(
      "SELECT title, publisher FROM book_metadata WHERE file_path = ?",
    ).get("/books/b.pdf");
    const rowC = db.prepare<[string], { title: string; release_date: string }>(
      "SELECT title, release_date FROM book_metadata WHERE file_path = ?",
    ).get("/books/c.pdf");

    expect(rowA?.title).toBe("本A");
    expect(rowA?.language).toBe("ja");
    expect(rowB?.title).toBe("本B");
    expect(rowB?.publisher).toBe("出版社B");
    expect(rowC?.title).toBe("本C");
    expect(rowC?.release_date).toBe("2024-01-01");
  });

  it("returns an error for empty books array", async () => {
    const result = await callTool(client, "update_books_metadata", { books: [] });
    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("get_book_tags / set_book_tags", () => {
  let dbPath: string;
  let db: Database.Database;
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    dbPath = tempDbPath();
    db = createTestDb(dbPath);
    ({ client, cleanup } = await makeClient(dbPath));
  });

  afterEach(async () => {
    await cleanup();
    db.close();
    fs.unlinkSync(dbPath);
  });

  it("get_book_tags returns empty array for untagged book", async () => {
    const result = parseText(
      await callTool(client, "get_book_tags", { file_path: "/books/a.pdf" }),
    ) as { tags: string[] };
    expect(result.tags).toEqual([]);
  });

  it("set_book_tags then get_book_tags round-trips correctly", async () => {
    await callTool(client, "set_book_tags", {
      file_path: "/books/b.pdf",
      tags: ["SF", "技術書", "お気に入り"],
    });

    const result = parseText(
      await callTool(client, "get_book_tags", { file_path: "/books/b.pdf" }),
    ) as { tags: string[] };

    expect(result.tags).toHaveLength(3);
    expect(result.tags).toContain("SF");
    expect(result.tags).toContain("技術書");
  });

  it("set_book_tags replaces existing tags", async () => {
    await callTool(client, "set_book_tags", {
      file_path: "/books/c.pdf",
      tags: ["古いタグ1", "古いタグ2"],
    });
    await callTool(client, "set_book_tags", {
      file_path: "/books/c.pdf",
      tags: ["新しいタグ"],
    });

    const result = parseText(
      await callTool(client, "get_book_tags", { file_path: "/books/c.pdf" }),
    ) as { tags: string[] };
    expect(result.tags).toEqual(["新しいタグ"]);
  });

  it("set_book_tags with empty array removes all tags", async () => {
    await callTool(client, "set_book_tags", { file_path: "/books/d.pdf", tags: ["削除対象"] });
    await callTool(client, "set_book_tags", { file_path: "/books/d.pdf", tags: [] });

    const result = parseText(
      await callTool(client, "get_book_tags", { file_path: "/books/d.pdf" }),
    ) as { tags: string[] };
    expect(result.tags).toEqual([]);
  });

  it("set_book_tags trims whitespace and ignores blank entries", async () => {
    await callTool(client, "set_book_tags", {
      file_path: "/books/e.pdf",
      tags: ["  SF  ", "", "  "],
    });

    const result = parseText(
      await callTool(client, "get_book_tags", { file_path: "/books/e.pdf" }),
    ) as { tags: string[] };
    expect(result.tags).toEqual(["SF"]);
  });

// ---------------------------------------------------------------------------

  it("set_book_tags deduplicates tags", async () => {
    await callTool(client, "set_book_tags", {
      file_path: "/books/f.pdf",
      tags: ["SF", "SF", "技術書"],
    });

    const result = parseText(
      await callTool(client, "get_book_tags", { file_path: "/books/f.pdf" }),
    ) as { tags: string[] };
    expect(result.tags).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------

describe("read_pdf_pages", () => {
  let dbPath: string;
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    dbPath = tempDbPath();
    createTestDb(dbPath).close();
  });

  afterEach(async () => {
    await cleanup();
    fs.unlinkSync(dbPath);
  });

  it("returns isError when file does not exist", async () => {
    ({ client, cleanup } = await makeClient(dbPath));

    const result = await callTool(client, "read_pdf_pages", {
      file_path: "/nonexistent/book.pdf",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch("File not found");
  });

  it("extracts text via pdfParser and caps max_pages at 10", async () => {
    const mockParser = vi.fn().mockResolvedValue({ text: "テスト本文", total: 100, pages: [] });
    ({ client, cleanup } = await makeClient(dbPath, { pdfExtractor: mockParser }));

    // Create a temporary dummy file so existsSync passes
    const tmpPdf = path.join(os.tmpdir(), "dummy-test.pdf");
    fs.writeFileSync(tmpPdf, "dummy");
    try {
      const result = parseText(
        await callTool(client, "read_pdf_pages", { file_path: tmpPdf, max_pages: 99 }),
      ) as { pages_extracted: number; total_pages: number; text: string };

      // max_pages should be capped at 10
      expect(result.pages_extracted).toBe(10);
      expect(result.total_pages).toBe(100);
      expect(result.text).toBe("テスト本文");
      expect(mockParser).toHaveBeenCalledWith(expect.any(Buffer), { first: 10 });
    } finally {
      fs.unlinkSync(tmpPdf);
    }
  });

  it("defaults max_pages to 3", async () => {
    const mockParser = vi.fn().mockResolvedValue({ text: "本文", total: 50, pages: [] });
    ({ client, cleanup } = await makeClient(dbPath, { pdfExtractor: mockParser }));

    const tmpPdf = path.join(os.tmpdir(), "dummy-default.pdf");
    fs.writeFileSync(tmpPdf, "dummy");
    try {
      await callTool(client, "read_pdf_pages", { file_path: tmpPdf });
      expect(mockParser).toHaveBeenCalledWith(expect.any(Buffer), { first: 3 });
    } finally {
      fs.unlinkSync(tmpPdf);
    }
  });

  it("truncates extracted text to 8000 characters", async () => {
    const longText = "あ".repeat(10000);
    const mockParser = vi.fn().mockResolvedValue({ text: longText, total: 5, pages: [] });
    ({ client, cleanup } = await makeClient(dbPath, { pdfExtractor: mockParser }));

    const tmpPdf = path.join(os.tmpdir(), "dummy-long.pdf");
    fs.writeFileSync(tmpPdf, "dummy");
    try {
      const result = parseText(
        await callTool(client, "read_pdf_pages", { file_path: tmpPdf }),
      ) as { text: string };
      expect(result.text.length).toBeLessThanOrEqual(8000);
    } finally {
      fs.unlinkSync(tmpPdf);
    }
  });
});

// ---------------------------------------------------------------------------

describe("search_books", () => {
  let dbPath: string;
  let db: Database.Database;
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    dbPath = tempDbPath();
    db = createTestDb(dbPath);

    // Seed books
    const insertBook = db.prepare(
      "INSERT INTO books (file_path, file_name) VALUES (?, ?)",
    );
    const insertMeta = db.prepare(
      `INSERT INTO book_metadata (file_path, title, authors_json, publisher, language)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const insertTag = db.prepare(
      "INSERT OR IGNORE INTO book_tags (file_path, tag) VALUES (?, ?)",
    );

    insertBook.run("/lib/sci-fi/dune.pdf",        "dune.pdf");
    insertBook.run("/lib/sci-fi/foundation.pdf",  "foundation.pdf");
    insertBook.run("/lib/tech/clean-code.pdf",    "clean-code.pdf");
    insertBook.run("/lib/tech/refactoring.pdf",   "refactoring.pdf");
    insertBook.run("/other/novel.pdf",            "novel.pdf");

    insertMeta.run("/lib/sci-fi/dune.pdf",       "Dune",        '["Frank Herbert"]', "Chilton", "en");
    insertMeta.run("/lib/sci-fi/foundation.pdf",  "Foundation",  '["Isaac Asimov"]',  "Gnome",   "en");
    insertMeta.run("/lib/tech/clean-code.pdf",    "Clean Code",  '["Robert Martin"]', "Prentice","en");
    // refactoring and novel have no metadata row

    insertTag.run("/lib/sci-fi/dune.pdf",       "SF");
    insertTag.run("/lib/sci-fi/foundation.pdf", "SF");
    insertTag.run("/lib/tech/clean-code.pdf",   "tech");

    ({ client, cleanup } = await makeClient(dbPath));
  });

  afterEach(async () => {
    await cleanup();
    db.close();
    fs.unlinkSync(dbPath);
  });

  it("returns all books when no filters given", async () => {
    const result = parseText(await callTool(client, "search_books")) as { count: number };
    expect(result.count).toBe(5);
  });

  it("filters by directory prefix", async () => {
    const result = parseText(
      await callTool(client, "search_books", { directory: "/lib/sci-fi" }),
    ) as { count: number; books: Array<{ file_name: string }> };
    expect(result.count).toBe(2);
    expect(result.books.map((b) => b.file_name)).toContain("dune.pdf");
    expect(result.books.map((b) => b.file_name)).toContain("foundation.pdf");
  });

  it("directory filter ignores trailing slash", async () => {
    const withSlash    = parseText(await callTool(client, "search_books", { directory: "/lib/sci-fi/" }))  as { count: number };
    const withoutSlash = parseText(await callTool(client, "search_books", { directory: "/lib/sci-fi" }))   as { count: number };
    expect(withSlash.count).toBe(withoutSlash.count);
  });

  it("filters by path_contains", async () => {
    const result = parseText(
      await callTool(client, "search_books", { path_contains: "tech" }),
    ) as { count: number };
    expect(result.count).toBe(2);
  });

  it("filters by title_contains (case-insensitive via LIKE)", async () => {
    const result = parseText(
      await callTool(client, "search_books", { title_contains: "clean" }),
    ) as { count: number; books: Array<{ title: string }> };
    expect(result.count).toBe(1);
    expect(result.books[0].title).toBe("Clean Code");
  });

  it("filters by author_contains", async () => {
    const result = parseText(
      await callTool(client, "search_books", { author_contains: "Asimov" }),
    ) as { count: number; books: Array<{ authors: string[] }> };
    expect(result.count).toBe(1);
    expect(result.books[0].authors).toContain("Isaac Asimov");
  });

  it("filters by tag", async () => {
    const result = parseText(
      await callTool(client, "search_books", { tag: "SF" }),
    ) as { count: number };
    expect(result.count).toBe(2);
  });

  it("filters by missing_metadata", async () => {
    const result = parseText(
      await callTool(client, "search_books", { missing_metadata: true }),
    ) as { count: number; books: Array<{ file_name: string }> };
    expect(result.count).toBe(2);
    const names = result.books.map((b) => b.file_name);
    expect(names).toContain("refactoring.pdf");
    expect(names).toContain("novel.pdf");
  });

  it("combines multiple filters with AND", async () => {
    // directory=/lib AND tag=SF → dune + foundation
    const result = parseText(
      await callTool(client, "search_books", { directory: "/lib", tag: "SF" }),
    ) as { count: number };
    expect(result.count).toBe(2);
  });

  it("respects the limit parameter", async () => {
    const result = parseText(
      await callTool(client, "search_books", { limit: 2 }),
    ) as { count: number };
    expect(result.count).toBe(2);
  });

  it("result includes metadata fields", async () => {
    const result = parseText(
      await callTool(client, "search_books", { path_contains: "dune" }),
    ) as { books: Array<{ title: string; authors: string[]; publisher: string; language: string; directory: string }> };
    const book = result.books[0];
    expect(book.title).toBe("Dune");
    expect(book.authors).toContain("Frank Herbert");
    expect(book.publisher).toBe("Chilton");
    expect(book.language).toBe("en");
    expect(book.directory).toBe("/lib/sci-fi");
  });
});

// ---------------------------------------------------------------------------
// Colophon (奥付) parsing — pure helpers
//
// The sample strings below are reduced from the actual colophon text that
// pdf-parse produces for real books in the test library (C&R/Mynavi, O'Reilly
// Japan, Ohmsha), including the quirks that matter: a Japanese C-code, a
// back-matter ad list of foreign ISBNs, parenthesised ISBNs, ISBNs broken
// across pdf.js line breaks, and a trailing reprint date.
// ---------------------------------------------------------------------------

describe("isValidIsbn / normalizeIsbn", () => {
  it("validates ISBN-13 check digits", () => {
    expect(isValidIsbn("9784863542440")).toBe(true);
    expect(isValidIsbn("9784873116860")).toBe(true);
    expect(isValidIsbn("9784873116861")).toBe(false); // flipped check digit
  });

  it("validates ISBN-10 check digits, including a trailing X", () => {
    expect(isValidIsbn("4274066568")).toBe(true);
    expect(isValidIsbn("097522980X")).toBe(true);
    expect(isValidIsbn("0975229801")).toBe(false);
  });

  it("rejects wrong-length inputs", () => {
    expect(isValidIsbn("123")).toBe(false);
    expect(isValidIsbn("97848635424400")).toBe(false);
  });

  it("normalizeIsbn strips separators and upcases X", () => {
    expect(normalizeIsbn("978-4-86354-244-0")).toBe("9784863542440");
    expect(normalizeIsbn("978–4–87311–697-6")).toBe("9784873116976");
    expect(normalizeIsbn("4-9752298-0-x")).toBe("497522980X");
  });
});

describe("extractIsbnCandidates", () => {
  it("extracts a standard ISBN-13 with a trailing C-code", () => {
    const cands = extractIsbnCandidates("ISBN978-4-86354-244-0 C3055\n©Money Forward");
    expect(cands).toHaveLength(1);
    expect(cands[0].normalized).toBe("9784863542440");
    expect(cands[0].raw).toBe("978-4-86354-244-0");
    expect(cands[0].valid).toBe(true);
    expect(cands[0].cCode).toBe("C3055");
  });

  it("extracts a parenthesised ISBN with no C-code", () => {
    const cands = extractIsbnCandidates("Printed in Japan（ISBN978-4-87311-686-0）");
    expect(cands).toHaveLength(1);
    expect(cands[0].normalized).toBe("9784873116860");
    expect(cands[0].cCode).toBeNull();
  });

  it("reassembles an ISBN split across pdf.js line breaks", () => {
    // pdf.js renders some vertical-layout colophons one glyph-group per line.
    const cands = extractIsbnCandidates("（ISBN978\n4\n87311\n697\n6）");
    expect(cands).toHaveLength(1);
    expect(cands[0].normalized).toBe("9784873116976");
    expect(cands[0].valid).toBe(true);
  });

  it("recognises an old 10-digit ISBN", () => {
    const cands = extractIsbnCandidates("ISBN 4-274-06656-8");
    expect(cands).toHaveLength(1);
    expect(cands[0].normalized).toBe("4274066568");
    expect(cands[0].valid).toBe(true);
  });

  it("does not swallow a trailing date into the digit run", () => {
    const cands = extractIsbnCandidates("ISBN 978-4-274-06866-9\n2014 年 6 月");
    expect(cands).toHaveLength(1);
    expect(cands[0].normalized).toBe("9784274068669");
    expect(cands[0].valid).toBe(true);
  });

  it("requires the ISBN prefix (ignores phone numbers and prices)", () => {
    expect(extractIsbnCandidates("電話 025-259-4293 FAX 025-258-2801 定価 2800 円")).toEqual([]);
  });
});

describe("chooseBestIsbn", () => {
  it("picks the C-coded own-book ISBN over a back-matter ad list", () => {
    const text = [
      "関連書籍のご案内",
      "ISBN978-4-274-06256-8",
      "ISBN978-4-87311-138-4",
      "ISBN978-4-87311-139-1",
      "発行所",
      "株式会社 シーアンドアール研究所",
      "ISBN978-4-86354-205-1 C3055",
      "Printed in Japan",
    ].join("\n");
    const best = chooseBestIsbn(extractIsbnCandidates(text), text);
    expect(best?.normalized).toBe("9784863542051");
    expect(best?.cCode).toBe("C3055");
  });

  it("returns null when there are no candidates", () => {
    expect(chooseBestIsbn([], "no isbn here")).toBeNull();
  });
});

describe("parseColophonDate", () => {
  it("prefers the first-edition (初版第1刷) date over a later reprint", () => {
    const text = "2014 年 11 月 19 日 初版第 1 刷発行\n2019 年 6 月 24 日 初版第 8 刷発行";
    expect(parseColophonDate(text)).toBe("2014-11-19");
  });

  it("handles fullwidth digits", () => {
    expect(parseColophonDate("２０１８年９月３日 初版発行")).toBe("2018-09-03");
  });

  it("returns empty string when no date is present", () => {
    expect(parseColophonDate("ISBN978-4-86354-244-0")).toBe("");
  });

  it("picks the latest edition's first printing for a multi-edition colophon", () => {
    // Real World HTTP 第2版: the colophon lists the original 初版 plus the 第2版
    // printings. The file is the 第2版, so its 第2版第1刷 date is what we want.
    const text = [
      "2017 年 6 月 13 日 初版第 1 刷発行",
      "2020 年 4 月 17 日 第 2 版第 1 刷発行",
      "2021 年 2 月 16 日 第 2 版第 2 刷発行",
    ].join("\n");
    expect(parseColophonDate(text)).toBe("2020-04-17");
  });

  it("skips later 初版 reprints and keeps the first printing", () => {
    // JavaScript 第6版: 初版第1刷 then 初版第6刷, no further edition.
    const text = "2012 年 8 月 15 日 初版第 1 刷発行\n2016 年 8 月 19 日 初版第 6 刷発行";
    expect(parseColophonDate(text)).toBe("2012-08-15");
  });

  it("parses dates split one glyph per line (pdf.js vertical layout)", () => {
    // pdf.js renders O'Reilly Japan vertical colophons one glyph per line, so a
    // single date arrives with newlines between every character.
    const text = "2\n0\n2\n0\n年\n4\n月\n1\n7\n日\n第\n2\n版\n第\n1\n刷\n発\n行";
    expect(parseColophonDate(text)).toBe("2020-04-17");
  });

  it("ignores out-of-range month/day noise", () => {
    expect(parseColophonDate("2020 年 13 月 40 日")).toBe("");
  });
});

describe("parseColophonPublisher", () => {
  it("reads the company name in the window after a publisher keyword", () => {
    const text = "発行所\n株式会社 シーアンドアール研究所\n新潟県新潟市北区西名目所 4083-6";
    expect(parseColophonPublisher(text)).toBe("株式会社シーアンドアール研究所");
  });

  it("does not pull the company name out of copyright boilerplate", () => {
    // No publisher keyword present; the only 株式会社 is inside running text.
    expect(parseColophonPublisher("本書を株式会社リイダに無断で複写することを禁じます")).toBe("");
  });

  it("reads a label spaced out by pdftotext -layout", () => {
    // O'Reilly Japan colophons render as a padded table; -layout keeps the
    // label and company on one line but inserts spaces inside the keyword.
    const text = "発   行    所        株式会社オライリー・ジャパン\n発   売    元        株式会社オーム社";
    expect(parseColophonPublisher(text)).toBe("株式会社オライリー・ジャパン");
  });
});

describe("parseColophon", () => {
  it("parses a full C&R-style colophon at high confidence", () => {
    const text = [
      "改訂2版 Ruby逆引きハンドブック",
      "2018 年 9月3日 初版発行 Ver.1.0",
      "発行所",
      "株式会社 シーアンドアール研究所",
      "ISBN978-4-86354-244-0 C3055",
      "©Money Forward, Inc., 2018",
      "Printed in Japan",
    ].join("\n");
    const c = parseColophon(text);
    expect(c.isbn_normalized).toBe("9784863542440");
    expect(c.isbn_valid).toBe(true);
    expect(c.c_code).toBe("C3055");
    expect(c.isbn_confidence).toBe("high");
    expect(c.release_date).toBe("2018-09-03");
    expect(c.publisher).toBe("株式会社シーアンドアール研究所");
    expect(c.printed_in_japan).toBe(true);
  });

  it("flags low confidence when several ISBNs sit far from the colophon", () => {
    // Mimics a book whose own colophon is image-only, so only an advertised
    // back-matter list of (distant) ISBNs is extractable.
    const ads = Array.from({ length: 6 }, (_, i) => `ISBN978-4-764-90${250 + i}-8`).join(
      "\n",
    );
    const text = `${ads}\n${"レビュー".repeat(2000)}\n初版発行\n発行所`;
    const c = parseColophon(text);
    expect(c.isbn).not.toBeNull();
    expect(c.isbn_confidence).toBe("low");
  });

  it("reports none when no ISBN can be extracted", () => {
    const c = parseColophon("奥付が画像のみで本文に ISBN がありません");
    expect(c.isbn).toBeNull();
    expect(c.isbn_confidence).toBe("none");
    expect(c.isbn_candidates).toEqual([]);
  });
});

describe("read_pdf_colophon", () => {
  let dbPath: string;
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    dbPath = tempDbPath();
    createTestDb(dbPath).close();
  });

  afterEach(async () => {
    await cleanup();
    fs.unlinkSync(dbPath);
  });

  it("returns isError when file does not exist", async () => {
    ({ client, cleanup } = await makeClient(dbPath));
    const result = await callTool(client, "read_pdf_colophon", {
      file_path: "/nonexistent/book.pdf",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch("File not found");
  });

  it("parses the colophon from the parsed text", async () => {
    const colophonText = [
      "発行所",
      "株式会社 オーム社",
      "ISBN978-4-274-06866-9",
      "Printed in Japan",
    ].join("\n");
    const mockParser = vi.fn().mockResolvedValue({ text: colophonText, total: 440, pages: [] });
    ({ client, cleanup } = await makeClient(dbPath, { pdfExtractor: mockParser }));

    const tmpPdf = path.join(os.tmpdir(), "dummy-colophon.pdf");
    fs.writeFileSync(tmpPdf, "dummy");
    try {
      const result = parseText(
        await callTool(client, "read_pdf_colophon", { file_path: tmpPdf }),
      ) as {
        total_pages: number;
        tail_pages_read: number | null;
        colophon: { isbn_normalized: string; isbn_valid: boolean; isbn_confidence: string };
      };
      expect(result.total_pages).toBe(440);
      // The stub returns no per-page text, so the handler falls back to the
      // full text and cannot report a tail page count.
      expect(result.tail_pages_read).toBeNull();
      expect(result.colophon.isbn_normalized).toBe("9784274068669");
      expect(result.colophon.isbn_valid).toBe(true);
      // The colophon is read from the trailing pages via the `last` option.
      expect(mockParser).toHaveBeenCalledWith(expect.any(Buffer), { last: 8 });
    } finally {
      fs.unlinkSync(tmpPdf);
    }
  });
});

describe("read_pdf_colophon — pdftotext fallback", () => {
  let dbPath: string;
  let client: Client;
  let cleanup: () => Promise<void>;
  const tmpPdf = path.join(os.tmpdir(), "fallback-test.pdf");

  beforeEach(async () => {
    dbPath = tempDbPath();
    createTestDb(dbPath).close();
    fs.writeFileSync(tmpPdf, "dummy");
  });

  afterEach(async () => {
    await cleanup();
    fs.unlinkSync(dbPath);
    fs.unlinkSync(tmpPdf);
  });

  it("falls back to pdftotext when pdf.js yields no ISBN", async () => {
    // pdf.js extracts the page but the ISBN's font has no ToUnicode CMap, so no
    // ISBN surfaces; poppler reads the same page cleanly.
    const pdfExtractor = vi.fn().mockResolvedValue({ text: "奥付\n発行 翔泳社", total: 240, pages: [] });
    const pdftotext = vi
      .fn()
      .mockReturnValue("発行所\n株式会社 翔泳社\nISBN978-4-7981-5767-2\nPrinted in Japan");
    ({ client, cleanup } = await makeClient(dbPath, { pdfExtractor, pdftotext }));

    const result = parseText(
      await callTool(client, "read_pdf_colophon", { file_path: tmpPdf }),
    ) as { isbn_source: string; colophon: { isbn_normalized: string; isbn_valid: boolean } };

    expect(result.isbn_source).toBe("pdftotext");
    expect(result.colophon.isbn_normalized).toBe("9784798157672");
    expect(result.colophon.isbn_valid).toBe(true);
    expect(pdftotext).toHaveBeenCalledTimes(1);
  });

  it("does not invoke pdftotext when pdf.js read a complete colophon", async () => {
    // pdf.js found the ISBN, the date, and the publisher, so there is nothing
    // left for poppler to fill — the redundant second read is skipped.
    const pdfExtractor = vi.fn().mockResolvedValue({
      text: [
        "発行所 株式会社 翔泳社",
        "2021 年 6 月 14 日 初版第 1 刷発行",
        "ISBN978-4-7981-6849-4 C3055",
        "Printed in Japan",
      ].join("\n"),
      total: 300,
      pages: [],
    });
    const pdftotext = vi.fn().mockReturnValue("should not be used");
    ({ client, cleanup } = await makeClient(dbPath, { pdfExtractor, pdftotext }));

    const result = parseText(
      await callTool(client, "read_pdf_colophon", { file_path: tmpPdf }),
    ) as {
      isbn_source: string;
      colophon: { isbn_normalized: string; release_date: string; publisher: string };
    };

    expect(result.isbn_source).toBe("pdfjs");
    expect(result.colophon.isbn_normalized).toBe("9784798168494");
    expect(result.colophon.release_date).toBe("2021-06-14");
    expect(pdftotext).not.toHaveBeenCalled();
  });

  it("fills the date and publisher from pdftotext when pdf.js read only the ISBN", async () => {
    // The O'Reilly Japan case: the colophon's Japanese glyphs have no ToUnicode
    // CMap, so pdf.js extracts only the ASCII ISBN / "Printed in Japan" at high
    // confidence, with an empty date and publisher. Poppler reads the whole
    // colophon, so the date and publisher are filled while the pdf.js ISBN
    // (still high confidence) is kept.
    const pdfExtractor = vi.fn().mockResolvedValue({
      text: "索引\nPrinted in Japan（ISBN978-4-87311-903-8）",
      total: 497,
      pages: [],
    });
    const pdftotext = vi.fn().mockReturnValue(
      [
        "2017 年 6 月 13 日 初版第 1 刷発行",
        "2020 年 4 月 17 日 第 2 版第 1 刷発行",
        "発行所 株式会社 オライリー・ジャパン",
        "ISBN978-4-87311-903-8",
        "Printed in Japan",
      ].join("\n"),
    );
    ({ client, cleanup } = await makeClient(dbPath, { pdfExtractor, pdftotext }));

    const result = parseText(
      await callTool(client, "read_pdf_colophon", { file_path: tmpPdf }),
    ) as {
      isbn_source: string;
      colophon: { isbn_normalized: string; release_date: string; publisher: string };
    };

    // ISBN stays from pdf.js; date/publisher come from poppler.
    expect(result.isbn_source).toBe("pdfjs");
    expect(result.colophon.isbn_normalized).toBe("9784873119038");
    expect(result.colophon.release_date).toBe("2020-04-17");
    expect(result.colophon.publisher).toBe("株式会社オライリー・ジャパン");
    expect(pdftotext).toHaveBeenCalledTimes(1);
  });

  it("reports no ISBN when neither pdf.js nor pdftotext can read it", async () => {
    const pdfExtractor = vi.fn().mockResolvedValue({ text: "奥付は画像のみ", total: 100, pages: [] });
    const pdftotext = vi.fn().mockReturnValue(null); // poppler unavailable / empty
    ({ client, cleanup } = await makeClient(dbPath, { pdfExtractor, pdftotext }));

    const result = parseText(
      await callTool(client, "read_pdf_colophon", { file_path: tmpPdf }),
    ) as { isbn_source: string | null; colophon: { isbn: string | null } };

    expect(result.isbn_source).toBeNull();
    expect(result.colophon.isbn).toBeNull();
    expect(pdftotext).toHaveBeenCalledTimes(1);
  });
});
