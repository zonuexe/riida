# 2026-05-04 Book list scroll performance investigation

## Context

Scrolling through the home book list (`#main-pane` ▶ `.books`) felt
janky on a library of ~2777 books. This note records the profiling
work, the changes that landed, and what was deliberately left for
later.

Profiles were taken with Safari Web Inspector (Timeline: Layout &
Rendering / JavaScript & Events / CPU) and Samply (Rust side). All
runs cover a 15s window of the same scroll gesture on the home view.

## Initial profile (baseline)

Safari main-thread breakdown across 15s of scrolling:

- Total: 9457 ms
- Paint:      **81.1 %** (7671 ms)
- Layout:     16 %  (1511 ms)
- JavaScript: 2.9 % (275 ms)
- Style:      0 %
- Avg CPU 58.2 %, peak 84.6 %
- Active IntersectionObservers: **87**
- Network requests during the window: **644**

Top JS samples were dominated by IntersectionObserver callbacks at
[main.ts](../../src/main.ts) line 1188 (`ensureThumbnailObserver`).

Samply (Rust) showed `book_thumbnail` IPC fan-out:

- `book_thumbnail`: 73 samples
  - `compile_exclude_patterns`: 26  ← **recompiled per call**
  - `matches_excluded_pattern`: 15
  - `std::sys::fs::metadata`: 29

`library_snapshot` (110 samples) was a one-time startup cost, not a
per-scroll repeat.

### Hypotheses ranked by expected impact

| #   | Change                                                         | Expected effect                                            | Difficulty |
| --- | -------------------------------------------------------------- | ---------------------------------------------------------- | ---------- |
| 1   | `content-visibility: auto` + `contain-intrinsic-size` on rows  | Off-screen layout/paint goes to ~0 → big paint reduction   | Low        |
| 2   | `<img.book-thumb>` with explicit `width`/`height`              | Bound image-load reflow                                    | Low        |
| 3   | Batch the per-book `book_thumbnail` IPC                        | Cut 644 network requests to ~10                            | Medium     |
| 4   | True virtual scrolling                                         | Bound DOM size                                             | High       |

## Round 1: `content-visibility: auto` + `<img>` size attrs

Changes:

- [styles.css](../../src/styles.css) `.book-item` (list view): added
  `content-visibility: auto; contain-intrinsic-size: auto 150px;`.
- [styles.css](../../src/styles.css) `.books.grid-view .book-item`:
  added `contain-intrinsic-size: auto 220px;` (inherits the `auto`
  declaration).
- [main.ts](../../src/main.ts) `<img.book-thumb>`: added `width=72`,
  `height=102`, `decoding="async"`, `loading="lazy"`.

Result:

- Total: 9718 ms (≈unchanged)
- Paint:      **41.5 %** (4029 ms) — **−47 %**
- Layout:     **52.3 %** (5082 ms) — +236 %
- JavaScript: 0.4 %  (35 ms) — −87 %
- Style:      5.9 %  (572 ms) — new line item
- Avg CPU 55.3 %, peak 69.4 %
- Active IntersectionObservers: 87 → **15**
- Network requests during the window: 644 → **31** (`loading="lazy"`)

Reading: paint won big. The new layout cost is `content-visibility`'s
inherent trade — viewport entries trigger real layout per row. Style
appeared because `transitionend` started firing.

## Round 2: scope hover transitions during scroll

Investigation: Style 572 ms + `transitionend` 59 came from
`.book-reveal-btn` (opacity + color + background, with permanent
`backdrop-filter: blur(4px)`) and `.book-select-checkbox` (opacity)
firing as rows scroll under the pointer.

Change:

- [styles.css](../../src/styles.css): added
  `html.is-scrolling .book-item .book-reveal-btn,
  html.is-scrolling .book-item .book-select-checkbox { transition: none; }`.
- [main.ts](../../src/main.ts): scroll listener on `#main-pane`
  toggles `<html>.is-scrolling` with a 160 ms idle debounce.

Result:

- Total: 9886 ms
- Paint:      42.8 % (4232 ms)
- Layout:     52.8 % (5217 ms)
- Style:      4.0 %  (400 ms) — −30 %
- `transitionend`: 59 → **45**
- 4 GC samples appeared in the top entries (≈8.2 ms total) — new
  signal: short-lived allocations during scroll.

Layout/Paint moved within noise; the transition suppression delivered
its piece (style) but the next bottleneck moved.

## Round 3: `contain` boundary + WeakMap lookup

Changes:

- [styles.css](../../src/styles.css) `.book-item`: added
  `contain: layout paint style;` so realize-time work cannot escape
  a row's box.
- [main.ts](../../src/main.ts): introduced
  `const thumbnailBookByImage = new WeakMap<HTMLImageElement, BookSummary>()`.
