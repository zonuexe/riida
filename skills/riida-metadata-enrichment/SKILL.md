---
name: riida-metadata-enrichment
description: >-
  Fill in or enrich book metadata in the riida library — title, authors, publisher,
  release date, description — by reading each book's colophon (奥付) and front matter
  and resolving it to a canonical Japanese-tech-book record via the techbook-mcp
  server. Use this whenever the user asks to set, fill, enrich, complete, fix, or look
  up metadata for books in riida (a whole directory, the books that are missing
  metadata, or a specific PDF/EPUB), or mentions 奥付 / ISBN-based lookup / techbook-mcp
  / batch-updating a library's bibliographic info — even if they don't name the tools
  explicitly. Prefer this skill over ad-hoc tool calls so the confidence gating and
  "don't clobber good data" rules are applied consistently.
---

# Riida Metadata Enrichment

Enrich a riida library by bridging two MCP servers. You supply the judgement; the
servers do the mechanical work. The only side effect is the library write, so it is
gated on confidence — getting a wrong author or a swapped ISBN into someone's
permanent library is worse than leaving a field blank.

- **riida** (the app's own server) — extract clues and write:
  `read_pdf_colophon`, `read_pdf_pages`, `get_book_metadata`, `search_books`,
  `list_books_needing_metadata`, `update_books_metadata`.
- **techbook-mcp** — resolve clues to a canonical record:
  `resolve_book` / `resolve_books`, `get_book_by_isbn`, `search_books`,
  `get_book_detail`, `list_publishers`.

If a tool seems missing, search for it before assuming it's unavailable — both
servers must be connected for this skill to work.

## Why colophon-first

Japanese books print their authoritative bibliographic data (ISBN, first-edition
date, publisher) on a colophon (奥付) on the **last** pages. That ISBN is the single
best key for an exact lookup, so reading it first turns a fuzzy title-match problem
into a precise ISBN-resolve. Front-matter titles and filenames are fallbacks.

## Workflow

### 1. Find the targets
A user-named directory or file, or the whole library. Use
`search_books({ directory, missing_metadata: true })` or
`list_books_needing_metadata` for gaps. Also treat books that have a title but no
`description` / `release_date` as enrichable. If `get_book_metadata` returns
`found:false` for a path, that file isn't in an indexed library root — it's out of
scope; report it rather than writing orphan metadata.

### 2. Extract clues
- PDFs: `read_pdf_colophon` — prefer the colophon ISBN; note `release_date`,
  `publisher`, `isbn_source`. Use `read_pdf_pages` for a front-matter title/author
  when the colophon is thin.
- EPUBs: `read_pdf_colophon` is PDF-only — read the OPF metadata (unzip the `.opf`)
  or use the filename as the title clue.
- `get_book_metadata(file_path)` to see what's already stored. You fill gaps; you do
  not overwrite good values without asking.

### 3. Resolve via techbook-mcp
- Prefer **ISBN** (most precise): `resolve_book` / `resolve_books` with the ISBN, or
  `get_book_by_isbn`. Batch many books with `resolve_books`.
- No ISBN: resolve by **title (+author)**. ASCII tokens and exact full titles match
  best; pure-Japanese fragments are weaker.
- When a resolve result lacks the `description` or has split author names, call
  `get_book_detail(url)` — the publisher page often has the clean description and
  author list. But descriptions are **publisher-dependent**: oreilly-japan / seshop
  expose them; openBD and some adapters (e.g. gihyo) frequently don't. If neither
  resolve nor detail returns one, accept that and move on — don't keep retrying.
- Unsupported publisher (not in `list_publishers`; e.g. CQ出版): you can **still
  resolve by ISBN**. `get_book_by_isbn` / `resolve_book(isbn)` go through openBD,
  which covers virtually all Japanese ISBNs, so they return the canonical
  title/authors/publisher even with no publisher adapter (usually without a
  description). Only fall back to colophon/front-matter alone when there is no ISBN
  or openBD has nothing.

### 4. Decide per book (confidence gate)
- **Apply** when `status="matched"` AND `confidence="high"` AND
  (`validation.isbnTitleAgree=true`, or there's no ISBN but `matchScore` is high and
  the title clearly matches). Fill **only fields that are currently empty**.
- **Ask first** before overwriting any non-empty field, and for `confidence`
  medium/low, `status="ambiguous"`, `isbnTitleAgree=false`, or `not_found` with only
  colophon data. Show the proposed-vs-current diff and any `candidates`; let the user
  choose.
- **Skip** when nothing is found and there's no usable colophon data, or for free
  excerpts with no ISBN. Say why.

`isbnTitleAgree=false` is a real safety signal, not noise — an ebook can print
another title's ISBN. Treat it as "needs human eyes," never auto-apply.

**Example — caught a swapped ISBN:**
Input: `レガシーソフトウェア改善ガイド.pdf`, colophon ISBN `9784798134208`
Resolve: `status=matched`, `isbnTitleAgree=false`, returns title「ガベージコレクション」
Action: do **not** write; report the conflict and keep the file's own title.

### 5. Write back
- One **batched** `update_books_metadata` call with an array — never loop single
  updates (it's slower and not atomic). Only included fields change; omitted fields
  are preserved.
- A title that exists as both `.epub` and `.pdf` gets **identical** metadata on both
  paths.

## Field hygiene
- **Authors**: openBD often returns oddly-split tokens (e.g.
  `["Boswell","Dustin Foucher","Trevor 角","征典"]`). Normalize to real names
  (`["Dustin Boswell","Trevor Foucher","角 征典"]`). If you can't do so confidently,
  keep the existing authors and flag for review rather than write garbled names.
  When the stored authors are a **subset** of the resolved authoritative list (an
  incomplete entry — e.g. a co-author or translator was dropped), proposing the
  fuller list is a correction worth surfacing for quick approval, not a silent skip.
- **Title**: include the official subtitle when the publisher lists one; keep the
  edition right (第2版 ≠ 第3版 — the file on disk dictates which edition is correct).
- **release_date**: `YYYY-MM-DD`. Prefer the official date, else the colophon date,
  else leave empty. Never invent a day from a year.
- **language**: `"ja"` unless clearly otherwise. Never fabricate any field — omitting
  is always better than guessing.

## Report
Summarize at the end: which books were set (and the source — techbook vs colophon),
which were flagged for review (with the reason), and which were skipped. This lets the
user trust what changed and act on the flagged ones.

## Quick checklist
- Targets identified (directory / missing-metadata / thin records).
- Clues extracted (colophon ISBN first; OPF for EPUB).
- Resolved via techbook (ISBN-first; `get_book_detail` for descriptions/authors).
- Confidence gate applied; `isbnTitleAgree=false` and overwrites confirmed first.
- Written in one batched `update_books_metadata`; epub+pdf pairs kept in sync.
- Result reported (set / review / skipped).
