# Full-Text Search Design (tantivy + lindera + pdfium)

Status: **design draft** for a future release (not the in-progress release).

This document proposes cross-library full-text search for `riida`: searching
*inside* book content (PDF / EPUB body text), notes, and metadata from one query
box, with jump-to-location results.

## 1. Motivation and Current State

Today there is **no content search**. What exists:

- **Library search is metadata substring matching**, done entirely in the
  frontend. [`filterVisibleBooks()`](../src/library-utils.ts) filters the
  in-memory `LibrarySnapshot.books` array; queries are parsed by the boolean
  AST in [`search-query-ast.ts`](../src/search-query-ast.ts) (AND/OR/NOT,
  `field:value`, parentheses, quotes) and matched with NFKC-normalized
  `includes()` over title / author / publisher / tag / language / path / etc.
- **PDF body text is only extracted at view time**, per open file, via pdf.js
  (`buildPdfSearchPageIndex` in [`main.ts`](../src/main.ts)). It never leaves
  the webview and is never persisted.
- **EPUB extraction is OPF metadata only** (`extract_epub_metadata`, quick-xml +
  zip). Section text is never extracted.
- The Rust backend has **no PDF text extraction crate** and **no search index**.

So the metadata case is already well served. The gap — and the reason to bring
in tantivy + lindera — is **searching the contents of the whole library** and
landing on the exact page/section that matched.

### Resolved design decisions

| Decision | Choice |
| --- | --- |
| Index scope | Body (PDF/EPUB full text) + notes + metadata + tags, unified |
| Japanese tokenizer | Lindera morphological analysis, IPADIC dictionary |
| Index granularity | Per page (PDF) / per section (EPUB) |
| PDF text extraction (Rust) | `pdfium-render` |

## 2. High-Level Architecture

```
                 ┌─────────────────────────────────────────────┐
   scan / watch  │  Rust backend                                │
  (notify) ─────▶│  ┌────────────┐   ┌──────────────────────┐   │
                 │  │ index queue│──▶│ extraction pipeline   │   │
  save_note ────▶│  │ (SQLite    │   │  PDF  → pdfium-render │   │
  save_metadata ▶│  │  status    │   │  EPUB → zip+quick-xml │   │
  save_tags ────▶│  │  table)    │   │  note/meta → SQLite   │   │
                 │  └────────────┘   └──────────┬───────────┘   │
                 │                              │ text units     │
                 │                   ┌──────────▼───────────┐   │
                 │                   │ tantivy index        │   │
   search_full ─▶│  search_fulltext ─│  lindera tokenizer   │   │
   text(query)  │◀──── hits ─────────│  per-page/section    │   │
                 │  (file_path, page, │  docs + snippets     │   │
                 │   anchor, snippet) └──────────────────────┘   │
                 └─────────────────────────────────────────────┘
                            ▲
   frontend ────────────────┘  merge hits with LibrarySnapshot,
                               render result group, jump to page/CFI
```

The tantivy index is a **derived artifact** kept beside the SQLite DB. SQLite
remains the source of truth for books, metadata, tags, and notes; tantivy holds
only the inverted index needed for search.

## 3. Index Scope and Schema

### 3.1 Document model

One tantivy index, with documents at **content-unit** granularity. A `kind`
field distinguishes three document shapes that all share the same schema:

- `kind = "body"` — one document per **PDF page** or **EPUB section chunk**.
- `kind = "note"` — one document per book's note (chunked if very long).
- `kind = "metadata"` — one document per book, concatenating title / authors /
  publisher / description / asin / url / release_date / language and the book's
  tags.

Keeping metadata and notes in **their own documents** (rather than
denormalizing them onto every page document) is deliberate: a metadata or tag
edit then re-indexes a single small document instead of every page of the book.
Body documents do *not* carry metadata.

A bare free-text query searches all three kinds, so "find この語" returns hits
whether the term is in the title, a note, or page 240. Ranking is BM25 with
field boosts (title/author boosted above body) so a title match outranks a
deep-body match.

### 3.2 Schema fields

