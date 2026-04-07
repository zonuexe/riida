import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import Database from "better-sqlite3";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { createServer, type CreateServerOptions } from "./index.js";

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
  options: Pick<CreateServerOptions, "pdfParser"> = {},
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

  it("exposes all 7 tools", async () => {
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("list_books_needing_metadata");
    expect(names).toContain("get_book_metadata");
    expect(names).toContain("read_pdf_pages");
    expect(names).toContain("update_books_metadata");
    expect(names).toContain("search_books");
    expect(names).toContain("get_book_tags");
    expect(names).toContain("set_book_tags");
    expect(names).toHaveLength(7);
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
    const mockParser = vi.fn().mockResolvedValue({ text: "テスト本文", numpages: 100 });
    ({ client, cleanup } = await makeClient(dbPath, { pdfParser: mockParser }));

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
      expect(mockParser).toHaveBeenCalledWith(expect.any(Buffer), { max: 10 });
    } finally {
      fs.unlinkSync(tmpPdf);
    }
  });

  it("defaults max_pages to 3", async () => {
    const mockParser = vi.fn().mockResolvedValue({ text: "本文", numpages: 50 });
    ({ client, cleanup } = await makeClient(dbPath, { pdfParser: mockParser }));

    const tmpPdf = path.join(os.tmpdir(), "dummy-default.pdf");
    fs.writeFileSync(tmpPdf, "dummy");
    try {
      await callTool(client, "read_pdf_pages", { file_path: tmpPdf });
      expect(mockParser).toHaveBeenCalledWith(expect.any(Buffer), { max: 3 });
    } finally {
      fs.unlinkSync(tmpPdf);
    }
  });

  it("truncates extracted text to 8000 characters", async () => {
    const longText = "あ".repeat(10000);
    const mockParser = vi.fn().mockResolvedValue({ text: longText, numpages: 5 });
    ({ client, cleanup } = await makeClient(dbPath, { pdfParser: mockParser }));

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
