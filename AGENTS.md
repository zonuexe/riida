# AGENTS.md

## Purpose

This file records implementation details and operational context that are useful during development but do not belong in the user-facing README.

For a higher-level architecture and responsibility map, see [docs/design-doc.md](docs/design-doc.md).

## Release And Licensing

Release builds must satisfy the project's software licensing requirements.

In practice this means:

- the app's own license information must remain visible in the About dialog
- bundled third-party notices must be available from `THIRD-PARTY-LICENSES-rust.md` and `THIRD-PARTY-LICENSES-js.md`
- dependency license checks must pass before release or public distribution

When dependency sets change, update notices and run the checks before committing release-facing changes:

```bash
nix --extra-experimental-features 'nix-command flakes' develop --command npm run generate:third-party-licenses
nix --extra-experimental-features 'nix-command flakes' develop --command npm run check:licenses:npm
```

Combined local shortcut:

```bash
nix --extra-experimental-features 'nix-command flakes' develop --command npm run check:licenses
```

CI also checks the release gate:

- Rust dependency licenses via `cargo-deny` using [deny.toml](deny.toml)
- npm production dependency licenses via `license-checker`
- PR dependency review via [.github/dependency-review-config.yml](.github/dependency-review-config.yml)
- notice regeneration via [.github/workflows/license-check.yml](.github/workflows/license-check.yml)

If a dependency is added or updated, assume `THIRD-PARTY-LICENSES-rust.md` and `THIRD-PARTY-LICENSES-js.md` may need regeneration.

For macOS builds, the current default is ad-hoc signing via
[src-tauri/tauri.conf.json](src-tauri/tauri.conf.json).
This is intended for local verification and CI smoke testing only.
Public distribution still requires proper Apple signing and notarization.

## Design System

UI implementation references [DESIGN.md](DESIGN.md) for visual language, color roles, typography, and component patterns.

## Architecture

`riida` is a Tauri v2 desktop app with:

- Rust backend in [src-tauri/src/lib.rs](src-tauri/src/lib.rs)
- Vite/TypeScript frontend in [src/main.ts](src/main.ts)
- Styling in [src/styles.css](src/styles.css)
- Nix flake dev environment in [flake.nix](flake.nix)

The current app focus is local PDF library management with embedded reading, notes, thumbnails, and viewer preferences.

The library now also supports external, non-file-backed books such as Kindle purchases.

## Dev-Mode Icon Variant

The development build uses an alternate "cool"-palette icon to make
running dev sessions visually distinct from installed release builds in
the Dock and taskbar.

- Master sources for the dev icon live in [src-tauri/icons-dev/](src-tauri/icons-dev/),
  alongside the same generated derivatives as [src-tauri/icons/](src-tauri/icons/).
- [src-tauri/tauri.conf.dev.json](src-tauri/tauri.conf.dev.json) overrides
  `bundle.icon` to point at `icons-dev/...`.
- `npm run tauri:dev` invokes `tauri dev --config tauri.conf.dev.json` so
  the override is merged into the resolved config. Plain `npm run tauri build`
  ignores the override and uses the release icon set in `icons/`.

When the dev master is regenerated, redo the same `@tauri-apps/cli icon`
+ `magick` flow inside `icons-dev/` that the release icon set uses.

## Config, Data, Cache

The app separates storage into:

- config
- data
- cache

Current rules:

- Config prefers `~/.config/riida/riida.toml` when `~/.config` exists.
- Otherwise config falls back to the OS-native config directory.
- Data uses the OS-native app data directory.
- Cache uses the OS-native cache directory.

Legacy project-root files are migrated forward automatically:

- `riida.toml`
- `data/app.db`
- `data/thumbnails/`

When changing this logic, preserve migration behavior unless there is an explicit migration plan.

## Current Config Fields

Example development config in [riida.toml.example](riida.toml.example):

```toml
version = "0.5.1"
library_roots = ["~/Documents/Ebooks/"]
excluded_patterns = ["**/backup/**", "*.bak.pdf"]
pdf_renderer = "pdfjs"
```

Important fields:

