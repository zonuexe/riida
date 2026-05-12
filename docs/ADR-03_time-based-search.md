# ADR-03: Time-Based Search Operators

**Status:** Accepted
**Date:** 2026-05-12

## Context

Shelves ([ADR-02](ADR-02_shelves.md)) let users persist a search as a
sidebar entry, but the query language defined in
[ADR-01](ADR-01_search-query.md) plus ADR-02's boolean extension cannot
express time-based predicates such as "books I read in the past week"
or "books added since the new year". The earlier `read:Nd` shorthand
was added without an ADR and is limited: it only targets
`last_read_at`, has no `y` (year) unit, and has no syntax for absolute
calendar dates.

Users have asked to create shelves like "本棚 — 一週間以内に読んだ本"
and similar reading-history filters. The natural reference for query
syntax is Gmail's search operators
(<https://support.google.com/mail/answer/7190>), which the project has
decided to track as a general inspiration for the riida query
language.

## Decision

Add four Gmail-style time operators that act on `last_read_at` by
default, plus an `added_*` variant family that acts on `indexed_at`.

### Operators

| Operator | Value | Semantics (against the chosen timestamp `ts`) |
|---|---|---|
| `newer_than:` | relative duration | `ts >= now - duration` |
| `older_than:` | relative duration | `ts < now - duration` |
| `after:` | absolute date | `ts >= local-midnight(date)` |
| `before:` | absolute date | `ts < local-midnight(date)` |
| `newer:` | absolute date | alias for `after:` |
| `older:` | absolute date | alias for `before:` |

The `added_` prefix swaps the timestamp:

| Operator | Targets |
|---|---|
| `newer_than:` / `older_than:` / `after:` / `before:` / `newer:` / `older:` | `last_read_at` |
| `added_newer_than:` / `added_older_than:` / `added_after:` / `added_before:` / `added_newer:` / `added_older:` | `indexed_at` |

### Value syntax

**Relative duration** for `newer_than` / `older_than`:

- `Nd` — days
- `Nw` — weeks
- `Nm` — months (30 days)
- `Ny` — years (365 days)
- Named aliases: `today` (= 1d), `week` (= 7d), `month` (= 30d), `year`
  (= 365d). These are retained from the older `read:` shorthand.

`m` is months, **not minutes**. This follows Gmail (no minute / hour
granularity).

**Absolute date** for `after` / `before` / `newer` / `older`:

- `YYYY/MM/DD` — Gmail's canonical form
- `YYYY-MM-DD` — ISO-style alias
- Single-digit month or day is accepted (`2026/1/5`)
- Mixed separators (`2026/01-15`) are rejected
- The date is interpreted at **local midnight**, matching Gmail's
  behaviour for the user's account timezone

### Books with no timestamp

A book's `last_read_at` is `null` until it has been opened. Time
predicates require both sides of the comparison to be present:

- Never-read books **do not match** `newer_than:` / `older_than:` /
  `after:` / `before:` / `newer:` / `older:`.
- To select never-read books, continue using `read:never`.

This avoids surprising matches like "`older_than:1y` returns every
unread book in the library because it has been unread for ≥ 1 year".

`indexed_at` is set on every book at index time, so `added_*` operators
do not have this edge case.

### Backward compatibility

The existing `read:` field is retained as a shorthand:

- `read:7d` is equivalent to `newer_than:7d`.
- `read:never` selects books with no reading history.
- `read:` now also accepts the `y` unit (previously only `d` / `w` / `m`).

### Examples

```
newer_than:7d                       books read in the past week
older_than:1y                       books last read more than a year ago
after:2026/01/01                    books read on or after 2026-01-01
before:2026-04-01                   books read strictly before 2026-04-01
added_newer_than:1m                 books added in the past 30 days
newer_than:7d -tag:done             recently read but not marked done
added_after:2026/01/01 author:Knuth Knuth titles added this year
```

## Consequences

### Positive

- Shelves can express common reading-history queries directly
  (recent / stale / window-of-dates).
- Naming is recognisable to anyone who has used Gmail; the same syntax
  carries over to future operators we may borrow from there.
- The matcher is field-driven, so adding `modified_*` later (for
  `book.modified_at`) is a one-line extension.

### Negative / accepted trade-offs

- The structured shelf-editor UI (ADR-02) does not yet have rows for
  time operators. Users compose time-based shelves in the editor's
  "Custom (raw query)" mode, just as today's `read:` queries do. The
  structured editor extension is intentionally out of scope here and
  can be added later without changing storage.
- "Month" is approximated as 30 days and "year" as 365 days, matching
  the existing `read:` shorthand. Calendar-accurate granularity is not
  worth the complexity for a reading-history filter.
- Never-read books never match relative or absolute time predicates.
  This is documented above and surfaced through the existing
  `read:never` operator; users combining the two with `OR` can recover
  the union if they want it.

## Implementation notes

- Parser: new operator names are added to `KNOWN_FIELDS` in
  [src/search-query-ast.ts](../src/search-query-ast.ts); no grammar
  change.
- Evaluator: [src/library-utils.ts](../src/library-utils.ts) exposes
  `parseRelativeDurationSeconds` and `parseAbsoluteDateSeconds`, and
  dispatches `field → { timestamp, kind }` via a single
  `TIME_FIELDS` table that drives `matchTimeField`.
- `SearchableBook` gains `indexedAt?: number` to feed the `added_*`
  operators. `BookSummary.indexedAt` is already populated by the
  backend, so no IPC change is needed.
- Tests live alongside the existing helper coverage:
  [src/library-utils.test.ts](../src/library-utils.test.ts),
  [src/search-query-ast.test.ts](../src/search-query-ast.test.ts), and
  property tests in
  [src/property-tests.test.ts](../src/property-tests.test.ts).
