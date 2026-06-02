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
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
// pdf-parse is CJS; import via createRequire to avoid its test-file side-effect
// eslint-disable-next-line @typescript-eslint/no-var-requires
const defaultPdfParse = require("pdf-parse/lib/pdf-parse.js") as PdfParser;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal shape of the pdf.js page object pdf-parse hands to `pagerender`. */
interface PdfPageData {
  pageNumber: number;
  getTextContent: (
    options?: unknown,
  ) => Promise<{ items: Array<{ str: string; transform: number[] }> }>;
}

interface PdfParseOptions {
  /** Stop after this many leading pages. `pdf-parse` default (0) reads all. */
  max?: number;
  /** Per-page render hook; lets us capture text page-by-page (for the tail). */
  pagerender?: (pageData: PdfPageData) => string | Promise<string>;
}

type PdfParser = (
  data: Buffer,
  options?: PdfParseOptions,
) => Promise<{ text: string; numpages: number }>;

/**
 * Extracts text from a page range of a PDF using an external engine, or returns
 * null when no such engine is available. Used as a fallback for colophons that
 * pdf.js cannot read (fonts without a ToUnicode CMap), which poppler can.
 */
type PdftotextExtractor = (
  filePath: string,
  fromPage: number,
  toPage: number,
) => string | null;

interface BookRow {
  file_path: string;
  file_name: string;
}

interface SearchBookRow {
  file_path: string;
  file_name: string;
  title: string;
  authors_json: string;
  publisher: string;
  language: string;
  release_date: string;
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
  /** Override the pdftotext fallback (useful for testing). */
  pdftotext?: PdftotextExtractor;
}

/** Candidate `pdftotext` locations, tried in order (PATH first, then Homebrew). */
const PDFTOTEXT_BINARIES = [
  "pdftotext",
  "/opt/homebrew/bin/pdftotext",
  "/usr/local/bin/pdftotext",
  "/usr/bin/pdftotext",
];

/**
 * Default pdftotext fallback: shell out to poppler's `pdftotext` for a page
 * range. Returns null when poppler is not installed (so the tool degrades to
 * pdf.js-only) or extraction fails.
 */