| Field | Type | Flags | Purpose |
| --- | --- | --- | --- |
| `file_path` | STRING (raw) | STORED, INDEXED | Result key **and** delete term for re-index. Holds `kindle:…` synthetic paths too. |
| `kind` | STRING (raw) | STORED, INDEXED | `body` \| `note` \| `metadata`; enables kind-scoped delete/filter. |
| `loc_page` | U64 | STORED, FAST | PDF page (1-based); absent for non-PDF / non-body. |
| `loc_anchor` | STRING | STORED | EPUB CFI base or `spineHref#frag` for jump; empty otherwise. |
| `title` | TEXT (lindera) | STORED | Denormalized book title — boosted in queries and shown in result rows without a DB join. |
| `authors` | TEXT (lindera) | — | Field-scoped author queries + default-query coverage. |
| `tags` | TEXT (lindera) | — | Free-text tag coverage (hierarchical tag logic stays in the existing client path). |
| `text` | TEXT (lindera) | STORED | The searchable body + snippet source. |

`STORED` on `text`/`title` is what powers `SnippetGenerator` highlighting. It
inflates the index (see traverze's `--with-snippet` note in §8). This is the
core value for a reading app, so snippets are on; the on/off flag is recorded in
index metadata (§5) because it cannot be toggled without a rebuild.

### 3.3 Tokenizer

Register a `"lindera"` tokenizer (IPADIC) on the index's tokenizer manager and
reference it from every TEXT field. The same tokenizer runs at index and query
time so morphological segmentation is symmetric.

Known trade-off accepted by the IPADIC choice: morphological tokens give small
indexes and good precision but **weaker mid-string partial matching** than
bigrams. If partial-match recall proves insufficient in practice, the schema
can grow a parallel n-gram field later (a `tokenizer` change ⇒ index rebuild via
§5). Designing the schema-version gate up front makes that switch cheap to ship.

## 4. Extraction Pipeline

Runs on a dedicated background worker thread with a work queue; never on the UI
path. Emits understated progress events to the frontend (§7), not toasts.

- **PDF → `pdfium-render`.** Load `libpdfium` once (dynamic binding), open the
  file, iterate pages, extract page text → one `body` doc per page with
  `loc_page`. pdfium handles CID/CJK fonts well, which matters for the Japanese
  library this targets. Password-protected PDFs: reuse the stored password from
  `pdf_passwords` when present, else skip and mark `needs_password`.
- **EPUB → existing `zip` + `quick-xml`.** Read the spine, unzip each XHTML
  section, strip markup to text → one `body` doc per section (chunked if large)
  with `loc_anchor` = spine href so the viewer can navigate by CFI.
- **Notes → SQLite.** `notes.content` (markdown) → one `note` doc.
- **Metadata / tags → SQLite.** `book_metadata` + `book_tags` (and
  `external_books` for Kindle) → one `metadata` doc per book.

External Kindle books have no file body — they contribute `metadata`/`note`
docs only, and stay non-openable as today (activating a hit opens metadata
editing, consistent with current behavior).

### Incremental indexing

tantivy documents are immutable; update = **delete by term, then add**.

- Track per-source state in a new SQLite table `fulltext_index`
  (`file_path` PK, `content_hash`, `body_modified_at`, `indexed_at`, `status`,
  `error`). The scan diff decides work: new / changed `modified_at` ⇒ enqueue
  body re-extraction; removed file ⇒ `delete_term(file_path)`.
- Note / metadata / tag edits re-index **only their kind doc** synchronously
  inside the existing `save_note` / `save_book_metadata` / `save_book_tags` /
  `delete_book_metadata` commands (`delete_term(file_path AND kind=…)` → add).
  These are cheap and rebuildable from SQLite, so they need no extraction.
- Batch commits: tantivy `commit()` is a disk flush; batch many docs per commit
  (traverze's lesson) — commit per N books or per drained-queue, not per page.

## 5. Index Location and Lifecycle

- **Location: the data directory** (beside `app.db`), not cache. The
  metadata/note portion is instantly rebuildable from SQLite, but the body
  portion costs a full pdfium re-extraction of every PDF, so it should survive
  cache clears. Treat it as persistent-derived state. Gitignore N/A (runtime
  path).
- **Version stamp: `index_meta.json`** next to the index — `{ schema_version,
  tokenizer, dict, snippet: true }`. On startup, mismatch ⇒ **full rebuild**
  (the traverze `--reset` model). This is the single mechanism that handles
  schema migrations, tokenizer swaps, and the un-toggleable snippet flag.
- **Resumable**: the `fulltext_index.status` column lets indexing resume after a
  crash/quit instead of restarting from zero.

## 6. Backend Commands

New `#[tauri::command]`s in [`lib.rs`](../src-tauri/src/lib.rs):

- `search_fulltext(query: String, limit: u32, offset: u32) -> Vec<FullTextHit>`
  — `FullTextHit { file_path, title, kind, page: Option<u64>, anchor:
  Option<String>, score: f32, snippet_html: String }`.
- `fulltext_index_status() -> { total, indexed, pending, failed, building }`.
- `rebuild_fulltext_index() -> Result<(), String>` — force reset + full
  re-extraction.

Existing commands gain a re-index side effect: `save_note`,
`save_book_metadata`, `save_book_tags`, `delete_book_metadata`,
`delete_custom_source`, plus the scan/watch refresh path.

## 7. Frontend Integration

Keep the existing search box and AST. **Hybrid execution**:

1. Parse the query with the existing AST.
2. Structured metadata predicates (`title:`, `author:`, `tag:`, `read:`,
   `added:`, time operators…) stay **client-side** against the snapshot — fast,
   already correct, no round trip.
3. Free-text terms (and a new `content:` / `note:` token) go to
   `search_fulltext`; results carry page/anchor + `snippet_html`.
4. Merge by `file_path`: the book row stays; a **"本の中身" result group**
   expands under matching books showing snippets, each row a jump target.

**Jump**: PDF → open viewer at `loc_page` (reuse `open_viewer_window` +
reading-position machinery); EPUB → navigate by `loc_anchor`/CFI (reuse existing
CFI navigation). Following DESIGN.md: snippet rows are frosted, calm, reading-
first; indexing progress is understated inline (like the note save status), not
a toast storm. Search box keeps the existing IME-composition guards.

## 8. Risks, Gotchas, and Open Questions

- **pdfium build/bundling (highest risk).** `pdfium-render` needs `libpdfium` at
  runtime. Plan: bundle the prebuilt `libpdfium.{dylib,so,dll}` as a Tauri
  resource and load via dynamic binding; add it to the Nix dev shell
  ([`flake.nix`](../flake.nix)). macOS: the bundled dylib must be signed (today's
  ad-hoc signing per `tauri.conf.json` covers local/CI; release notarization
  must include it). Adds several–~15 MB per platform.
- **lindera ↔ tantivy version compatibility.** `lindera-tantivy` historically
  lags tantivy's tokenizer-API changes. Pin compatible versions; if no release
  targets tantivy 0.26, wrap lindera output into `tantivy-tokenizer-api`
  manually. **Validate in the Phase 0 spike before committing.**
- **Licensing gate (strict in this repo).** New SPDX licenses must be vetted and
  added to *all three* allowlists together — [`deny.toml`](../deny.toml),
  the `check:licenses:npm` list (n/a, Rust-only here), and
  [dependency-review-config](../.github/dependency-review-config.yml) — plus
  regenerate `THIRD-PARTY-LICENSES-rust.md`. Items to vet: pdfium-render
  (Apache-2.0/MIT), **PDFium prebuilt binary (BSD-3-Clause)**, tantivy (MIT),
  lindera, and the **IPADIC dictionary license**. The bundled libpdfium and
  IPADIC notices must ship. Budget real time for this; it can block release.
- **Binary size.** Embedded IPADIC (tens of MB) + libpdfium. Consider loading
  IPADIC/libpdfium as external resources rather than embedding if size matters.
- **Snippet flag is sticky.** Stored body can't be toggled without a rebuild —
  hence the `index_meta.json` gate (§5).
- **Quality gates.** Mutation/coverage are enforced. Pure helpers (snippet
  formatting, query→tantivy mapping, chunking decisions, hash/path logic) get
  unit + proptest; tantivy/pdfium IO functions go into `exclude_re` in
  [`mutants.toml`](../src-tauri/.cargo/mutants.toml) (like the qlmanage/sips IO
  exclusions), extracting a testable `*_with_index` core where practical.
- **Open: EPUB section chunk size** (whole section vs sub-chunk for snippet
  precision) — settle during Phase 2 against real files.

## 8a. Phase 0 Results (validated 2026-06-03, v0.7.0 work)

The spike de-risked both unknowns. The tantivy+lindera validation now lives in
the `fulltext` / `fulltext_extract` module unit tests; the env-gated pdfium
real-file check is kept at `src-tauri/tests/pdfium_spike.rs`.

- **Compatible crate set resolves and compiles** (Rust 1.94):
  `tantivy = 0.25`, `lindera = 2` (resolved 2.3.4) with `embed-ipadic`,
  `lindera-tantivy = 2.0.0` with `embed-ipadic`,
  `pdfium-render = 0.9` (`default-features = false`,
  features `["thread_safe", "pdfium_7543"]`). The latest standalone
  `tantivy 0.26` / `lindera 3.x` are **not** usable yet because
  `lindera-tantivy 2.0.0` pins `tantivy ^0.25` + `lindera ^2`. Staying on the
  matched set avoids a custom tokenizer adapter; revisit when lindera-tantivy
  ships a 0.26 release.
- **Lindera IPADIC tokenization works** end-to-end in tantivy: morphological
  tokens (`検索`, `形態素`) match/rank correctly; absent terms return nothing.
- **pdfium dynamic binding works** against nixpkgs `pdfium-binaries` (v7749) —
  `lib/libpdfium.dylib` loaded at runtime via `Pdfium::bind_to_library`, no
  build-time linking. The package also ships a `licenses/` dir for the gate.
- **CJK extraction quality is good** on real books:
  - Horizontal (ラムダノート IPv6, 488pp): 744k chars, 44% CJK, clean body text.
    Note: ラムダノート PDFs carry a per-page purchaser **watermark hash** as the
    first text line — strip/ignore leading hash-like lines when indexing.
  - Vertical / tategaki (空想科学読本, 264pp): readable body text in correct
    reading order, 32% CJK.
- **Required preprocessing (new finding):** vertical-text pages sometimes
  extract with **spaces inserted between individual CJK glyphs**
  (`た と え ば` instead of `たとえば`), because each glyph is positioned
  separately. This breaks morphological tokenization. The extraction pipeline
  **must normalize inter-CJK whitespace** (collapse spaces/newlines between
  adjacent CJK characters) before tokenizing. Decorative cover fonts can also
  mis-map an occasional glyph (`学`→`事`); cosmetic, accepted.
- **Dependency weight to budget for:** tantivy pulls in
  zstd/reqwest/rustls/hyper; lindera embeds IPADIC (binary size); pdfium needs
  the bundled native lib. All feed the license gate (§8).

## 9. Phasing

Implementation status (v0.7.0 work, branch `feature/fulltext-search`):

- **Phase 0 — Spike (de-risk). DONE.** See §8a.
- **Phase 1 — Infra + metadata/notes/tags index. DONE.** Deps, data-dir index,
  `fulltext_index` table, background worker, schema + lindera tokenizer,
  `search_fulltext`, frontend results. (No `index_meta.json` schema-version gate
  yet — add before a schema/tokenizer change ships.)
- **Phase 2 — Body extraction. DONE.** pdfium PDF pages + EPUB sections,
  per-page/section docs, snippets, jump-to-page / jump-to-CFI.
- **Phase 3 — Polish. PARTIAL.** Opt-in build + progress UI, incremental
  reconciliation after scans, and the license/mutation gates are done.
  **Remaining:** bundle libpdfium for release (§8) + macOS signing; an
  `index_meta.json` version gate + rebuild control; ranking/boost tuning; an
  optional n-gram field if partial-match recall proves insufficient.

## 10. Touch Points (where the code lands)

- [`src-tauri/src/lib.rs`](../src-tauri/src/lib.rs) — schema table, commands,
  worker, re-index hooks in existing save/delete/scan paths.
- New Rust module(s) — extraction pipeline + tantivy wrapper (keep testable
  cores separate from IO).
- [`src-tauri/Cargo.toml`](../src-tauri/Cargo.toml) — tantivy, lindera,
  lindera-tantivy, pdfium-render.
- [`flake.nix`](../flake.nix) — libpdfium in the dev shell.
- [`deny.toml`](../deny.toml) + notices + dependency-review config — license
  gate.
- [`src/library-utils.ts`](../src/library-utils.ts) /
  [`search-query-ast.ts`](../src/search-query-ast.ts) /
  [`main.ts`](../src/main.ts) — hybrid query execution, result group, jump.
- [AGENTS.md](../AGENTS.md) — document the new index once built.
```
