# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.1] - 2026-05-21

### Added

- The standalone viewer window now carries the same reading chrome as the in-app reader. It gains back/forward history, a page-number jump field, a table-of-contents panel (built from the PDF outline or the EPUB navigation document), the viewer settings panel with global and per-file scopes, and tag and metadata editing. Clicking an in-document PDF link — a table-of-contents entry or cross-reference — jumps to its destination and records the jump in the back/forward history. The Tags and Metadata buttons stay hidden until the settings menu is opened so they never cover the page while reading.

### Changed

- Opening a book in the viewer window is noticeably quicker to become usable: the page you left off at is rendered first, instead of rendering sequentially from page 1. The viewer window also inherits the viewer preferences saved for the book and matches the in-app viewer's spread style — the two pages of a spread sit flush and carry the same soft page shadow.
- Background color, scroll mode, and EPUB font size changed from the viewer window's settings panel now apply in place; only layout changes (page mode, binding direction, cover handling) reload the window.

### Fixed

- The viewer window no longer snaps back to the top of the document shortly after opening to a saved reading position.
- The viewer background color picker now works: choosing a swatch applies the color to the reading surface, and the frosted overlay chrome (table-of-contents button, settings panel) refreshes instead of keeping the previous color.

## [0.6.0] - 2026-05-16

### Added

- Books can now be opened in a standalone viewer window. Cmd-click on macOS (Ctrl-click on Windows and Linux) on any library row pops the book out into its own window — the same convention web browsers use for "open link in new window" — while a plain click keeps opening books inside the main window as before. The viewer window renders both PDF and EPUB, scales pages to the window height as you resize it, lays out spreads with automatic binding-direction detection (right-bound Japanese books read right-to-left), restores the saved reading position, and hosts the same floating notes panel as the library shell. Notes, reading position, and tags stay in sync across windows because both share the same local SQLite store.
- Keyboard navigation in the viewer window: PageUp / PageDown, Shift+Space / Space, and the arrow keys all advance or rewind by one spread. In right-bound books, ArrowLeft advances and ArrowRight goes back so the keys follow reading order. Home and End jump to the first and last spread. System shortcuts such as Cmd+Space continue to reach the OS without being captured by the viewer.

### Fixed

- Editing notes and then navigating away from the current book (Home, Back, or picking another book in the library) on macOS no longer freezes the app. The renderer previously hung hard enough that Cmd+Q stopped working; the new teardown keeps each Milkdown editor instance in memory for the rest of the session instead of unmounting it.

## [0.5.5] - 2026-05-15

### Added

- Right-click any tag in the sidebar to rename it or remove it from every book. Renames cascade across nested tags (renaming `programming` also rewrites `programming/rust` and similar sub-tags), and the dialog shows how many books and sub-tags will be affected before you commit. Useful for cleaning up accidental bulk tagging.

### Fixed

- The library's "Select all" bulk action now only selects books currently visible under the active search, shelf, directory, tag, or external-source filter, instead of pulling in every book in the library.

## [0.5.4] - 2026-05-13

### Added

- Time-based search operators for shelves and the search box, following Gmail's query syntax. `newer_than:7d` finds books read in the past seven days; `older_than:1y` finds books last read more than a year ago; `after:2026/01/01` and `before:2026/04/01` filter by an absolute date. The `added_*` variants (`added_newer_than:`, `added_after:`, etc.) apply the same filters to a book's library-added date instead of its last-read date.
- Online user manual published at <https://zonuexe.github.io/riida/>, covering installation, library setup, organizing, PDF and EPUB reading, themes, and viewer settings. Available in Japanese and English.

## [0.5.3] - 2026-05-06

### Added

- Shelves — a new fourth sidebar axis alongside Directories, Tags, and External. A shelf is a saved query you give a name to, register in the sidebar, and open like any other location. Edit a shelf through either a structured All / Any condition builder (field × operator × value) or a raw Custom query, with a live preview count and an icon picker. Right-click a shelf to edit it; drag-and-drop to reorder.
- The search query language now accepts `AND`, `OR`, `NOT` keywords (uppercase) and parenthesised grouping, in addition to the existing implicit AND, leading-`-` negation, and `field:value` tokens. The same grammar drives both the sidebar search box and shelves.
- Inline autocomplete for `tag`, `publisher`, `language`, and `source` values inside the Shelf editor, sourced from the current library.
- A "save current search" bookmark button next to the sidebar search field. Whatever is typed there can be promoted to a shelf in one click.
- A "Select all" action in the library's bulk-action bar, visible once at least one item is checked.
- Sidebar sections (Directories / Tags / External / Shelves) can be reordered by drag-and-drop, with the order persisted across launches.
- The External section now offers the same editor UX as Shelves: a `+` button on the section header to create a new custom source, right-click on a custom source to edit, and a Delete button inside the modal.
- Common reader keyboard shortcuts, with the resulting jumps recorded as in-file history entries so they can be navigated back through.

