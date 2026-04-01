# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/zonuexe/riida/compare/v0.0.5...HEAD
[0.0.5]: https://github.com/zonuexe/riida/releases/tag/v0.0.5
[0.0.4]: https://github.com/zonuexe/riida/releases/tag/v0.0.4
[0.0.3]: https://github.com/zonuexe/riida/releases/tag/v0.0.3
[0.0.2]: https://github.com/zonuexe/riida/releases/tag/v0.0.2
[0.0.1]: https://github.com/zonuexe/riida/releases/tag/v0.0.1
