# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-04-08

### Added

- MCP server (`riida-mcp`) for metadata enrichment via Claude — reads PDF content and file paths to infer and bulk-update title, authors, publisher, and other fields directly in the library database.
- `search_books` MCP tool for filtering the library by directory, path, title, author, tag, or missing-metadata status.
- File paths are now normalized to NFC on macOS, and existing NFD paths in the database are migrated automatically to avoid duplicate entries.

### Fixed

- MCP server now connects to the correct database location using the Tauri bundle identifier.

## [0.1.4] - 2026-04-05

### Added

- Book list entries now show an Amazon link for books with an ASIN, and a URL link for books with a URL.
- Custom external sources can be created in Settings with a chosen name and icon, for tracking physical books, library loans, and other non-digital collections. Each source appears in the sidebar under External and supports adding, editing, and deleting books independently.

### Changed

- External book entries (Kindle and custom sources) no longer show a redundant source label in the book list.

## [0.1.3] - 2026-04-05

### Fixed

- Cover images for Kindle books now display correctly in the library; they were previously blocked by the Content Security Policy.
- Registering a Kindle book whose ASIN is already in the library now shows an error dialog instead of silently overwriting the existing entry.

## [0.1.2] - 2026-04-03

### Added

- PDF books in the library can now have editable metadata (title, authors, description, publisher, release date, language, optional links and identifiers, and cover image URL), stored locally and shown in the book list.
- Amazon Kindle books can be kept in the library with their own metadata; you can edit the same fields as for PDFs, import updates from JSON, and remove a Kindle entry together with its notes, tags, and related data.
- The metadata editor supports applying a JSON patch (with an in-app example), and you can clear saved PDF metadata or delete a Kindle book after confirming in a dialog.

### Changed

- Rust release checks now satisfy the Clippy `manual_is_multiple_of` lint (no change to release-date validation behavior).

## [0.1.1] - 2026-04-03

### Fixed

- Books that newly match `excluded_patterns` are now removed correctly on config-triggered rescans, so stale search results do not remain visible.
- Choosing a tag autocomplete suggestion now adds the selected hierarchical tag instead of the raw text currently typed into the editor.

## [0.1.0] - 2026-04-03

### Added

- Books can now have editable tags, including hierarchical tags, partial autocomplete while typing, and tag-based filtering from the sidebar and book list.

### Changed

- Tag browsing is more flexible: tag trees can be expanded and collapsed, direct-child filtering is available where it matters, and displayed counts now stay aligned with the active filter.
- Reader navigation and overlay controls were refined so back/forward actions and in-view tools feel easier to reach while reading.

### Fixed

- Tag entry now handles IME composition more safely, avoiding accidental confirmation while composing text.

## [0.0.7] - 2026-04-02

### Changed

- Library items now show their parent directory instead of repeating the file name, and home-directory paths are shortened to `~/...`.

## [0.0.6] - 2026-04-02

### Changed

- First-run setup is smoother: when no `riida.toml` exists yet, the Settings dialog now opens automatically so you can choose library folders immediately.
- Library settings now explain the PDF renderer choices more clearly, and the default exclusion example is aligned with PDF-only usage as `*.bak.pdf`.
- Development builds now keep config, data, and cache under the repository root so everyday testing does not interfere with real user data.

### Fixed

- Empty or misconfigured libraries no longer stay on a `Loading...` placeholder. The app now explains whether library folders are missing, empty, or just have no matching PDFs.
- The About dialog now loads bundled license texts correctly in development mode.

## [0.0.5] - 2026-04-02

### Changed

- Initial app loading is now lighter because PDF.js, the PDF worker, and the note editor are loaded on demand, and the PDF.js runtime uses smaller minified bundles.

### Fixed

- The Settings modal once again opens closed by default and can be dismissed normally.
- Reader layout sizing was adjusted so the main pane no longer leaves an extra gap at the bottom, while Home and search results remain scrollable.

## [0.0.4] - 2026-04-01

### Changed

- Library exclusion rules now use a unified `excluded_patterns` glob list instead of separate directory-name and file-suffix settings.

## [0.0.3] - 2026-03-31

### Changed

- PDF.js rendering now keeps only the current reading area and nearby spreads rendered, reducing memory use while scrolling through large PDFs.
- Third-party license notices are now split into Rust and JavaScript files, and repeated Apache License 2.0 bodies are consolidated into a shared appendix section.

## [0.0.2] - 2026-03-31

### Changed

- Release automation and bundled license notice generation were corrected for CI and cross-platform packaging.
- No user-visible feature changes were included in this release.

## [0.0.1] - 2026-03-31

### Added

- Initial desktop release of `riida` as a local PDF library manager and built-in reader.
- Automatic library indexing for PDF files under configurable `library_roots`.
- Background library watching for new, changed, and removed PDF files.
- Searchable library browsing with a collapsible sidebar and directory tree.
- Built-in PDF reading with a choice between native WebView rendering and `pdf.js`.
- Configurable PDF.js reading modes including single-page and two-page spreads, binding direction, zoom mode, alignment, cover handling, and vertical spacing.
- Reader navigation with on-screen back and forward controls plus platform-native keyboard shortcuts.
- Reading position restore for reopened files and viewer reconfiguration.
- Floating per-book notes with Milkdown-based rich editing and automatic SQLite persistence.
- Thumbnail generation and caching for library items.
- In-app settings for library roots, exclusions, and PDF renderer selection.
- In-app About dialog with version, build date, project license, repository link, and third-party license notices.

### Changed

- Viewer preferences can now be stored either globally or per file.
- Storage paths now follow platform-aware config, data, and cache conventions.
- The primary user interface is now presented in simplified English.

### Removed

- Reading progress counters and page-tracking UI were removed in favor of position restore only.

[Unreleased]: https://github.com/zonuexe/riida/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/zonuexe/riida/compare/v0.1.4...v0.2.0
[0.1.4]: https://github.com/zonuexe/riida/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/zonuexe/riida/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/zonuexe/riida/releases/tag/v0.1.2
[0.1.1]: https://github.com/zonuexe/riida/releases/tag/v0.1.1
[0.1.0]: https://github.com/zonuexe/riida/releases/tag/v0.1.0
[0.0.7]: https://github.com/zonuexe/riida/releases/tag/v0.0.7
[0.0.6]: https://github.com/zonuexe/riida/releases/tag/v0.0.6
[0.0.5]: https://github.com/zonuexe/riida/releases/tag/v0.0.5
[0.0.4]: https://github.com/zonuexe/riida/releases/tag/v0.0.4
[0.0.3]: https://github.com/zonuexe/riida/releases/tag/v0.0.3
[0.0.2]: https://github.com/zonuexe/riida/releases/tag/v0.0.2
[0.0.1]: https://github.com/zonuexe/riida/releases/tag/v0.0.1
