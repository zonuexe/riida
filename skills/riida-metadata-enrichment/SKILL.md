---
name: riida-metadata-enrichment
description: >-
  Fill missing or thin book metadata in the riida library by resolving each book
  against techbook-mcp, writing back only confident results.
  USE FOR: enriching, completing, or fixing a riida book's title, authors, publisher,
  release date, or description; ISBN/colophon lookup; batch updates.
  DO NOT USE FOR: files not indexed by riida; reading book content; web lookups.
  INVOKES: riida extract/write, techbook-mcp resolve.
---

# Riida Metadata Enrichment

Bridge **riida** (extract + write) and **techbook-mcp** (resolve).

## Prerequisites
The **riida** and **techbook-mcp** MCP servers must both be connected. If techbook-mcp
is unavailable, fall back to colophon-only extraction; if riida is unavailable, stop.

| Server | Key tools |
|--------|-----------|
| riida | `read_pdf_colophon`, `get_book_metadata`, `update_books_metadata` |
| techbook-mcp | `resolve_book`, `get_book_by_isbn`, `get_book_detail` |

## Workflow
1. **Find** — `search_books({directory, missing_metadata:true})` or `list_books_needing_metadata`.
2. **Extract** — PDF: `read_pdf_colophon` (ISBN is the best key); EPUB: OPF;
   `get_book_metadata` for current values.
3. **Resolve** — by ISBN (`resolve_book`/`get_book_by_isbn`, openBD covers all JP
   ISBNs); else by title; `get_book_detail(url)` for descriptions.
4. **Gate** — apply only at `matched` + `confidence=high` + `isbnTitleAgree=true`,
   filling empty fields. Ask first to overwrite, or for low/ambiguous /
   `isbnTitleAgree=false` / `not_found`. Skip if nothing found.
5. **Write** — one batched `update_books_metadata`; epub+pdf pairs identical.

## Example
`isbnTitleAgree=false` = the ISBN resolves to a *different* book (wrong printed ISBN);
never auto-apply.

See [references/rules.md](references/rules.md) for field hygiene, the full gate, and troubleshooting.
