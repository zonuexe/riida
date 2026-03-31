# AGENTS.md

## Purpose

This file records implementation details and operational context that are useful during development but do not belong in the user-facing README.

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

CI also checks the release gate:

- Rust dependency licenses via `cargo-deny` using [deny.toml](/Users/megurine/repo/rust/riida/deny.toml)
- npm production dependency licenses via `license-checker`
- PR dependency review via [.github/dependency-review-config.yml](/Users/megurine/repo/rust/riida/.github/dependency-review-config.yml)
- notice regeneration via [.github/workflows/license-check.yml](/Users/megurine/repo/rust/riida/.github/workflows/license-check.yml)

If a dependency is added or updated, assume `THIRD-PARTY-LICENSES-rust.md` and `THIRD-PARTY-LICENSES-js.md` may need regeneration.

For macOS builds, the current default is ad-hoc signing via
[src-tauri/tauri.conf.json](/Users/megurine/repo/rust/riida/src-tauri/tauri.conf.json).
This is intended for local verification and CI smoke testing only.
Public distribution still requires proper Apple signing and notarization.

## Architecture

`riida` is a Tauri v2 desktop app with:

- Rust backend in [src-tauri/src/lib.rs](/Users/megurine/repo/rust/riida/src-tauri/src/lib.rs)
- Vite/TypeScript frontend in [src/main.ts](/Users/megurine/repo/rust/riida/src/main.ts)
- Styling in [src/styles.css](/Users/megurine/repo/rust/riida/src/styles.css)
- Nix flake dev environment in [flake.nix](/Users/megurine/repo/rust/riida/flake.nix)

The current app focus is local PDF library management with embedded reading, notes, thumbnails, and viewer preferences.

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

Example development config in [riida.toml](/Users/megurine/repo/rust/riida/riida.toml):

```toml
library_roots = ["~/Documents/Ebooks/"]
excluded_dir_names = ["backup"]
excluded_file_suffixes = [".bak"]
pdf_renderer = "pdfjs"
```

Important fields:

- `library_roots`: recursively scanned and watched
- `excluded_dir_names`: exact directory names to ignore
- `excluded_file_suffixes`: filename suffixes to ignore
- `pdf_renderer`: `"pdfjs"` or `"native"`

## PDF Viewer Notes

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

## SQLite Notes

The backend currently stores at least:

- indexed books
- notes
- viewer preferences
- reading positions

Schema setup lives in the startup `CREATE TABLE IF NOT EXISTS` block in [src-tauri/src/lib.rs](/Users/megurine/repo/rust/riida/src-tauri/src/lib.rs).

If schema semantics change, consider migration behavior early.

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
