#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
// pdf-parse is CJS; import via createRequire to avoid its test-file side-effect
// eslint-disable-next-line @typescript-eslint/no-var-requires
const defaultPdfParse = require("pdf-parse/lib/pdf-parse.js") as PdfParser;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PdfParser = (
  data: Buffer,
  options?: { max?: number },
) => Promise<{ text: string; numpages: number }>;

interface BookRow {
  file_path: string;
  file_name: string;
}

interface MetadataRow {
  file_path: string;
  title: string;
  authors_json: string;
  description: string;
  publisher: string;
  release_date: string;
  language: string;
  url: string;
  asin: string;
  cover_url: string;
  updated_at: number | null;
}

export interface CreateServerOptions {
  /** Override the database path (useful for testing). */
  dbPath?: string;
  /** Override the PDF parser (useful for testing). */
  pdfParser?: PdfParser;
}

// ---------------------------------------------------------------------------
// DB path resolution (mirrors Tauri backend logic)
// ---------------------------------------------------------------------------

export function getDbPath(): string {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "riida", "app.db");
  }
  if (process.platform === "win32") {
    return path.join(process.env["APPDATA"] ?? home, "riida", "app.db");
  }
  return path.join(
    process.env["XDG_DATA_HOME"] ?? path.join(home, ".local", "share"),
    "riida",
    "app.db",
  );
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export function createServer(options: CreateServerOptions = {}): Server {
  const dbPath = options.dbPath ?? getDbPath();
  const pdfParse = options.pdfParser ?? defaultPdfParse;

  const server = new Server(
    { name: "riida-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "list_books_needing_metadata",
        description:
          "Lists books in the riida library that are missing title or authors. " +
          "Returns file paths with directory structure useful for metadata inference.",
        inputSchema: {
          type: "object" as const,
          properties: {
            limit: {
              type: "number",
              description: "Max books to return (default 50)",
            },
          },
        },
      },
      {
        name: "get_book_metadata",
        description: "Gets the current stored metadata for a book.",
        inputSchema: {
          type: "object" as const,
          required: ["file_path"],
          properties: {
            file_path: {
              type: "string",
              description: "Absolute path to the PDF file",
            },
          },
        },
      },
      {
        name: "read_pdf_pages",
        description:
          "Extracts plain text from the first N pages of a PDF file. " +
          "Use this to infer title, authors, and publisher from the book content.",
        inputSchema: {
          type: "object" as const,
          required: ["file_path"],
          properties: {
            file_path: {
              type: "string",
              description: "Absolute path to the PDF file",
            },
            max_pages: {
              type: "number",
              description: "Number of pages to read (default 3, max 10)",
            },
          },
        },
      },
      {
        name: "update_book_metadata",
        description:
          "Updates metadata for a book in the riida database. " +
          "Only the fields you provide are changed; omitted fields keep their current values.",
        inputSchema: {
          type: "object" as const,
          required: ["file_path"],
          properties: {
            file_path: { type: "string" },
            title: { type: "string" },
            authors: {
              type: "array",
              items: { type: "string" },
              description: "Author names",
            },
            publisher: { type: "string" },
            release_date: {
              type: "string",
              description: "YYYY-MM-DD",
            },
            description: { type: "string" },
            language: {
              type: "string",
              description: "ISO 639-1 code e.g. 'ja', 'en'",
            },
          },
        },
      },
      {
        name: "get_book_tags",
        description: "Gets the tags for a book.",
        inputSchema: {
          type: "object" as const,
          required: ["file_path"],
          properties: {
            file_path: { type: "string" },
          },
        },
      },
      {
        name: "set_book_tags",
        description:
          "Replaces all tags for a book with the provided list. " +
          "Pass an empty array to remove all tags.",
        inputSchema: {
          type: "object" as const,
          required: ["file_path", "tags"],
          properties: {
            file_path: { type: "string" },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Full list of tags to set",
            },
          },
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // -------------------------------------------------------------------------
    // list_books_needing_metadata
    // -------------------------------------------------------------------------
    if (name === "list_books_needing_metadata") {
      const limit = typeof args?.["limit"] === "number" ? args["limit"] : 50;
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });
      try {
        const rows = db
          .prepare<[number], BookRow>(
            `SELECT b.file_path, b.file_name
             FROM books b
             LEFT JOIN book_metadata m ON b.file_path = m.file_path
             WHERE m.file_path IS NULL
                OR COALESCE(m.title, '') = ''
                OR COALESCE(m.authors_json, '') IN ('', '[]')
             ORDER BY b.file_name
             LIMIT ?`,
          )
          .all(limit);

        const books = rows.map((r) => ({
          file_path: r.file_path,
          file_name: r.file_name,
          directory: path.dirname(r.file_path),
          path_parts: r.file_path.split(path.sep).filter(Boolean),
        }));

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ count: books.length, books }, null, 2),
            },
          ],
        };
      } finally {
        db.close();
      }
    }

    // -------------------------------------------------------------------------
    // get_book_metadata
    // -------------------------------------------------------------------------
    if (name === "get_book_metadata") {
      const filePath = args?.["file_path"] as string;
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });
      try {
        const row = db
          .prepare<[string], MetadataRow>(`SELECT * FROM book_metadata WHERE file_path = ?`)
          .get(filePath);

        if (!row) {
          return {
            content: [
              { type: "text", text: JSON.stringify({ found: false, file_path: filePath }) },
            ],
          };
        }

        const authors: string[] = row.authors_json
          ? (JSON.parse(row.authors_json) as string[])
          : [];

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ found: true, ...row, authors }, null, 2),
            },
          ],
        };
      } finally {
        db.close();
      }
    }

    // -------------------------------------------------------------------------
    // read_pdf_pages
    // -------------------------------------------------------------------------
    if (name === "read_pdf_pages") {
      const filePath = args?.["file_path"] as string;
      const maxPages = Math.min(
        typeof args?.["max_pages"] === "number" ? args["max_pages"] : 3,
        10,
      );

      if (!fs.existsSync(filePath)) {
        return {
          content: [{ type: "text", text: `File not found: ${filePath}` }],
          isError: true,
        };
      }

      const buffer = fs.readFileSync(filePath);
      const data = await pdfParse(buffer, { max: maxPages });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                file_path: filePath,
                total_pages: data.numpages,
                pages_extracted: maxPages,
                // Truncate to avoid flooding the context window
                text: data.text.slice(0, 8000),
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    // -------------------------------------------------------------------------
    // update_book_metadata
    // -------------------------------------------------------------------------
    if (name === "update_book_metadata") {
      const filePath = args?.["file_path"] as string;
      const db = new Database(dbPath, { readonly: false, fileMustExist: true });
      try {
        const existing = db
          .prepare<[string], MetadataRow>(`SELECT * FROM book_metadata WHERE file_path = ?`)
          .get(filePath);

        const pick = <T>(incoming: T | undefined, fallback: T): T =>
          incoming !== undefined ? incoming : fallback;

        const title = pick(args?.["title"] as string | undefined, existing?.title ?? "");
        const authors = pick(
          args?.["authors"] as string[] | undefined,
          existing?.authors_json ? (JSON.parse(existing.authors_json) as string[]) : [],
        );
        const publisher = pick(
          args?.["publisher"] as string | undefined,
          existing?.publisher ?? "",
        );
        const releaseDate = pick(
          args?.["release_date"] as string | undefined,
          existing?.release_date ?? "",
        );
        const description = pick(
          args?.["description"] as string | undefined,
          existing?.description ?? "",
        );
        const language = pick(args?.["language"] as string | undefined, existing?.language ?? "");

        // Preserve untouched fields
        const url = existing?.url ?? "";
        const asin = existing?.asin ?? "";
        const coverUrl = existing?.cover_url ?? "";

        db.prepare(
          `INSERT OR REPLACE INTO book_metadata
           (file_path, title, authors_json, description, publisher,
            release_date, language, url, asin, cover_url, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          filePath,
          title,
          JSON.stringify(authors),
          description,
          publisher,
          releaseDate,
          language,
          url,
          asin,
          coverUrl,
          Date.now(),
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  file_path: filePath,
                  updated: {
                    title,
                    authors,
                    publisher,
                    release_date: releaseDate,
                    description,
                    language,
                  },
                },
                null,
                2,
              ),
            },
          ],
        };
      } finally {
        db.close();
      }
    }

    // -------------------------------------------------------------------------
    // get_book_tags
    // -------------------------------------------------------------------------
    if (name === "get_book_tags") {
      const filePath = args?.["file_path"] as string;
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });
      try {
        const rows = db
          .prepare<[string], { tag: string }>(
            `SELECT tag FROM book_tags WHERE file_path = ? ORDER BY tag`,
          )
          .all(filePath);
        const tags = rows.map((r) => r.tag);
        return {
          content: [
            { type: "text", text: JSON.stringify({ file_path: filePath, tags }, null, 2) },
          ],
        };
      } finally {
        db.close();
      }
    }

    // -------------------------------------------------------------------------
    // set_book_tags
    // -------------------------------------------------------------------------
    if (name === "set_book_tags") {
      const filePath = args?.["file_path"] as string;
      const tags = (args?.["tags"] as string[]).map((t) => t.trim()).filter(Boolean);
      const db = new Database(dbPath, { readonly: false, fileMustExist: true });
      try {
        db.transaction(() => {
          db.prepare(`DELETE FROM book_tags WHERE file_path = ?`).run(filePath);
          const insert = db.prepare(
            `INSERT OR IGNORE INTO book_tags (file_path, tag) VALUES (?, ?)`,
          );
          for (const tag of tags) {
            insert.run(filePath, tag);
          }
        })();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ success: true, file_path: filePath, tags }, null, 2),
            },
          ],
        };
      } finally {
        db.close();
      }
    }

    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
  });

  return server;
}

// ---------------------------------------------------------------------------
// Entry point — only runs when executed directly, not when imported by tests
// ---------------------------------------------------------------------------

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const transport = new StdioServerTransport();
  await createServer().connect(transport);
}