- `version`: riida release that wrote the file. Stamped automatically on
  save. Absence on an existing config triggers `apply_pre_version_migrations`
  during startup before the file is rewritten with the current version.
- `library_roots`: recursively scanned and watched
- `excluded_patterns`: glob patterns matched against file names and paths
- `pdf_renderer`: `"pdfjs"` or `"native"`

### Migration scheme

`migrate_legacy_config_if_needed` runs once during `tauri::Builder::setup`
between `prepare_storage` and the first `load_config`. It reads the raw
`AppConfigFile`, and if `version` is absent on an existing file it:

1. Opens the SQLite DB and applies `apply_pre_version_migrations`
   (currently: flip `binding_direction` from the legacy default `"left"`
   to `"auto"` on global rows only; per-file rows stay untouched because
   they represent explicit user choices).
2. Stamps the current `CARGO_PKG_VERSION` into the file and rewrites it.

When adding a future migration, add a new step inside
`apply_pre_version_migrations` (or split into a versioned ladder if
finer granularity becomes useful). Fresh installs without a config file
skip the path entirely; the version is written on the first save.

## PDF Viewer Notes

[docs/pdf.md](docs/pdf.md) is the deeper write-up of the project-specific
PDF processing (CMap loading workaround, vertical text-layer CSS, the
WKWebView ReadableStream bug and its fix, binding-direction detection,
render-window planner, search normalization, etc.). The notes below
cover only the highest-level points.

There are two rendering paths:

- `native`: iframe/native WebView PDF display
- `pdfjs`: custom PDF.js renderer

The `pdfjs` path currently includes:

- text selection
- link overlays
- per-file and global viewer preferences
- target-page-prioritized rendering
- reading-position restore using `pageNumber + pageOffsetRatio`
- local cache in `localStorage` plus SQLite persistence

If you touch rendering order or page DOM structure, manually re-check:

- restore after changing viewer settings
- restore after reopening a file
- restore after back/forward navigation

### Binding Direction Auto-Detection

`bindingDirection` is a tri-state preference: `"auto"` (default), `"left"`,
or `"right"`. The settings panel exposes the same three values. When the
effective preference is `"auto"`, the `pdfjs` path runs detection before
laying out spreads and renders with the result; if detection is
inconclusive the renderer falls back to `"left"`. Explicit `"left"` /
`"right"` short-circuit detection.
The detection runs in three stages, in order of decreasing confidence,
expressed as pure helpers in
[src/pdf-binding-detect.ts](src/pdf-binding-detect.ts):

1. `pdfDocument.getViewerPreferences()` — `Direction === "R2L"` ⇒ right,
   `"L2R"` ⇒ left. This honors the explicit catalog hint that PDF
   producers like InDesign emit for Japanese/CJK books.
2. Vertical-CMap heuristic over sampled `getTextContent()` styles. PDFs
   using vertical CIDFont encodings (e.g. `90ms-RKSJ-V`, `UniJIS-UTF16-V`)
   surface as `style.vertical === true` in pdf.js, and are virtually
   always right-bound.
3. Geometry heuristic. Many Japanese tategaki PDFs use `/Identity-H`
   (a horizontal CMap) but place each glyph individually with its own
   text matrix, stacking them top-to-bottom. The detector accumulates
   `|Δtx|` and `|Δty|` across consecutive text items and treats a strong
   vertical bias (`Δy / Δx ≥ 1.3`) over a meaningful number of items as
   right-bound.

The render path scans up to ~50 linear pages but stops early once enough
text items are collected. The cancellation token is propagated so that
navigating away mid-detection does not waste work.

Pure-image PDFs (scanned books with no extractable text) cannot be
auto-detected and fall through to the user's saved global preference.
Per-file overrides (anything saved through the viewer-settings panel in
`file` scope) take precedence over the detector.

## EPUB Viewer Notes

EPUB support is shipped as an **in-development feature**. On first open
the viewer shows a one-time notice warning that links may not work and
that the layout may break. The notice is gated by the
`riida.epub.previewNoticeShown` key in `localStorage`.

