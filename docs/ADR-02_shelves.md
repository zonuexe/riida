# ADR-02: Shelves — Saved Search as Sidebar Entry

**Status:** Accepted
**Date:** 2026-05-06

## Context

The sidebar currently exposes three orthogonal axes for narrowing the
book list: **Directories** (filesystem location), **Tags** (metadata),
and **External** (synthetic sources such as Kindle). The single-line
search box (see [ADR-01](ADR-01_search-query.md)) supports `field:value`
tokens and negation, with implicit AND between tokens.

Two limitations have surfaced:

1. There is no way to **persist** a useful search. Once the user types
   `author:"Knuth" -tag:done`, leaving the view loses the query.
2. The query language has no **OR** or grouping. `(tag:rust OR tag:go)
   -tag:archived` cannot be expressed.

Users have requested a way to register named saved searches in the
sidebar, similar to Smart Folders (Finder), Saved Searches (Gmail), or
Virtual Libraries (Calibre).

## Decision

Introduce a fourth filtering axis called **Shelf**. A shelf is a named
search expression registered in the sidebar.

### Naming

We considered `View`, `Smart Folder`, `Virtual Directory`,
`Collection`, and `Shelf`. We chose **Shelf** because:

- It fits riida's editorial / library aesthetic (DESIGN.md).
- It is conceptually distinct from `Directory` (filesystem) and `Tag`
  (metadata attribute), avoiding the `Folder` vs. `Directory`
  collision that `Smart Folder` would introduce.
- The code identifier `shelf` / `shelves` / `activeShelf` reads well
  alongside `activeDirectory`, `activeTag`, `activeExternalSource`.
- It leaves room for a future "manual curation shelf" (books pinned by
  hand) without renaming.

### Concept model

A `Shelf` is `{ id, name, query, sort_order, ... }`. Its `query` is a
canonical string in the extended search-query language defined below.
At runtime, opening a shelf sets `activeShelf = <id>`, mutually
exclusive with `activeDirectory` / `activeTag` / `activeExternalSource`
(the four axes are exclusive, matching today's behaviour).

The shelf's stored `query` is **evaluated separately** from the
sidebar search box. The user can open a shelf and then narrow further
by typing in the search box. The two compose with AND.

### Query language extension

ADR-01's grammar is extended to support boolean operators and
grouping:

```
expr     := or
or       := and ( "OR" and )*
and      := unary ( ( "AND" | implicit ) unary )*
unary    := "NOT" atom | "-" atom | atom
atom     := "(" expr ")" | field_token | quoted | bareword
```

Rules:

- `AND`, `OR`, `NOT` are reserved words **only when uppercase**.
  Lowercase `and` / `or` / `not` remain free-text barewords. This
  matches Calibre and GitHub Issues conventions and preserves
  ADR-01 backwards compatibility.
- Whitespace between atoms is implicit AND (existing behaviour).
- `()` groups subexpressions.
- `-token` negation continues to work as a unary shortcut.

The existing `parseSearchQuery` tokenizer is retained as a lower
layer; an AST parser is built on top. `filterVisibleBooks` switches
to AST evaluation, with current `matchesFieldToken` /
`matchesFreeToken` reused as terminal-leaf evaluators.

### Storage

A new SQLite table `shelves` is added to the schema initialised in
[src-tauri/src/lib.rs](../src-tauri/src/lib.rs):

```sql
CREATE TABLE IF NOT EXISTS shelves (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  query       TEXT NOT NULL,
  icon        TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
```

The structured editor state (match-mode, condition rows) is **not**
persisted separately. The editor produces a canonical raw query that
is the single source of truth. When re-opening the editor for an
existing shelf, the raw query is parsed back into structured form on a
best-effort basis; if it is too complex, the editor falls back to a
"Custom (raw query)" mode and presents the structured fields as
read-only.

Tauri commands:

- `list_shelves() -> Vec<Shelf>`
- `save_shelf(draft: ShelfDraft) -> Shelf`
- `delete_shelf(id: String)`
- `reorder_shelves(ids: Vec<String>)`

### Editor UI

The shelf editor is a frosted-card modal sheet matching
DESIGN.md component patterns (26px radius, blur, pill action buttons).
It exposes:

- a `Name` text input,
- a `Match: All / Any / Custom` segmented control,
- a stack of condition rows (`field` / `operator` / `value`),
- an `Advanced (raw query)` collapsible textarea,
- a live `Preview: N books match` counter,
- `Cancel` / `Save shelf` actions.

`All` produces an AND-joined query, `Any` produces an OR-joined query,
`Custom` exposes the raw textarea as the canonical input.

Entry points:

1. Sidebar search bar overflow: "Save current search as shelf...".
2. Sidebar `SHELVES` section header `+` button: empty draft.
3. Existing shelf row: `Edit shelf` action.

### Sidebar integration

A new `SHELVES` section is rendered in the sidebar nav, peer to
`Directories`, `Tags`, and `EXTERNAL`. Active styling reuses the
existing `nav-link.is-active` rule.

### Navigation integration

- `NavigationState` and `ViewerState` gain `activeShelf: string | null`.
- URL serialisation gains `shelf=<id>` at the same level as
  `source=kindle`.
- The bulk-selection reset condition in `applyNavigationState`
  expands to include `activeShelf` transitions.

## Consequences

### Positive

- Users can persist any query they care about as a first-class
  sidebar entry.
- The query language gains real boolean expressiveness (OR, grouping)
  used by both the search box and shelf storage.
- Shelves compose with the search box, so users can refine inside a
  shelf without losing it.

### Negative / accepted trade-offs

- The structured editor cannot perfectly round-trip every raw query.
  Complex queries fall back to "Custom" mode. We accept this rather
  than persisting parallel structured state and risking divergence.
- Reserving uppercase `AND` / `OR` / `NOT` is a minor backwards-compat
  consideration: any existing book with literal uppercase `AND` /
  `OR` / `NOT` in metadata can still be searched by quoting.
- Shelves are exclusive with the other three axes, matching the
  current four-axis exclusivity convention. Multi-axis composition
  (e.g. "shelf within a directory") is intentionally out of scope and
  can be added later without breaking storage.

## Implementation phases

The work is split into independent PR-sized phases, executed in order:

1. `search-query-ast.ts`: AND/OR/NOT/grouping parser and evaluator,
   with deterministic and property-based tests.
2. Switch `filterVisibleBooks` to AST evaluation; verify existing
   search tests still pass.
3. SQLite `shelves` table, Tauri commands, startup load.
4. Sidebar `SHELVES` section render, navigation state plumbing,
   selection-reset extension.
5. Shelf editor modal — raw-query mode first.
6. Shelf editor structured UI (condition rows, All / Any modes).
7. Polish: live preview count, drag-and-drop reorder, optional icon
   picker.

Each phase is independently shippable; later phases can be deferred
without blocking earlier ones.
