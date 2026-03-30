# AGENTS.md

## Purpose

This file records implementation details and operational context that are useful during development but do not belong in the user-facing README.

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
watch_root = "~/Dropbox/EBook/"
excluded_dir_names = ["backup"]
excluded_file_suffixes = [".bak"]
pdf_renderer = "pdfjs"
#debug_open_page = 120
```

Important fields:

- `watch_root`: recursively scanned and watched
- `excluded_dir_names`: exact directory names to ignore
- `excluded_file_suffixes`: filename suffixes to ignore
- `pdf_renderer`: `"pdfjs"` or `"native"`
- `debug_open_page`: development-only override for forced page jump testing

`debug_open_page` should be treated as a diagnostic switch, not a stable user feature.

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

- jump via `debug_open_page`
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