### Changed

- `title:` searches fall back to the file name when a book has no metadata title set, so books without metadata are still findable by what is shown as their title in the library list.
- Bulk selection is automatically cleared when switching the active directory, tag, external source, or shelf.

## [0.5.2] - 2026-05-05

### Added

- PDF binding direction is now auto-detected by default (`auto`), inspecting the PDF's viewer preferences, vertical CMap usage, and glyph placement geometry to choose left- or right-binding for spreads. Existing global `left` defaults are migrated to `auto` on first launch; per-file overrides are preserved.
- App icon redesigned with a full-bleed layout for the macOS Tahoe appearance, with squircle corners baked into both release and development icon variants for consistent rendering across macOS, Windows, and Linux.
- Development builds now use an alternate cool-palette icon variant so dev sessions are visually distinct from installed release builds in the Dock and taskbar.

### Fixed

- PDF text selection in vertical-CJK (tategaki) documents now works correctly in the PDF.js viewer.
- Text content extraction in the PDF.js viewer no longer hits a WKWebView bug that could cause text-layer reads to fail; the renderer now uses a stream-reader-based path.

### Changed

- The `riida.toml` config file now records the `riida` version that wrote it, and one-time pre-version migrations run automatically on first launch of an upgraded build.

## [0.5.1] - 2026-05-05

### Changed

- Scrolling through long book lists is noticeably smoother. Off-screen rows now skip layout and paint via `content-visibility`, thumbnail images reserve space up-front so image loads no longer reflow rows, hover transitions on row controls are suppressed while actively scrolling, and the thumbnail observer no longer scans the full library on every callback.

## [0.5.0] - 2026-05-03

### Changed

- Library refresh now wraps per-book INSERT statements in a single SQLite transaction, so a full library scan issues one journal sync instead of one per indexed book. This noticeably reduces disk and CPU usage during startup and after metadata edits.
- Metadata save, app settings save, and custom source save/delete flows now use a new lightweight `load_library_snapshot` command that loads the cached snapshot from the database without re-walking the filesystem.
- The file-system watcher debounce window has been lengthened from 250 ms to 750 ms, and reading-position autosave debounce from 300 ms to 1 s, to coalesce bursts during normal reading and reduce background writes.

## [0.4.3] - 2026-05-03

### Changed

- The sidebar collapse toggle now stays half-embedded in the screen edge in both expanded and collapsed sidebar states, keeping it visually anchored and clear of the history navigation buttons. Left-aligned viewer overlay controls (history navigation, EPUB TOC toggle, EPUB TOC panel) share a single left baseline that no longer overlaps the toggle.

## [0.4.2] - 2026-05-01

### Fixed

- Non-embedded Adobe-Japan1 PostScript fonts (Ryumin-Light, GothicBBB-Medium) now render correctly in release builds by aliasing them to system Hiragino fonts via CSS @font-face declarations with local() lookup. Previous attempts to fix this via CSP style-src 'unsafe-inline' were ineffective because Tauri's inline style hashes neutralize 'unsafe-inline' directives, but explicit style-src-elem and font-src CSP directives plus local()-based font aliases resolve the issue without relying on unsafe CSP permissions.

## [0.4.1] - 2026-05-01

### Added

- Multi-book bulk-edit mode for tags and metadata in the library list.
- Reveal in Finder button on library list items.
- Windows x64 build workflow for CI.

### Fixed

- PDF.js scroll position is now preserved correctly across resize-triggered re-renders and layout rebuilds.
- PDF reading position within a two-page spread now anchors to the head-side page.
- Stale render tokens no longer cause layout build errors in the PDF viewer.
- Inline styles are now permitted in the Content Security Policy so PDF.js font injection works correctly in release builds.

## [0.4.0] - 2026-04-30

### Added

- Library books can now be sorted by title (A→Z or Z→A), last read date, file size, and added date (newest or oldest).
- Books now track their indexed date for sorting and filtering purposes.

### Changed

- Sorting preference resets to default when navigating to a different directory, tag, or external source.

## [0.3.4] - 2026-04-29

### Added

- Grid view mode in the library with a hover popup showing book details.
- Landscape PDF pages are now displayed single-page when in fit-height + two-page spread mode, preventing cut-off pages that cannot fit side by side.

### Changed

- Library search input is now debounced by 150 ms to reduce unnecessary filtering while typing.

## [0.3.3] - 2026-04-27

### Added

- Structured search query language with field filters (`title:`, `author:`, `tag:`, `read:`) and negation (`-`).
- Search query autocomplete for field names and field values.
- `read:` field filter for filtering books by last read date.

### Fixed

- Non-embedded standard Japanese fonts (Ryumin-Light, GothicBBB-Medium) now render correctly in the PDF.js viewer instead of showing garbled Latin glyphs.
- Search field no longer appends a trailing space after autocompleting a field name.
- Search field no longer trims trailing spaces from input.

