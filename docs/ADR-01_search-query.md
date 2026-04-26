# ADR-01: Search Query Language

**Status:** Accepted  
**Date:** 2026-04-26

## Context

The current search in `riida` is a single text box that performs a normalized substring match across `fileName`, `title`, `filePath`, `locationLabel`, and `authors`. There is no way to restrict a search to a specific field (e.g. "only books from this publisher" or "only books tagged X but not Y").

Users want to express queries like:

```
publisher:技術評論社
author:西尾泰和
tag:プログラミング -tag:未読
```

## Decision

### Query syntax

A query string is a space-separated list of **tokens**. Two kinds of tokens exist:

| Form | Meaning |
|---|---|
| `field:value` | Match `value` against the named field only |
| `"field:value with spaces"` | Same, but the value may contain spaces |
| `-field:value` | Negate: exclude books where `field` matches `value` |
| `word` | Free-text: match against all default fields |

All tokens are combined with **AND** semantics. A book must satisfy every token to be visible.

### Supported fields

| Key | Matches against | Source |
|---|---|---|
| `title` | Book title | `BookSummary.title` |
| `author` | Author list (any author) | `BookSummary.authors` |
| `publisher` | Publisher | `BookSummary.publisher` *(new)* |
| `tag` | Tag list (prefix match for hierarchy) | `BookSummary.tags` |
| `lang` | Language code | `BookSummary.language` *(new)* |
| `file` | File name | `BookSummary.fileName` |
| `path` | Full file path | `BookSummary.filePath` |
| `source` | Source type (`pdf`, `epub`, `kindle`, …) | `BookSummary.sourceType` |

Free-text tokens match across `title`, `fileName`, `filePath`, `locationLabel`, `authors`, `publisher`.

### Normalization

All comparisons apply `normalizeSearchText` (NFKC, lowercase, collapse whitespace/symbols) to both the query value and the book field value. This handles Japanese full-width/half-width variations transparently.

`tag:` uses prefix-match semantics consistent with the existing sidebar tag filter: `tag:プログラミング` matches both `プログラミング` and `プログラミング/Rust`.

### Negation

A `-` prefix before any token negates it:

```
-tag:未読              exclude books tagged 未読 (or children)
-author:山田           exclude books by 山田
publisher:オライリー -lang:en    O'Reilly books not in English
```

### Examples

```
Rust                                  free-text across all default fields
author:西尾泰和                        books by 西尾泰和
publisher:技術評論社 tag:Python        技術評論社 books tagged Python
tag:プログラミング -tag:未読            programming books except unread
author:"Robert C. Martin"             phrase with spaces
```

## Data structure changes

`publisher` and `language` are stored in `book_metadata` and `external_books` but are absent from `BookSummary`. They must be added to `BookSummary` so client-side filtering can use them without a separate IPC call.

**Rust (`BookSummary`):**

```rust
struct BookSummary {
    // existing fields …
    publisher: Option<String>,   // added
    language: Option<String>,    // added
}
```

**SQL** — extend the existing `LEFT JOIN book_metadata` query to also select `publisher` and `language`.

**TypeScript (`SearchableBook` in `library-utils.ts`):**

```ts
type SearchableBook = {
  // existing fields …
  publisher?: string | null;
  language?: string | null;
};
```

## Implementation approach

Filtering remains client-side (TypeScript). The existing full-snapshot architecture is preserved; no new IPC command is needed.

A `parseSearchQuery` function in `library-utils.ts` tokenises the raw string into a structured list:

```ts
type QueryToken =
  | { kind: "field"; field: string; value: string; negate: boolean }
  | { kind: "free";  value: string };
```

`filterVisibleBooks` replaces the current flat string comparison with a token-driven AND loop. Each token is tested independently; any failing token short-circuits to `false`.

## Alternatives considered

**Backend SQL filtering** — would allow indexed full-text search and handle very large libraries efficiently, but requires a new Tauri command, breaks the snapshot model, and is premature given the current library sizes. Can be revisited if performance becomes a concern.

**`description` field** — description text is long, often auto-generated, and rarely useful as a search key. Excluded for now to keep the result set predictable.

## Consequences

- `BookSummary` grows by two optional string fields; existing serialization is backward-compatible.
- The SQL query for local books gets two extra `COALESCE` columns; negligible performance impact.
- `filterVisibleBooks` becomes the single authoritative place for all query logic, including the existing directory/tag/source sidebar filters.
- The query language is intentionally simple: no OR between tokens, no grouping, no regex. These can be added later without breaking existing queries.
