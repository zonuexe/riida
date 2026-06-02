# Metadata enrichment — detailed rules

Read this before writing metadata. SKILL.md has the workflow; this module has the
judgement details, the safety cases, and troubleshooting.

## MCP prerequisites

Both MCP servers must be connected: **riida** (extract + write) and
**techbook-mcp** (resolve). If a tool seems missing, search for it before assuming
it is unavailable.

## MCP tools

| Server | Tool | Purpose |
|--------|------|---------|
| riida | `read_pdf_colophon` | Read the 奥付 (last pages): ISBN, date, publisher |
| riida | `read_pdf_pages` | Read front-matter text (title/author fallback) |
| riida | `get_book_metadata` | Current stored values for a file |
| riida | `search_books` | Find library books (e.g. `missing_metadata:true`) |
| riida | `list_books_needing_metadata` | List books lacking title/authors |
| riida | `update_books_metadata` | Write metadata (batched) — the only write |
| techbook-mcp | `resolve_book` / `resolve_books` | Resolve ISBN/title → canonical record |
| techbook-mcp | `get_book_by_isbn` | openBD lookup (covers all JP ISBNs) |
| techbook-mcp | `get_book_detail` | Publisher-page detail (descriptions, authors) |
| techbook-mcp | `search_books` / `list_publishers` | Title search; supported publishers |

## When MCP is unavailable (fallback)

- **techbook-mcp down** → degrade gracefully: use riida's `read_pdf_colophon` /
  `read_pdf_pages` to fill what the colophon/front matter provides, and leave the
  rest blank rather than failing.
- **riida MCP down** → the skill cannot run (no way to read or write the library);
  report that and stop.

## Why colophon-first

Japanese books print their authoritative data (ISBN, first-edition date, publisher)
on a colophon (奥付) on the **last** pages. That ISBN is the single best lookup key,
turning a fuzzy title match into a precise ISBN resolve. Front-matter titles and
filenames are fallbacks.

## Resolving

- Prefer **ISBN** — `resolve_book(s)` with the ISBN, or `get_book_by_isbn`. These go
  through openBD, which covers virtually all Japanese ISBNs, so they return the
  canonical title/authors/publisher **even for publishers techbook has no adapter
  for** (e.g. CQ出版) — usually without a description.
- **No ISBN** — resolve by title (+author). ASCII tokens and exact full titles match
  best; pure-Japanese fragments are weaker.
- **Descriptions are publisher-dependent**: oreilly-japan / seshop expose them;
  openBD and some adapters (e.g. gihyo) often don't. Call `get_book_detail(url)` once
  when a description or clean authors are missing; if it still has none, accept that
  and move on — don't keep retrying.

## Decision gate

- **Apply** — `status=matched` AND `confidence=high` AND (`isbnTitleAgree=true`, or no
  ISBN but `matchScore` is high and the title clearly matches). Fill only fields that
  are currently **empty**.
- **Ask first** — before overwriting any non-empty field, and for `confidence`
  medium/low, `status=ambiguous`, `isbnTitleAgree=false`, or `not_found` with only
  colophon data. Show the proposed-vs-current diff and any `candidates`.
- **Skip** — nothing found and no usable colophon data, or free excerpts with no ISBN.
  Say why.

### Worked example — a swapped ISBN caught by the gate
Input: `レガシーソフトウェア改善ガイド.pdf`, colophon ISBN `9784798134208`.
Resolve returns `status=matched` but `isbnTitleAgree=false`, with title
「ガベージコレクション」. The ebook printed another title's ISBN. Do **not** write;
report the conflict and keep the file's own title.

## Field hygiene

- **Authors** — openBD often returns oddly-split tokens
  (`["Boswell","Dustin Foucher","Trevor 角","征典"]`); normalize to real names
  (`["Dustin Boswell","Trevor Foucher","角 征典"]`). If you can't do so confidently,
  keep the existing authors and flag for review rather than write garbled names. When
  the stored authors are a **subset** of the resolved list (a dropped co-author or
  translator), proposing the fuller list is a correction worth surfacing — not a
  silent skip.
- **Title** — include the official subtitle when the publisher lists one; keep the
  edition right (第2版 ≠ 第3版 — the file on disk decides which edition is correct).
- **release_date** — `YYYY-MM-DD`. Prefer the official date, else the colophon date,
  else leave empty. Never invent a day from a year.
- **language** — `"ja"` unless clearly otherwise. Never fabricate any field; omitting
  beats guessing.

## Writing

Use one batched `update_books_metadata` call with an array — never loop single
updates (slower, not atomic). Only included fields change; omitted fields are kept. A
title that exists as both `.epub` and `.pdf` gets identical metadata on both paths.

## Troubleshooting

- **`get_book_metadata` → `found:false`** — the file isn't in an indexed library
  root. It's out of scope; report it rather than writing orphan metadata.
- **`resolve_*` → `not_found`** — try the other key (ISBN ↔ title), then
  `get_book_by_isbn` via openBD. Still nothing → fall back to the colophon/front
  matter alone, or skip.
- **No description anywhere** — expected for some publishers; set the other fields and
  note that the description was unavailable.
- **`isbnTitleAgree=false`** — treat as "needs human eyes"; never auto-apply.

## Report

Summarize at the end: which books were set (and the source — techbook vs colophon),
which were flagged for review (with the reason), and which were skipped.