function defaultPdftotext(
  filePath: string,
  fromPage: number,
  toPage: number,
): string | null {
  for (const bin of PDFTOTEXT_BINARIES) {
    const result = spawnSync(
      bin,
      // `-layout` preserves the colophon's spatial table so each date stays on
      // the same line as its 第N版第N刷 label and each 発行所/発売元 label stays
      // beside its company. In plain reading order, multi-column colophons (e.g.
      // O'Reilly Japan) emit all dates first and all labels after, which decouples
      // a date from its edition.
      ["-q", "-layout", "-f", String(fromPage), "-l", String(toPage), filePath, "-"],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    if (result.error) {
      // Not found at this location — try the next candidate.
      if ((result.error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return null;
    }
    return result.status === 0 && typeof result.stdout === "string"
      ? result.stdout
      : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// DB path resolution (mirrors Tauri backend logic)
// ---------------------------------------------------------------------------

/** Tauri bundle identifier — must match src-tauri/tauri.conf.json */
const TAURI_IDENTIFIER = "me.zonu.riida";

export function getDbPath(): string {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", TAURI_IDENTIFIER, "app.db");
  }
  if (process.platform === "win32") {
    return path.join(process.env["APPDATA"] ?? home, TAURI_IDENTIFIER, "app.db");
  }
  return path.join(
    process.env["XDG_DATA_HOME"] ?? path.join(home, ".local", "share"),
    TAURI_IDENTIFIER,
    "app.db",
  );
}

// ---------------------------------------------------------------------------
// Colophon (奥付) parsing — pure helpers, unit-tested independently
// ---------------------------------------------------------------------------
//
// Japanese books carry their bibliographic data on a colophon page (奥付) at
// the very end of the volume. It reliably contains the ISBN, the first-edition
// publication date, and the publisher. We read the last few pages and parse it.
//
// The hard case is books whose back matter advertises *other* titles: those ad
// pages list many foreign ISBNs. The book's own ISBN is distinguished by the
// Japanese C-code (e.g. `C3055`) that follows it and by sitting next to
// colophon keywords (発行所 / Printed in Japan), which the scoring below uses.

/** Hyphen, en/em dashes, minus sign, and fullwidth hyphen used as ISBN separators. */
const ISBN_SEP = "\\-\\u2010-\\u2015\\u2212\\uFF0D";

/** Keywords that mark the real colophon block (used to score ISBN candidates). */
const COLOPHON_KEYWORDS = [
  "発行所",
  "発売元",
  "発行者",
  "発行日",
  "発行",
  "初版",
  "刷発行",
  "印刷",
  "製本",
  "Printed in Japan",
  "定価",
  "本体",
];

export interface IsbnCandidate {
  /** ISBN as printed, separators preserved, e.g. "978-4-86354-244-0". */
  raw: string;
  /** Digits only (plus a trailing X), e.g. "9784863542440". */
  normalized: string;
  /** Whether the ISBN-10/13 check digit is valid. */
  valid: boolean;
  /** Japanese C-code immediately following the ISBN, e.g. "C3055", else null. */
  cCode: string | null;
  /** Character offset of the match within the source text. */
  index: number;
}

export interface ParsedColophon {
  /** Best ISBN as printed, or null when none could be extracted. */
  isbn: string | null;
  /** Best ISBN reduced to digits (and trailing X), or null. */
  isbn_normalized: string | null;
  /** Whether the chosen ISBN's check digit validates. */
  isbn_valid: boolean;
  /**
   * Confidence that the chosen ISBN is the book's own (vs. an advertised
   * title). "high" when it carries a C-code or sits next to colophon keywords;
   * "low" when it was the best of several distant candidates (e.g. a back-cover
   * ad list, with the real colophon being image-only). "none" when no ISBN.
   */
  isbn_confidence: "high" | "low" | "none";
  /** C-code of the chosen ISBN, e.g. "C3055", or null. */
  c_code: string | null;
  /** First-edition publication date as YYYY-MM-DD, or "" when not found. */
  release_date: string;
  /** Best-effort publisher name, or "" when not found. */
  publisher: string;
  /** Whether the colophon carries a "Printed in Japan" marker. */
  printed_in_japan: boolean;
  /** Every ISBN-like token found, in document order. */
  isbn_candidates: IsbnCandidate[];
}

/** Convert fullwidth digits (０-９) to ASCII so date/number parsing is uniform. */
function toHalfWidthDigits(text: string): string {
  return text.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
}

/** Reduce a raw ISBN run to digits plus an optional trailing X. */
export function normalizeIsbn(raw: string): string {
  return raw.replace(/[^0-9Xx]/g, "").toUpperCase();
}

/** Validate an ISBN-10 or ISBN-13 check digit. */
export function isValidIsbn(normalized: string): boolean {
  if (/^\d{13}$/.test(normalized)) {
    let sum = 0;
    for (let i = 0; i < 13; i++) {
      sum += Number(normalized[i]) * (i % 2 === 0 ? 1 : 3);
    }
    return sum % 10 === 0;
  }
  if (/^\d{9}[\dX]$/.test(normalized)) {
    let sum = 0;
    for (let i = 0; i < 10; i++) {
      const c = normalized[i];
      sum += (c === "X" ? 10 : Number(c)) * (10 - i);
    }
    return sum % 11 === 0;
  }
  return false;
}

/**
 * Find every ISBN-like token in colophon text.
 *
 * Requires the literal `ISBN` prefix (avoids matching phone numbers, prices,
 * and order codes). The digit run is allowed to span line breaks, because
 * pdf.js often splits a colophon ISBN across artificial lines when the glyphs
 * are placed individually (e.g. O'Reilly Japan's vertical-layout colophons
 * render "ISBN978\n4\n87311\n..."). To avoid swallowing a trailing date or
 * price into the run, we keep the first valid 13- or 10-digit ISBN found as a
 * prefix of the collected digits rather than requiring the whole run to be a
 * clean ISBN.
 */
export function extractIsbnCandidates(text: string): IsbnCandidate[] {
  const runClass = new RegExp(`^[0-9Xx \\t\\r\\n${ISBN_SEP}]{0,40}`);
  const isSep = new RegExp(`[${ISBN_SEP}]`);
  const out: IsbnCandidate[] = [];
  const prefix = /ISBN[\s:：]*/gi;

  for (let pm = prefix.exec(text); pm !== null; pm = prefix.exec(text)) {
    const runStart = pm.index + pm[0].length;
    const run = (text.slice(runStart, runStart + 60).match(runClass) ?? [""])[0];
    const compact = run.replace(/[^0-9Xx]/g, "").toUpperCase();

    const try13 = /^(?:978|979)\d{10}/.test(compact) ? compact.slice(0, 13) : null;
    const try10 = /^\d{9}[\dX]/.test(compact) ? compact.slice(0, 10) : null;
    let normalized: string | null = null;
    let digitCount = 0;
    // Accept when the check digit validates, or when the run is exactly that
    // length (clean, uncontaminated) so a rare bad check digit still surfaces.
    if (try13 !== null && (isValidIsbn(try13) || compact.length === 13)) {
      normalized = try13;
      digitCount = 13;
    } else if (try10 !== null && (isValidIsbn(try10) || compact.length === 10)) {
      normalized = try10;
      digitCount = 10;
    }
    if (normalized === null) continue;

    // Reconstruct the printed form (separators kept, whitespace dropped) and
    // find where the ISBN's digits end within the source text.
    let seen = 0;
    let raw = "";
    let consumed = 0;
    for (const ch of run) {
      consumed++;
      if (/[0-9Xx]/.test(ch)) {
        raw += ch;
        if (++seen === digitCount) break;
      } else if (isSep.test(ch)) {
        raw += ch;
      }
    }
    // Optional Japanese C-code immediately following the ISBN (own-book marker).
    const after = text.slice(runStart + consumed, runStart + consumed + 12);
    const cMatch = after.match(/^[ \t\r\n]*(C\d{4})/);

    out.push({
      raw,
      normalized,
      valid: isValidIsbn(normalized),
      cCode: cMatch ? cMatch[1].toUpperCase() : null,
      index: pm.index,
    });
    prefix.lastIndex = runStart + consumed;
  }
  return out;
}

/**
 * Pick the book's own ISBN from the candidates.
 *
 * Scores each by the strongest signal first — a trailing C-code (the Japanese
 * own-book marker), then a valid check digit, then nearness to colophon
 * keywords. Ties break toward the later occurrence, since a book's own colophon
 * follows any advertised-titles pages.
 */
/** Offsets of every colophon keyword occurrence in the text. */
function colophonKeywordPositions(text: string): number[] {
  const positions: number[] = [];
  for (const kw of COLOPHON_KEYWORDS) {
    for (let i = text.indexOf(kw); i !== -1; i = text.indexOf(kw, i + kw.length)) {
      positions.push(i);
    }
  }
  return positions;
}

/** Distance from `index` to the nearest colophon keyword (Infinity if none). */
function nearestKeywordDistance(index: number, positions: number[]): number {
  let nearest = Infinity;
  for (const p of positions) nearest = Math.min(nearest, Math.abs(p - index));
  return nearest;
}

export function chooseBestIsbn(
  candidates: IsbnCandidate[],
  text: string,
): IsbnCandidate | null {
  if (candidates.length === 0) return null;

  const keywordPositions = colophonKeywordPositions(text);

  const score = (c: IsbnCandidate): number => {
    let s = 0;
    if (c.cCode) s += 100;
    if (c.valid) s += 15;
    const nearest = nearestKeywordDistance(c.index, keywordPositions);
    if (nearest !== Infinity) s += Math.max(0, 50 - nearest / 30);
    return s;
  };

  let best = candidates[0];
  let bestScore = score(best);
  for (const c of candidates.slice(1)) {
    const s = score(c);
    if (s > bestScore || (s === bestScore && c.index >= best.index)) {
      best = c;
      bestScore = s;
    }
  }
  return best;
}

/** A colophon date plus the edition/printing label that follows it. */
interface DatedPrinting {
  y: number;
  m: number;
  d: number;
  /** 1 for 初版, N for 第N版, or null when no edition marker follows the date. */
  edition: number | null;
  /** N for 第N刷, or null when no printing marker follows the date. */
  printing: number | null;
  /** True when the label carries 改訂 / 増補 / 新版 (a later revision). */
  revision: boolean;
}

/**
 * Extract the publication date as YYYY-MM-DD.
 *
 * A colophon prints the whole printing history — e.g. a 第2版 book lists
 * 初版第1刷, 第2版第1刷, 第2版第2刷. The date we want is the FIRST printing of
 * the LATEST edition present (that is the edition this file actually is), so a
 * second-edition book reports its 第2版 date, not the original 初版 date. With
 * no edition markers we fall back to the earliest non-reprint date.
 *
 * The matcher tolerates whitespace between every glyph because pdf.js renders
 * vertical-layout colophons (e.g. O'Reilly Japan) one glyph per line, splitting
 * a single date into `2\n0\n2\n0\n年\n4\n月…`. The same whitespace stripping is
 * applied to the trailing edition/printing label.
 */
export function parseColophonDate(text: string): string {
  const t = toHalfWidthDigits(text);
  const re =
    /((?:1\s*9|2\s*0)(?:\s*\d){2})\s*年\s*((?:\d\s*){1,2})月\s*((?:\d\s*){1,2})日/g;
  const matches: { y: number; m: number; d: number; index: number; end: number }[] = [];
  for (let m = re.exec(t); m !== null; m = re.exec(t)) {
    const y = Number(m[1].replace(/\s/g, ""));
    const mo = Number(m[2].replace(/\s/g, ""));
    const d = Number(m[3].replace(/\s/g, ""));
    if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
    matches.push({ y, m: mo, d, index: m.index, end: m.index + m[0].length });
  }
  if (matches.length === 0) return "";

  // Classify each date by the label that follows it, up to the next date (or a
  // short window for the last one). Whitespace is stripped so glyph-split
  // labels like "第\n2\n版第\n1\n刷" are still recognized.
  const entries: DatedPrinting[] = matches.map((cur, i) => {
    const stop = i + 1 < matches.length ? matches[i + 1].index : cur.end + 40;
    const label = t.slice(cur.end, stop).replace(/\s/g, "");
    let edition: number | null = /初版/.test(label) ? 1 : null;
    const versionMatch = label.match(/第(\d+)版/);
    if (versionMatch) edition = Math.max(edition ?? 0, Number(versionMatch[1]));
    const printingMatch = label.match(/第(\d+)刷/);
    return {
      y: cur.y,
      m: cur.m,
      d: cur.d,
      edition,
      printing: printingMatch ? Number(printingMatch[1]) : null,
      revision: /(改訂|増補|新版)/.test(label),
    };
  });

  const editions = entries
    .map((e) => e.edition)
    .filter((v): v is number => v !== null);

  let pool = entries;
  if (editions.length > 0) {
    const targetEdition = Math.max(...editions);
    pool = entries.filter((e) => e.edition === targetEdition);
    const firstPrinting = pool.filter((e) => e.printing === 1);
    const unnumbered = pool.filter((e) => e.printing === null);
    // Prefer an explicit 第1刷; else printings with no number; else earliest.
    if (firstPrinting.length > 0) pool = firstPrinting;
    else if (unnumbered.length > 0) pool = unnumbered;
  } else {
    // No edition markers: drop later reprints (第N刷, N≥2) and revisions.
    const base = entries.filter((e) => !(e.printing !== null && e.printing >= 2) && !e.revision);
    if (base.length > 0) pool = base;
  }

  const pick = pool.reduce((a, b) =>
    b.y < a.y || (b.y === a.y && (b.m < a.m || (b.m === a.m && b.d < a.d))) ? b : a,
  );
  const mm = String(pick.m).padStart(2, "0");
  const dd = String(pick.d).padStart(2, "0");
  return `${pick.y}-${mm}-${dd}`;
}

/**
 * Best-effort publisher name: the first 株式会社 / 有限会社 / 合同会社 company
 * token at or after the first colophon keyword. Returns "" when uncertain —
 * callers should cross-check against the raw colophon text.
 */
export function parseColophonPublisher(text: string): string {
  // Only trust a company name found in a short window right after a publisher
  // keyword. Searching the whole text would match the company name embedded in
  // the copyright boilerplate ("…研究所に無断で複写…") and pull in running text.
  const company = /(株式会社|有限会社|合同会社)[ \t\n]?([^\s\n、。）)】]{1,24})/;
  for (const kw of ["発行所", "発売元", "発行者", "発行"]) {
    // pdftotext -layout pads colophon labels with spaces (発   行    所), and
    // pdf.js vertical layouts split them across lines, so match the keyword with
    // optional whitespace between its characters. A wider window then clears the
    // gap to the company name.
    const kwRe = new RegExp(kw.split("").join("\\s*"));
    const km = kwRe.exec(text);
    if (km === null) continue;
    const m = text.slice(km.index, km.index + 80).match(company);
    if (m !== null) return `${m[1]}${m[2]}`;
  }
  return "";
}

/** Parse a colophon text block into structured bibliographic fields. */
export function parseColophon(text: string): ParsedColophon {
  const candidates = extractIsbnCandidates(text);
  const best = chooseBestIsbn(candidates, text);

  let confidence: "high" | "low" | "none" = "none";
  if (best !== null) {
    const dist = nearestKeywordDistance(best.index, colophonKeywordPositions(text));
    // High when: a C-code marks it as the book's own; or it sits inside the
    // colophon block (near a keyword); or it is the sole ISBN in the tail (so
    // there is nothing to confuse it with — e.g. Ohmsha colophons that extract
    // no keywords at all). "low" is reserved for the genuinely ambiguous case:
    // several candidates, none carrying a C-code or sitting near the colophon —
    // typically a back-matter ad list when the real colophon is image-only.
    confidence =
      best.cCode !== null || candidates.length === 1 || dist <= 200
        ? "high"
        : "low";
  }

  return {
    isbn: best ? best.raw : null,
    isbn_normalized: best ? best.normalized : null,
    isbn_valid: best ? best.valid : false,
    isbn_confidence: confidence,
    c_code: best ? best.cCode : null,
    release_date: parseColophonDate(text),
    publisher: parseColophonPublisher(text),
    printed_in_japan: /Printed\s+in\s+Japan/i.test(text),
    isbn_candidates: candidates,
  };
}

/**
 * pdf-parse `pagerender` hook that captures each page's text into `sink` keyed
 * by 1-based page number. Mirrors pdf-parse's default line-break logic (a new
 * line whenever the text item's Y coordinate changes). Returns "" so pdf-parse
 * does not also build a giant concatenated `data.text` we would discard.
 */
async function renderColophonPage(
  pageData: PdfPageData,
  sink: Map<number, string>,
): Promise<string> {
  const content = await pageData.getTextContent({
    normalizeWhitespace: false,
    disableCombineTextItems: false,
  });
  let lastY: number | undefined;
  let text = "";
  for (const item of content.items) {
    const y = item.transform[5];
    if (lastY === undefined || lastY === y) {
      text += item.str;
    } else {
      text += `\n${item.str}`;
    }
    lastY = y;
  }
  sink.set(pageData.pageNumber, text);
  return "";
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export function createServer(options: CreateServerOptions = {}): Server {
  const dbPath = options.dbPath ?? getDbPath();
  const pdfParse = options.pdfParser ?? defaultPdfParse;
  const pdftotext = options.pdftotext ?? defaultPdftotext;

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
        name: "read_pdf_colophon",
        description:
          "Extracts the colophon (奥付) from the LAST pages of a PDF and parses its " +
          "bibliographic data. Best for Japanese books, which print the ISBN, " +
          "first-edition date, and publisher on a final colophon page. Returns the " +
          "detected ISBN (own-book ISBN chosen via its C-code and colophon proximity, " +
          "so advertised foreign ISBNs are not mistaken for it), release_date, " +
          "publisher, all ISBN candidates, and the raw tail text for cross-checking.",
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
              description: "Number of trailing pages to read (default 8, max 15)",
            },
          },
        },
      },
      {
        name: "update_books_metadata",
        description:
          "Updates metadata for one or more books in a single atomic transaction. " +
          "Pass an array of book objects — only the fields you include are changed; omitted fields keep their current values. " +
          "Always use this instead of calling update_book_metadata in a loop.",
        inputSchema: {
          type: "object" as const,
          required: ["books"],
          properties: {
            books: {
              type: "array",
              description: "List of books to update",
              items: {
                type: "object",
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
          },
        },
      },
      {
        name: "search_books",
        description:
          "Lists books matching the given filters (all combined with AND). " +
          "Omit a filter to leave it unrestricted. " +
          "Returns basic metadata alongside the file path.",
        inputSchema: {
          type: "object" as const,
          properties: {
            directory: {
              type: "string",
              description: "Only books whose path starts with this directory",
            },
            path_contains: {
              type: "string",
              description: "Only books whose file path contains this string",
            },
            title_contains: {
              type: "string",
              description: "Only books whose title contains this string (case-insensitive)",
            },
            author_contains: {
              type: "string",
              description: "Only books whose author list contains this string (case-insensitive)",
            },
            tag: {
              type: "string",
              description: "Only books that have exactly this tag",
            },
            missing_metadata: {
              type: "boolean",
              description: "If true, only books missing title or authors",
            },
            limit: {
              type: "number",
              description: "Max results to return (default 50)",
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
    // read_pdf_colophon
    // -------------------------------------------------------------------------
    if (name === "read_pdf_colophon") {
      const filePath = args?.["file_path"] as string;
      const requested =
        typeof args?.["max_pages"] === "number" ? args["max_pages"] : 8;
      const tailPages = Math.min(Math.max(requested, 1), 15);

      if (!fs.existsSync(filePath)) {
        return {
          content: [{ type: "text", text: `File not found: ${filePath}` }],
          isError: true,
        };
      }

      const buffer = fs.readFileSync(filePath);
      const pageTexts = new Map<number, string>();
      // No `max`: pdf-parse has no start-page, so the whole document is parsed
      // and pages are captured page-by-page; we then keep only the tail.
      const data = await pdfParse(buffer, {
        pagerender: (pageData) => renderColophonPage(pageData, pageTexts),
      });

      const totalPages = data.numpages;
      let tailText: string;
      let tailPagesRead: number | null;
      if (pageTexts.size > 0) {
        const from = Math.max(1, totalPages - tailPages + 1);
        const parts: string[] = [];
        for (let p = from; p <= totalPages; p++) {
          const t = pageTexts.get(p);
          if (t) parts.push(t);
        }
        tailText = parts.join("\n\n");
        tailPagesRead = Math.min(tailPages, totalPages);
      } else {
        // pagerender was not invoked (e.g. an injected mock parser): fall back
        // to whatever full text the parser returned.
        tailText = data.text ?? "";
        tailPagesRead = null;
      }

      let colophon = parseColophon(tailText);
      let isbnSource: "pdfjs" | "pdftotext" | null = colophon.isbn ? "pdfjs" : null;
      let reportedText = tailText;

      // Some colophons (fonts without a ToUnicode CMap) yield little usable text
      // in pdf.js but read cleanly in poppler. O'Reilly Japan is the common case:
      // its colophon ISBN and "Printed in Japan" are ASCII and survive, while the
      // Japanese 発行日 / 発行所 do not — so pdf.js reports a high-confidence ISBN
      // yet an empty date and publisher. Re-read with pdftotext whenever ANY of
      // {ISBN, release_date, publisher} is missing (not just the ISBN), then take
      // from poppler only the fields pdf.js could not read.
      const needsIsbn = colophon.isbn === null || colophon.isbn_confidence === "low";
      const needsDate = colophon.release_date === "";
      const needsPublisher = colophon.publisher === "";
      if (needsIsbn || needsDate || needsPublisher) {
        const from = Math.max(1, totalPages - tailPages + 1);
        const fallbackText = pdftotext(filePath, from, totalPages);
        if (fallbackText !== null && fallbackText.trim() !== "") {
          const fb = parseColophon(fallbackText);
          // Adopt poppler's ISBN only when it strictly improves on pdf.js: it
          // filled a missing ISBN, or upgraded a low-confidence one to high.
          const isbnImproves =
            fb.isbn !== null &&
            (colophon.isbn === null ||
              (fb.isbn_confidence === "high" && colophon.isbn_confidence !== "high"));
          if (isbnImproves) {
            colophon = {
              ...fb,
              // Keep any fields pdf.js managed to read if poppler left them blank.
              release_date: fb.release_date || colophon.release_date,
              publisher: fb.publisher || colophon.publisher,
              printed_in_japan: fb.printed_in_japan || colophon.printed_in_japan,
            };
            isbnSource = "pdftotext";
            reportedText = fallbackText;
          } else if (
            (needsDate && fb.release_date !== "") ||
            (needsPublisher && fb.publisher !== "")
          ) {
            // Keep pdf.js's ISBN, but fill the blanks poppler could read. The
            // reported text switches to poppler's so the date/publisher are
            // cross-checkable against the same source they came from.
            if (needsDate && fb.release_date !== "") colophon.release_date = fb.release_date;
            if (needsPublisher && fb.publisher !== "") colophon.publisher = fb.publisher;
            if (!colophon.printed_in_japan && fb.printed_in_japan) {
              colophon.printed_in_japan = true;
            }
            reportedText = fallbackText;
          }
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                file_path: filePath,
                total_pages: totalPages,
                tail_pages_read: tailPagesRead,
                // Which engine produced the chosen ISBN: "pdfjs", "pdftotext"
                // (poppler fallback), or null when no ISBN was found.
                isbn_source: isbnSource,
                colophon,
                // Raw tail text for cross-checking; truncated to spare context.
                text: reportedText.slice(0, 8000),
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    // -------------------------------------------------------------------------
    // search_books
    // -------------------------------------------------------------------------
    if (name === "search_books") {
      const limit = typeof args?.["limit"] === "number" ? args["limit"] : 50;
      const directory     = args?.["directory"]      as string | undefined;
      const pathContains  = args?.["path_contains"]  as string | undefined;
      const titleContains = args?.["title_contains"] as string | undefined;
      const authorContains = args?.["author_contains"] as string | undefined;
      const tag           = args?.["tag"]            as string | undefined;
      const missingMeta   = args?.["missing_metadata"] as boolean | undefined;

      const conditions: string[] = [];
      const params: unknown[] = [];

      if (directory !== undefined) {
        const dir = directory.replace(/\/+$/, "");
        conditions.push("b.file_path LIKE ?");
        params.push(dir + "/%");
      }
      if (pathContains !== undefined) {
        conditions.push("b.file_path LIKE ?");
        params.push("%" + pathContains + "%");
      }
      if (titleContains !== undefined) {
        conditions.push("COALESCE(m.title, '') LIKE ? ESCAPE '\\'");
        params.push("%" + titleContains.replace(/[%_\\]/g, "\\$&") + "%");
      }
      if (authorContains !== undefined) {
        conditions.push("COALESCE(m.authors_json, '') LIKE ? ESCAPE '\\'");
        params.push("%" + authorContains.replace(/[%_\\]/g, "\\$&") + "%");
      }
      if (tag !== undefined) {
        conditions.push(
          "EXISTS (SELECT 1 FROM book_tags t WHERE t.file_path = b.file_path AND t.tag = ?)",
        );
        params.push(tag);
      }
      if (missingMeta === true) {
        conditions.push(
          "(m.file_path IS NULL OR COALESCE(m.title, '') = '' OR COALESCE(m.authors_json, '') IN ('', '[]'))",
        );
      }

      const where = conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";
      params.push(limit);

      const db = new Database(dbPath, { readonly: true, fileMustExist: true });
      try {
        const rows = db
          .prepare<unknown[], SearchBookRow>(
            `SELECT b.file_path,
                    b.file_name,
                    COALESCE(m.title, '')        AS title,
                    COALESCE(m.authors_json, '[]') AS authors_json,
                    COALESCE(m.publisher, '')    AS publisher,
                    COALESCE(m.language, '')     AS language,
                    COALESCE(m.release_date, '') AS release_date
             FROM books b
             LEFT JOIN book_metadata m ON b.file_path = m.file_path
             ${where}
             ORDER BY b.file_name
             LIMIT ?`,
          )
          .all(...params);

        const books = rows.map((r) => ({
          file_path:    r.file_path,
          file_name:    r.file_name,
          directory:    path.dirname(r.file_path),
          title:        r.title,
          authors:      r.authors_json ? (JSON.parse(r.authors_json) as string[]) : [],
          publisher:    r.publisher,
          language:     r.language,
          release_date: r.release_date,
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
    // update_books_metadata
    // -------------------------------------------------------------------------
    if (name === "update_books_metadata") {
      type BookInput = {
        file_path: string;
        title?: string;
        authors?: string[];
        publisher?: string;
        release_date?: string;
        description?: string;
        language?: string;
      };

      const books = args?.["books"] as BookInput[] | undefined;
      if (!Array.isArray(books) || books.length === 0) {
        return {
          content: [
            { type: "text", text: JSON.stringify({ error: "books must be a non-empty array" }) },
          ],
          isError: true,
        };
      }

      const db = new Database(dbPath, { readonly: false, fileMustExist: true });
      db.pragma("busy_timeout = 5000");
      try {
        const getExisting = db.prepare<[string], MetadataRow>(
          `SELECT * FROM book_metadata WHERE file_path = ?`,
        );
        const upsert = db.prepare(
          `INSERT OR REPLACE INTO book_metadata
           (file_path, title, authors_json, description, publisher,
            release_date, language, url, asin, cover_url, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );

        const pick = <T>(incoming: T | undefined, fallback: T): T =>
          incoming !== undefined ? incoming : fallback;

        const results: Array<{ file_path: string; updated: object }> = [];

        db.transaction(() => {
          for (const book of books) {
            const filePath = book.file_path;
            const existing = getExisting.get(filePath);

            const title = pick(book.title, existing?.title ?? "");
            const authors = pick(
              book.authors,
              existing?.authors_json ? (JSON.parse(existing.authors_json) as string[]) : [],
            );
            const publisher = pick(book.publisher, existing?.publisher ?? "");
            const releaseDate = pick(book.release_date, existing?.release_date ?? "");
            const description = pick(book.description, existing?.description ?? "");
            const language = pick(book.language, existing?.language ?? "");

            // Preserve fields not managed by this tool
            const url = existing?.url ?? "";
            const asin = existing?.asin ?? "";
            const coverUrl = existing?.cover_url ?? "";

            upsert.run(
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

            results.push({
              file_path: filePath,
              updated: { title, authors, publisher, release_date: releaseDate, description, language },
            });
          }
        })();

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ success: true, count: results.length, results }, null, 2),
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
      db.pragma("busy_timeout = 5000");
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
