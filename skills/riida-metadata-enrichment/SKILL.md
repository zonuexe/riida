---
name: riida-metadata-enrichment
description: >-
  Fill missing or thin book metadata in the riida library by resolving each book
  against techbook-mcp, writing back only confident results.
  USE FOR: enriching, completing, or fixing a riida book's title, authors, publisher,
  release date, or description; ISBN/colophon lookup; batch updates across a directory.
  DO NOT USE FOR: files not indexed by riida; reading book content; web lookups.
  INVOKES: riida extract/write, techbook-mcp resolve.
---

# Riida Metadata Enrichment

Bridge **riida** (extract + write) and **techbook-mcp** (resolve).

## Prerequisites
This skill drives two MCP servers; both must be connected:

| Server | Add to your agent's MCP config | Key tools |
|--------|--------------------------------|-----------|
| riida | `npx -y riida-mcp@latest` | `read_pdf_colophon`, `get_book_metadata`, `search_books`, `update_books_metadata` |
| techbook-mcp | `npx -y @zonuexe/techbook-mcp@latest` | `resolve_book`/`resolve_books`, `get_book_by_isbn`, `get_book_detail` |

The **riida** server reads the riida desktop app's library database, so the app must be
installed and have scanned at least one library root — that is what creates the DB the
server queries (it is located by OS app-data path, not the working directory).
**techbook-mcp** resolves bibliographic records online.

Example `.mcp.json` (or your agent's equivalent):

```json
{
  "mcpServers": {
    "riida":        { "command": "npx", "args": ["-y", "riida-mcp@latest"] },
    "techbook-mcp": { "command": "npx", "args": ["-y", "@zonuexe/techbook-mcp@latest"] }
  }
}
```

If techbook-mcp is unavailable, fall back to colophon-only extraction; if riida is
unavailable, stop.

## Workflow
1. **Scope** — `search_books({directory, missing_metadata:true})` or
   `list_books_needing_metadata`. On a large directory, confirm scope first and exclude
   PDFs that have no single resolvable record: magazine back-issues and per-article
   総集編 splits, `backup/` duplicates, `index.pdf` catalogs. A broad `search_books` can
   exceed the tool-output token limit — narrow it, or run the listing in a subagent.
2. **Extract** — PDF: `read_pdf_colophon` (the colophon ISBN is the best lookup key);
   EPUB: OPF; `get_book_metadata` for current values.
3. **Resolve** — by ISBN (`resolve_book(s)` with isbn **and** title; openBD covers all
   JP ISBNs), else by title. `get_book_detail(url)` for descriptions.
4. **Gate** — apply only at `matched` + `confidence=high` + `isbnTitleAgree=true`,
   filling empty fields. **Verify the returned `book.isbn` equals the ISBN you asked
   for** — a `source:search` fallback can silently return a different edition. Ask first
   before overwriting any non-empty field, and for low/ambiguous /
   `isbnTitleAgree=false` / `not_found`. Skip if nothing found.
5. **Write** — one batched `update_books_metadata` (writable fields: `title`, `authors`,
   `publisher`, `release_date`, `language`, `description` — no url/asin/cover). An
   epub+pdf pair of the same book gets identical metadata.

## Scale: delegate the text-extraction sweep
`read_pdf_colophon` returns the parsed colophon **plus a multi-KB raw-text field**, so a
dozen calls dumped into your context bury the actual decisions under book back-matter.
Split the job by who needs to think: hand the **mechanical extraction** (colophon reads,
broad listings) to a **subagent** that returns only a compact record per book
(`{file_path, isbn, confidence, release_date, publisher}`), and keep **resolution, the
decision gate, and the write** yourself — that is where judgement lives. Never delegate
the `update_books_metadata` write. See rules.md ("Working at scale") for a ready prompt.

## Example
`isbnTitleAgree=false` may be a wrong ISBN (different book → skip) OR a same-book
edition variant (→ re-resolve by title). See rules.md.

See [references/rules.md](references/rules.md) for field hygiene, the full gate, working
at scale, and troubleshooting.