## [0.3.2] - 2026-04-26

### Added

- Table of contents (TOC) button in the PDF and EPUB viewer. Clicking the button opens a scrollable panel listing chapter headings; clicking a heading navigates directly to that section.

### Changed

- Navigation back/forward controls and the new TOC button are now aligned to the same left offset (`14px`) for a tidier left-side viewer chrome.
- EPUB cover pages are now rendered at full viewer size in fixed-layout (pre-paginated) books.
- EPUB font size is now adjustable from the viewer settings panel.

## [0.3.1] - 2026-04-20

### Added

- EPUB cover thumbnail extraction from manifest, with automatic format conversion to JPEG.
- EPUB metadata auto-import directly from the OPF manifest (title, authors, publisher, language).
- EPUB internal link history and CFI-based anchor navigation for smoother cross-section browsing.
- Paged scroll mode for PDF.js viewer as an alternative to continuous scrolling.
- CSS injection for EPUB vertical writing mode, fixing rendering of Japanese and other vertical-text publications.

### Fixed

- Release date input now normalizes on blur in the metadata editor.

## [0.3.0] - 2026-04-18

### Added

- Viewer background colors: inherit the app theme or pick explicit palettes for reading (PDF.js and EPUB).
- EPUB viewer vertical gap mode (wide, compact, or none), aligned with PDF.js layout options.
- Faster EPUB reopening by caching pagination metadata locally, plus a loading indicator while the book prepares.

### Changed

- Viewer colors apply to the EPUB reading surface; EPUB reader chrome was refined alongside background settings.

### Fixed

- EPUB vertical gap now respects the reader inset reliably.
- EPUB reading is more stable on macOS WebKit (initial viewport sizing and iframe sandbox compatibility with epub.js).

## [0.2.5] - 2026-04-18

### Added

- PDF.js viewer now supports in-document text search with keyword highlighting and next/previous navigation.
- Global app themes can now be changed from Settings, including `Snow White`, `Night City`, and `Navy Blue`.
- EPUB viewer now shows page numbers and total page counts more clearly while reading.

### Fixed

- EPUB links now behave more reliably inside the reader.
- EPUB pagination now resizes correctly after sidebar changes and window resizes.
- The selected app theme now applies cleanly from app startup without briefly flashing a different background.
- PDF search now treats CJK radical variants more consistently, improving match behavior for affected text.

## [0.2.4] - 2026-04-17

### Fixed

- macOS Apple Silicon release builds now package successfully again by aligning the bundled Tauri dialog plugin versions.

## [0.2.3] - 2026-04-16

### Added

- EPUB viewer (in-development feature) supporting paginated display, keyboard navigation, and reading position persistence using epub.js.
- First-time EPUB user warning notice explaining known limitations.

### Changed

- Book list now displays the configured metadata title when available, instead of always showing the filename.

### Fixed

- Search query is now cleared when selecting a directory from the sidebar.
- EPUB keyboard navigation focus handling improved.

## [0.2.2] - 2026-04-12

### Fixed

- Pressing Cancel or Escape on the PDF password dialog now navigates back to the previous screen instead of looping indefinitely or leaving a stale loading view.

## [0.2.1] - 2026-04-09

### Added

- Password-protected PDFs are now supported when using the PDF.js renderer. On first open the app prompts for a password; once entered correctly the password is saved and future opens are seamless.

### Changed

- The project-local MCP server now runs directly from the in-tree implementation instead of the published npm package, so local development always uses the latest code.

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

[Unreleased]: https://github.com/zonuexe/riida/compare/v0.6.1...HEAD
[0.6.1]: https://github.com/zonuexe/riida/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/zonuexe/riida/compare/v0.5.5...v0.6.0
[0.5.5]: https://github.com/zonuexe/riida/compare/v0.5.4...v0.5.5
[0.5.4]: https://github.com/zonuexe/riida/compare/v0.5.3...v0.5.4
[0.5.3]: https://github.com/zonuexe/riida/compare/v0.5.2...v0.5.3
[0.5.2]: https://github.com/zonuexe/riida/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/zonuexe/riida/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/zonuexe/riida/compare/v0.4.3...v0.5.0
[0.4.3]: https://github.com/zonuexe/riida/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/zonuexe/riida/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/zonuexe/riida/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/zonuexe/riida/compare/v0.3.4...v0.4.0
[0.3.4]: https://github.com/zonuexe/riida/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/zonuexe/riida/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/zonuexe/riida/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/zonuexe/riida/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/zonuexe/riida/compare/v0.2.5...v0.3.0
[0.2.5]: https://github.com/zonuexe/riida/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/zonuexe/riida/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/zonuexe/riida/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/zonuexe/riida/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/zonuexe/riida/compare/v0.2.0...v0.2.1
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