- IO callback no longer calls `viewerState.books.find(...)` — it
  reads the row's book directly from the WeakMap. With ~2777 books
  and 18 IO entries per batch, this removed ≈50 000 string
  comparisons per batch and the per-find arrow-function allocation.
- `renderBookList` registers each `<img>` in the WeakMap right before
  `observe()`. The img → book entry is auto-released when the img is
  GC'd.

Result:

- Total: 10586 ms
- Paint:      44.3 % (4687 ms)
- Layout:     50.5 % (5351 ms)
- Style:      5.0 %  (533 ms)
- JavaScript: 0.1 %  (15 ms) — −57 %
- `transitionend`: 45 → **36**
- Active IntersectionObservers: 18 → **8**
- **GC samples: 4 → 0 in the top entries**
- **Max IO callback time: 4.438 ms → 0.807 ms (−82 %)**

Layout/Paint were within run-to-run noise; the JS-side and GC-side
costs collapsed cleanly.

## Net change: baseline → final

| Metric              | Baseline | Final   | Change          |
| ------------------- | -------: | ------: | --------------- |
| Paint               | 7671 ms  | 4687 ms | **−39 %**       |
| Layout              | 1511 ms  | 5351 ms | +254 % (CV cost)|
| JavaScript          | 275 ms   | 15 ms   | **−95 %**       |
| Active IO observers | 87       | 8       | **−91 %**       |
| Network requests    | 644      | 16      | **−98 %**       |
| Max IO callback     | 5.2 ms   | 0.8 ms  | **−85 %**       |
| GC top samples      | n/a      | none    | clean           |

Total main-thread time crept up (9457 → 10586 ms) but the composition
shifted from "wide paint over the whole list" to "narrow layout
realize cost on rows entering the viewport." Subjective scroll
smoothness is the right success criterion from here, not the totals.

## What was deliberately not done

These were considered and parked. Each is a real lever but adds
either risk or scope, and the user-visible cost of stopping here was
judged acceptable.

- **Batched `book_thumbnail` IPC.** The `loading="lazy"` change
  already cut network requests 644 → 16 because WebKit suppresses
  off-screen image fetches under CV. A `book_thumbnails(file_paths[])`
  command would still help if the visible-set-on-arrival case becomes
  hot, but it is no longer obviously necessary.
- **Cache `CompiledExcludePatterns` in `ConfigState`.** Samply showed
  `compile_exclude_patterns` recompiling per `book_thumbnail` call.
  With per-scroll IPC volume now low, the absolute waste is small.
  Worth picking up the next time we touch `ConfigState`, especially
  since the watcher path also recompiles eagerly.
- **`.book-item` internal DOM/CSS slimming.** Each row still builds
  the `book-tags-row`, `book-tag-list`, `book-action-list`, and tag
  edit button even when `book.tags.length === 0`, and `.book-tag` uses
  a per-tag `<i class="fa-solid fa-tag">`. These are realize-time
  costs under CV. Not pursued because (a) layout/paint numbers are
  within noise of CV's floor, (b) it would entail real DOM-shape
  changes, (c) the user asked to stop here.
- **True virtual scrolling.** The biggest hammer left, but it would
  invalidate the IntersectionObserver assumption and reshape
  `renderBookList`. Reserved for if the library grows past the point
  where CV alone is enough.
- **`.book-thumb` `box-shadow` softening.** `box-shadow: 0 10px 24px`
  on every thumb is paint-expensive on realize. Hover-only or a
  cheaper shadow would help; not done because paint is no longer the
  dominant cost.

## Files touched

- [src/styles.css](../../src/styles.css)
  - `.book-item`: `content-visibility: auto`, `contain-intrinsic-size`,
    `contain: layout paint style`.
  - `.books.grid-view .book-item`: `contain-intrinsic-size`.
  - Added `html.is-scrolling .book-item .book-reveal-btn,
    html.is-scrolling .book-item .book-select-checkbox { transition: none; }`.
- [src/main.ts](../../src/main.ts)
  - `<img.book-thumb>` gets `width`/`height`/`decoding="async"`/`loading="lazy"`.
  - Module-level `thumbnailBookByImage = new WeakMap<...>()`.
  - IO callback uses the WeakMap instead of `viewerState.books.find`.
  - `renderBookList` writes the WeakMap entry before `observe()`.
  - `#main-pane` scroll listener toggles `<html>.is-scrolling` with a
    160 ms idle debounce.

## Verification

`npm run lint`, `npm run fmt:check`, and `npm test` all green after
each round. Tauri-side runtime verification was done by re-recording
Safari Timeline + CPU profiles in the actual app between rounds.