Rendering is done with [epub.js](https://github.com/futurepress/epub.js)
in paginated flow. Reading position is persisted via CFI
(`ReadingPosition.cfi`). Keyboard navigation is wired through a
top-level `window` `keydown` listener that checks `activeEpubRendition`
and calls `rendition.next()` / `rendition.prev()`. Keyboard focus
inside the iframe is handled by a `window.blur` → `setTimeout(0)` →
`window.focus()` refocus trick so that key events always reach the
top-level listener.

The remaining known issue is **link handling** — see below.

### Known Link-Handling Issue

Link clicks inside the EPUB iframe do not behave correctly in Tauri v2
on macOS (WKWebView). As of v0.2.3 the observable symptoms are:

- `https://` and `mailto:` links: clicking them produces **no visible
  reaction**. The system browser does not open; the viewer does not
  change.
- Same-section `#anchor` links: clicking them **breaks the paginated
  layout** (e.g. the right pane shows the whole section at once) or
  navigates to the wrong spine item.

These symptoms are reproducible against the current best-effort
implementation in [src/main.ts](src/main.ts) (see the
`rendition.hooks.content.register` + `rendition.on("click")` block
inside `renderCurrentPage()`).

### Root-Cause Hypothesis

Something about cross-frame DOM interaction between the parent Tauri
WebView document and the EPUB iframe document is not behaving the way
it would in a plain browser. The narrower hypotheses worth testing:

1. **Cross-frame listeners silently fail in WKWebView.**
   `addEventListener` attached from the parent frame to the iframe's
   `contentDocument` never fires. epub.js's own `Contents.addEventListeners`
   also attaches listeners this way (with `{ passive: true }`) and
   those listeners appear to work for its internal event forwarding,
   so the failure mode may be narrower than "all cross-frame
   listeners".
2. **`link.onclick` property assignment from the parent frame is
   partially unreliable.** epub.js uses property assignment in
   `replaceLinks` to wire internal navigation, and that mechanism works
   for at least some relative links. Our overrides using the same
   pattern do not reliably fire on external / mailto links. It is
   unclear whether the assignment itself is lost or whether the click
   event does not dispatch through that property.
3. **Default navigation inside the iframe replaces the EPUB content
   before our handler runs.** If the click triggers iframe-level
   navigation to the target URL synchronously, `preventDefault` from a
   JS handler may be ineffective, and the viewer becomes blank.
4. **Tauri-level navigation filtering interacts badly.** Tauri may be
   intercepting `target="_blank"` / external-URL navigations in a way
   that neither opens the system browser nor leaves the page intact.
   An IPC-level handler (Tauri `on_navigation` / `on_page_load`) may be
   required.

### Approaches Tried (and why each failed)

All changes were in [src/main.ts](src/main.ts), inside the
`renderCurrentPage()` EPUB branch, across commits `2edc1c7` through
`2096c58`. Listed newest-first:

1. **Rewrite `href` to `javascript:void(0)` + dispatch via
   `rendition.on("click")`**. Stashed original URLs in
   `data-riida-external` / `data-riida-anchor`, deregistered epub.js's
   own `handleLinks` hook. Clean on paper, but clicks still produced
   no reaction for external / mailto and still broke layout for
   `#anchor`. Suggests the click event simply does not reach any
   handler we can register from the parent frame.
2. **`link.onclick` property assignment + keep `target="_blank"` as a
   safety net.** Prevented the "viewer disappears" failure mode when
   `preventDefault` did not actually suppress navigation, but clicks
   still did not open the system browser.
3. **`link.onclick` + `removeAttribute("target")`.** External clicks
   caused the iframe to navigate to the external URL, wiping the EPUB
   content. Confirmed that `preventDefault` alone is not sufficient.
4. **`rendition.on("rendered", ...)` + `addEventListener`.** No effect;
   the added listener never fired.
5. **`rendition.hooks.content.register` + `addEventListener`.** Same
   as above: no listener fired.

### Possible Next Steps

If and when this is picked up again, worth trying in order:

- Add visible logging inside both `hooks.content` and
  `rendition.on("click")` to verify whether they actually run in Tauri
  runtime (tests so far have not distinguished "handler never runs"
  from "handler runs but effect is masked").
- Move link interception down to Tauri: register a Rust-side
  navigation handler (`tauri::WebviewWindowBuilder::on_navigation`) and
  translate external URLs to `open` commands there. This sidesteps all
  cross-frame JS quirks.
- Inject a `<script>` tag into each EPUB section via a content hook so
  that link wiring runs *inside* the iframe, then use
  `window.__TAURI__.event.emit` (or a `MessageChannel`) to call out to
  the parent frame.
- Re-evaluate whether a different EPUB library (e.g. `foliate-js`)
  behaves better in WKWebView.

Refer to CLAUDE.md: Claude Preview does not reflect the Tauri runtime
environment. Link behavior verification requires testing in the actual
Tauri app.

## Navigation Notes

The app uses an application-level navigation stack in the frontend.

Current affordances:

- on-screen back/forward buttons
- macOS: `Command+[`, `Command+]`, `Command+Left`, `Command+Right`
- Windows/Linux: `Alt+Left`, `Alt+Right`

When changing navigation logic, verify:

- PDF -> list -> PDF transitions
- forward navigation after going back
- search result restoration
- external source restoration such as `source=kindle`

The frontend now has focused Vitest coverage for:

- library filtering and directory derivation
- navigation URL/signature helpers
- navigation shortcut detection
- reading-position cache parsing
- note window placement
- viewer layout and render-window planning
- viewer settings state merging

Prefer adding tests in these helper modules when changing logic that can be expressed without DOM rendering.

## Frontend Input And IME Notes

Text-entry flows must account for IME composition.

- Do not treat `Enter` in `keydown` as a confirmed submit action while composition is active.
- Prefer guarding submit shortcuts with both `event.isComposing` and a local composition-state flag from `compositionstart` / `compositionend`.
- For Enter handling in text inputs, also treat `keyCode === 229` as IME-related and avoid submitting in that case.

Re-check these behaviors manually when changing text-entry UI such as:

- tag editing
- metadata editing and JSON import
- search fields with keyboard shortcuts
- future inline editors or rename flows

## Book Metadata Notes

Books can store editable metadata for:

- title
- authors
- description
- publisher
- release date
- language
- URL
- ASIN
- cover URL

Metadata editing exists for both local PDF books and external books.

Current behaviors:

- authors are edited as one author per line
- release dates must use `YYYY-MM-DD`
- JSON import is a patch format where missing keys keep values unchanged and `null` clears that field
- if the visible form is empty but JSON patch text is present, `Save and close` applies the JSON patch before saving
- completely empty metadata must not be saved

Deletion semantics differ by source:

- local PDF books: the delete action clears saved metadata only
- Kindle books: the delete action removes the external book entry itself

Keep these semantics in mind when changing the metadata modal or backend commands.

## External Library Notes

Kindle purchases are currently modeled as external books with synthetic `file_path` values such as
`kindle:<asin-or-uuid>`.

Current frontend behaviors:

- the sidebar shows an `EXTERNAL` section
- Kindle books are reachable from `Kindle` under that section
- external sources participate in app-level navigation state via `source=...`
- Kindle books appear in the main list, can be searched, tagged, and edited
- Kindle books are not openable in the PDF viewer; activating them opens metadata editing instead

## SQLite Notes

The backend currently stores at least:

- indexed books
- external books
- book tags
- book metadata
- notes
- viewer preferences
- reading positions

Schema setup lives in the startup `CREATE TABLE IF NOT EXISTS` block in [src-tauri/src/lib.rs](src-tauri/src/lib.rs).

If schema semantics change, consider migration behavior early.

## Vendored Frontend Assets

- Font Awesome 7.2.0 is vendored under [src/vendor/fontawesome](src/vendor/fontawesome).
- The current vendored subset includes `solid`, `brands`, and `regular` styles plus only the required webfonts.
- Keep only the minimum required files when updating vendored assets.
- Preserve the upstream license file alongside the vendored copy.

## Local Verification

Common local checks:

```bash
nix --extra-experimental-features 'nix-command flakes' develop --command npm run check
```

Release-facing verification shortcut:

```bash
nix --extra-experimental-features 'nix-command flakes' develop --command npm run check:release
```

Or run the narrower commands when iterating on one area:

```bash
nix --extra-experimental-features 'nix-command flakes' develop --command npm run check:rust
nix --extra-experimental-features 'nix-command flakes' develop --command npm run check:frontend
```

Or run the smallest commands directly:

```bash
nix --extra-experimental-features 'nix-command flakes' develop --command npm run rust:fmt:check
nix --extra-experimental-features 'nix-command flakes' develop --command npm run rust:lint
nix --extra-experimental-features 'nix-command flakes' develop --command npm run lint
nix --extra-experimental-features 'nix-command flakes' develop --command npm run fmt:check
nix --extra-experimental-features 'nix-command flakes' develop --command cargo nextest run --manifest-path src-tauri/Cargo.toml
nix --extra-experimental-features 'nix-command flakes' develop --command npm test
nix --extra-experimental-features 'nix-command flakes' develop --command cargo check --manifest-path src-tauri/Cargo.toml
nix --extra-experimental-features 'nix-command flakes' develop --command npm run build
```

## Rust Quality Tools

Rust logic now uses both example-based unit tests and property-based tests.

- deterministic unit tests live in [src-tauri/src/lib.rs](src-tauri/src/lib.rs)
- property-based tests use `proptest`

Good candidates for future `proptest` coverage:

- config normalization
- viewer preference normalization and merging
- reading-position normalization
- watcher rescan decisions

Mutation testing is not part of normal CI yet, but `cargo-mutants` is the preferred tool for periodic local audits.

Suggested local workflow:

```bash
cargo install cargo-mutants --locked
nix --extra-experimental-features 'nix-command flakes' develop --command npm run mutants:rust:list
nix --extra-experimental-features 'nix-command flakes' develop --command npm run mutants:rust
```

Use mutation testing selectively on logic-heavy Rust code because it is much slower than the normal test suite.

The frontend has a parallel mutation-testing setup via
[Stryker](https://stryker-mutator.io). It is not part of `check:frontend`
for the same speed reasons. Configuration lives in
[stryker.config.json](stryker.config.json) and excludes DOM-driven
entry points (`src/main.ts`, `src/note-editor.ts`) and the large
`cjk-radical-map.ts` data module.

```bash
nix --extra-experimental-features 'nix-command flakes' develop --command npm run mutants:frontend
nix --extra-experimental-features 'nix-command flakes' develop --command npx stryker run --mutate "src/<module>.ts"
```

Stryker runs incrementally (`incremental: true`) so subsequent runs
only re-test mutated regions. The HTML report is written to
`reports/mutation/mutation.html`. Both `reports/` and `.stryker-tmp/`
are gitignored.

Standard Rust static checks:

```bash
nix --extra-experimental-features 'nix-command flakes' develop --command npm run rust:fmt:check
nix --extra-experimental-features 'nix-command flakes' develop --command npm run rust:lint
nix --extra-experimental-features 'nix-command flakes' develop --command npm run rust:machete
nix --extra-experimental-features 'nix-command flakes' develop --command npm run rust:audit
```

`rust:lint` currently runs `cargo clippy --all-targets -- -D warnings`.
`rust:machete` runs `cargo machete src-tauri` to detect unused
Cargo dependencies. `rust:audit` runs `cargo audit` against the
RustSec Advisory Database; by default it exits 0 on `unmaintained`
warnings (mostly transitive GTK / Tauri ecosystem crates we cannot
fix locally) and exits non-zero when an actual vulnerability is
reported.

Project defaults live in [.cargo/mutants.toml](.cargo/mutants.toml), and currently focus on [src-tauri/src/lib.rs](src-tauri/src/lib.rs).

## Frontend Naming Conventions

Interactive HTML elements that are referenced from both JavaScript and CSS
use matching `id` and `class` names on the same element, for example:

```html
<button id="viewer-settings-toggle" class="viewer-settings-toggle">
```

The `id` is the JavaScript handle (`querySelector("#viewer-settings-toggle")`).
The `class` is the CSS selector (`.viewer-settings-toggle { … }`).
Keeping the two names identical makes the JS–CSS relationship obvious without
introducing separate `data-*` attributes.

This is the established pattern across the viewer overlay controls and viewer
settings panel. Follow it when adding new singleton interactive elements.

## Frontend Linting And Formatting

The frontend now uses the Oxc toolchain:

- `oxlint` for TypeScript linting
- `oxfmt` for formatting checks

Primary commands:

```bash
nix --extra-experimental-features 'nix-command flakes' develop --command npm run lint
nix --extra-experimental-features 'nix-command flakes' develop --command npm run lint:fix
nix --extra-experimental-features 'nix-command flakes' develop --command npm run fmt
nix --extra-experimental-features 'nix-command flakes' develop --command npm run fmt:check
```

Current scope is intentionally narrow:

- `src`
- `index.html`
- `vite.config.ts`

This keeps adoption simple while still covering the main frontend code path.

## Frontend Boundary Schemas

External payloads parsed by the frontend (cached `localStorage`
entries, JSON metadata patches) go through
[valibot](https://valibot.dev) schemas instead of hand-rolled type
guards. Today this covers:

- `parseCachedReadingPosition` in
  [src/reading-position-utils.ts](src/reading-position-utils.ts)
- `parseBookMetadataImport` in
  [src/book-metadata-utils.ts](src/book-metadata-utils.ts)

When adding a new persistence boundary or external-input parser,
prefer a valibot schema over inline `typeof` checks so the validation
contract is co-located and reusable.

## Frontend Property-Based Tests

Frontend property tests use [fast-check](https://github.com/dubzzz/fast-check)
and live in [src/property-tests.test.ts](src/property-tests.test.ts).
They cover invariants of clamp / parser / planner helpers that pair
naturally with proptest in Rust.

Notes:

- `fc.property` predicates return booleans; do not call `expect`
  conditionally inside them, since `eslint-plugin-jest`'s
  `no-conditional-expect` rule will flag it. Use a single
  `expect(true).toBe(true)` after `fc.assert` to keep Vitest happy.
- New invariants should focus on the same kind of helper modules
  already covered by deterministic tests (config normalization,
  reading positions, navigation, viewer layout).

## Frontend Test Coverage

`vitest run --coverage` (alias `npm run test:coverage`) produces a
v8-based coverage report and fails if coverage drops below the
thresholds configured in [vite.config.ts](vite.config.ts).

```bash
nix --extra-experimental-features 'nix-command flakes' develop --command npm run test:coverage
```

`check:frontend` runs `test:coverage` instead of plain `test`, so any
regression below the thresholds breaks the verification pipeline.

`src/main.ts`, `src/note-editor.ts`, the vendored assets, and
`src/cjk-radical-map.ts` are excluded from coverage because they are
DOM-driven entry points or large data files that the helper-module
test strategy does not target.

## Dead-Code Detection

`knip` checks for unused files, exports, and dependencies in the frontend.

```bash
nix --extra-experimental-features 'nix-command flakes' develop --command npm run knip
```

It runs as part of `npm run check:frontend`. Configuration lives in
[knip.json](knip.json). The `types` rule is intentionally disabled because
many exported types describe the parameter shapes of exported functions
and are kept for callers to name.

`npm run check:frontend` now ends with a lightweight bundle-size report from
[scripts/report-bundle-size.mjs](scripts/report-bundle-size.mjs)
so large asset growth is visible in local runs and CI logs.

## Notes

Notes use a floating Milkdown editor and persist to SQLite.

Current behavior:

- autosave is debounced
- panel position and size are frontend-managed
- save status is intentionally understated in the UI

## Thumbnails

Thumbnail generation is currently macOS-oriented:

- `/usr/bin/qlmanage`
- `/usr/bin/sips`

Cache lives in the app cache directory.

Cross-platform thumbnail support will require a new strategy.
