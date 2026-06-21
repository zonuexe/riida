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

## Scoping a directory

`library_roots` often mix standalone books with material that has no resolvable single
record. Before a batch, look at what is actually under the directory and confirm scope:

- **Magazine back-issues / 総集編 (per-article PDF splits)** — thousands of
  `NNNNNN_MM-MM.pdf` fragments are individual articles, not books, and resolve to no
  ISBN. Exclude unless the user asks for them. A combined single-file issue (one PDF
  per issue, with its own ISBN) *is* resolvable.
- **`backup/` and `*のコピー.pdf`** — duplicates of books already in scope; skip.
- **`index.pdf` / catalog PDFs** — navigation files, not books; skip.

When a directory is mostly fragments, surface the breakdown and the proposed target set
(and ask) before enriching thousands of article scraps.

## Working at scale (delegate the extraction sweep)

`read_pdf_colophon` returns the parsed colophon **and a multi-KB `text` field** (the raw
tail pages, for cross-checking). One call is cheap; twenty calls dumped into the main
context bury the actual decisions under tens of thousands of tokens of book back-matter.
A broad `search_books` over a large library can likewise exceed the tool-output token
limit outright.

So split the job by who needs to *think*:

- **Mechanical text extraction → subagent.** Hand a subagent the file list; it calls
  `read_pdf_colophon` per file, **ignores the `text` field**, and returns only a compact
  record per book. The huge raw text never enters your context.
- **Resolution, the decision gate, and the write → you.** These need judgement (edition
  checks, author cleanup, overwrite decisions) and must stay where you can see them.
  Never delegate the `update_books_metadata` write.

Ready-to-use extraction-subagent prompt:

> Load the tool: `ToolSearch` with query `select:mcp__riida__read_pdf_colophon`.
> For each path below, call `mcp__riida__read_pdf_colophon` (file_path only). The result
> has a large `text` field — **ignore it**; use only `colophon.isbn_normalized`,
> `colophon.isbn_confidence`, `colophon.release_date`, `colophon.publisher`. Batch ~8
> calls per message. If no ISBN is detected, set isbn to "".
> Return **only** a JSON array (no prose, no code fences), one object per file in input
> order: `{"file_path","isbn","confidence","release_date","publisher"}`.
> Files: <absolute paths>

Keep each subagent to a couple dozen files so one failure does not sink the whole sweep,
and so you can resolve + write one batch while the next extracts.

## Resolving

- Prefer **ISBN** — `resolve_book(s)` with the ISBN, or `get_book_by_isbn`. These go
  through openBD, which covers virtually all Japanese ISBNs, so they return the
  canonical title/authors/publisher **even for publishers techbook has no adapter
  for** (e.g. CQ出版, オーム社) — usually without a description.
- **Pass both `isbn` AND `title`** to `resolve_book` / `resolve_books`. The
  `validation.isbnTitleAgree` flag is only computed when a title is supplied; an
  ISBN-only call omits it entirely. With the flag absent but a high-confidence ISBN
  match, treat the match as applicable — the colophon ISBN is the authoritative key.
- **No ISBN** — resolve by title (+author). ASCII tokens and exact full titles match
  best; pure-Japanese fragments are weaker.
- **Field availability varies by `source`** — treat every field as possibly absent.
  `isbn:publisher` results carry `publishedAt` and a `validation` block; `isbn:openbd`
  results usually **omit `publishedAt`** (use the colophon date instead); `source:search`
  results omit `validation` (so compare the returned ISBN/title yourself). Never assume
  `publishedAt` is present just because the ISBN resolved.
- **Descriptions are publisher-dependent**: oreilly-japan / seshop expose them;
  openBD and some adapters (e.g. gihyo) often don't. Call `get_book_detail(url)` once
  when a description or clean authors are missing — but only when `source` is a
  supported-publisher adapter. For `source: isbn:openbd` the `url` is an openBD API
  endpoint that `get_book_detail` rejects, so skip the probe and accept no description.
  If detail still returns none, accept that and move on — don't keep retrying.

## Decision gate

- **Apply** — `status=matched` AND `confidence=high` AND (`isbnTitleAgree=true`, or no
  ISBN but `matchScore` is high and the title clearly matches). Fill only fields that
  are currently **empty**.
- **Ask first** — before overwriting any non-empty field, and for `confidence`
  medium/low, `status=ambiguous`, or `not_found` with only colophon data. Show the
  proposed-vs-current diff and any `candidates`.
- **Skip** — nothing found and no usable colophon data, or free excerpts with no ISBN.
  Say why.

### When the returned ISBN ≠ the ISBN you asked for
`resolve_book`/`resolve_books` can fall back to a **title search** when an ISBN is not in
its adapters, and then return a *different edition's* record — with `source: "search"`,
no `validation` block, yet `status: matched` / `confidence: high` / `matchScore: 1`. It
looks like a perfect hit but is the wrong book. Example: asking for `9784297102913`
(［改訂新版］プログラマのための文字コード技術入門, 2019) returned `9784774141640`
(the 2010 first edition) — same author, wrong edition and date.

So always compare `book.isbn` (returned) against the ISBN you passed. If they differ:
- Keep the **file's own edition** — title from the on-disk filename and date from the
  colophon (the physical book you hold), not the substitute's.
- Take only edition-stable fields (authors, publisher) from the result.
- Note the substitution in the report.

### Handling `isbnTitleAgree=false` (do NOT over-flag)
A `false` flag has two very different causes — distinguish them; do not treat every
`false` as a wrong ISBN (that wrongly leaves correct books empty):

1. **Wrong / swapped ISBN** — `matchScore` ≈ 0 and the resolved title is a *different
   work*. Example: `レガシーソフトウェア改善ガイド.pdf` prints ISBN `9784798134208`,
   which resolves to 「ガベージコレクション」. The ebook printed another book's ISBN —
   do **not** write; report the conflict and keep the file's own title.
2. **Edition / title-variant noise** — `matchScore` is moderate, the publisher
   matches, and the resolved title is the *same work* missing only an edition or
   series suffix (`第N版`, `［増補改訂版］`, `EE`, a subtitle…). Examples:
   `独習PHP 第4版` → 「独習PHP」, `初めての人のためのLISP［増補改訂版］` →
   「初めての人のためのLISP」, `こうしす！社内SE…` → 「こうしす!EE社内SE…」. This is the
   right book — don't leave it empty. Confirm by re-resolving **by title (+author)**
   (publisher adapters like seshop return the full edition title and a description),
   then apply; otherwise apply the file's own edition title with the resolved
   authors/date.

When unsure, prefer a title re-resolve over flagging: a moderate `matchScore` with a
matching base title and the same publisher is almost always case 2.

## Field hygiene

- **Authors** — openBD often returns oddly-split tokens
  (`["Boswell","Dustin Foucher","Trevor 角","征典"]`); normalize to real names
  (`["Dustin Boswell","Trevor Foucher","角 征典"]`). It also returns Japanese names in
  **library-heading form** — `"広木, 大地, 1983-"`, `"五十嵐, 淳, 1973-"` (surname, given,
  birth-year) or with a full-width space `"小川 雄大"`. Normalize to the natural display
  name (`"広木大地"`, `"小川雄大"`): drop the `, 生年-` tail and the comma, and close the
  surname/given space for Japanese names — but keep spacing for Western names like
  `"Dustin Boswell"`. The same person can come back in different forms within one
  response (`大竹, 智也, 1983-` from openBD vs `大竹智也` from a publisher adapter); pick one
  clean form and use it consistently. If you can't normalize confidently, keep the
  existing authors and flag for review rather than write garbled names. When the stored
  authors are a **subset** of the resolved list (a dropped co-author or translator),
  proposing the fuller list is a correction worth surfacing — not a silent skip.
- **Title** — include the official subtitle when the publisher lists one; keep the
  edition right (第2版 ≠ 第3版 — the file on disk decides which edition is correct). Strip
  openBD scraping artifacts: an embedded newline (`"図解即戦力\nWeb技術…"`), an
  `= EnglishTitle` alternate, and the library `:` subtitle separator. When openBD's
  heading title is messy, the on-disk filename is usually the cleanest source of
  title+subtitle and is authoritative for the edition — prefer it, joining the subtitle
  with the separator the user already uses (`～`, `――`, `──`…).
- **publisher** — colophons read `株式会社技術評論社`; store the imprint the way the library
  already uses it (`技術評論社`), dropping the `株式会社` prefix for consistency.
- **release_date** — `YYYY-MM-DD`. Prefer the official date, else the colophon date,
  else leave empty. Never invent a day from a year. Be consistent across a batch (e.g.
  the colophon 発行日 throughout). Watch for placeholder dates already stored
  (`2026-01-01`, a Jan-1/month-1 default) or a stored date that contradicts the
  colophon — worth flagging even when the don't-overwrite gate means you leave it.
- **language** — `"ja"` unless clearly otherwise. Never fabricate any field; omitting
  beats guessing.

## Writing

Use one batched `update_books_metadata` call with an array — never loop single
updates (slower, not atomic). Only included fields change; omitted fields are kept, so a
field-level fill (e.g. only `authors`, or only `release_date`) leaves everything else
intact. The writable fields are `title`, `authors`, `publisher`, `release_date`,
`language`, `description` — there is **no** `url`/`asin`/`cover_url` here, so don't plan
to set those through this tool. A title that exists as both `.epub` and `.pdf` gets
identical metadata on both paths.

## Troubleshooting

- **`get_book_metadata` → `found:false`** — usually just means *no metadata row stored
  yet* (normal for a freshly indexed book), **not** out of scope. Such a file is still
  writable: `update_books_metadata` creates the row, and all fields come back populated.
  Confirm the file is under a library root (it appears in `search_books`) and proceed.
  Only treat it as out of scope — and report rather than write — if it genuinely is not
  indexed anywhere.
- **`resolve_*` → `not_found`** — try the other key (ISBN ↔ title), then
  `get_book_by_isbn` via openBD. Still nothing → fall back to the colophon/front
  matter alone, or skip.
- **No description anywhere** — expected for some publishers; set the other fields and
  note that the description was unavailable.
- **`isbnTitleAgree=false`** — don't reflexively skip; classify it first (see "Handling
  `isbnTitleAgree=false`"). A different *work* → report and skip; a same-work edition
  variant → re-resolve by title and apply.
- **A perfect-looking match that is the wrong edition** — check `book.isbn` against the
  ISBN you requested (see "When the returned ISBN ≠ the ISBN you asked for").

## Report

Summarize at the end: which books were set (and the source — techbook vs colophon),
which were flagged for review (with the reason), and which were skipped.
