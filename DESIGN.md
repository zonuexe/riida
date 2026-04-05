# DESIGN.md

## Overview

`riida` is a Tauri v2 desktop application for managing and reading a local PDF library, with support for:

- indexed PDF books from configured library roots
- external books that are not backed by local files, currently Kindle purchases
- per-book tags
- editable book metadata
- reading positions
- floating notes
- viewer preferences
- thumbnail generation

The application is split into a Rust backend and a TypeScript frontend.

## Top-Level Structure

- Backend: [src-tauri/src/lib.rs](src-tauri/src/lib.rs)
- Frontend entry: [src/main.ts](src/main.ts)
- Frontend styles: [src/styles.css](src/styles.css)
- Frontend helpers: [src/*.ts](src)
- App shell: [index.html](index.html)

## Runtime Model

### Backend

The Rust side is responsible for:

- loading and normalizing app config
- choosing config/data/cache paths and migrating legacy layouts
- scanning library roots and indexing PDF books into SQLite
- maintaining a filesystem watcher and rescanning when needed
- generating thumbnails
- storing and loading:
  - tags
  - notes
  - metadata
  - viewer preferences
  - reading positions
  - external books

The frontend talks to the backend through Tauri commands and event listeners.

Important commands include:

- `library_snapshot`
- `load_app_config`
- `save_app_config`
- `book_thumbnail`
- `load_note`
- `save_note`
- `save_book_tags`
- `load_book_metadata`
- `save_book_metadata`
- `delete_book_metadata`
- `load_reading_position`
- `save_reading_position`
- `load_viewer_preferences`
- `save_default_viewer_preferences`
- `save_file_viewer_preferences`
- `clear_file_viewer_preferences`

Important backend events include:

- `library-updated`
- `library-watch-error`
- `thumbnail-ready`

### Frontend

The TypeScript side is responsible for:

- rendering the shell, sidebar, list view, viewer, and modals
- maintaining UI state and application-level navigation history
- invoking backend commands
- rendering the PDF viewer in either native or PDF.js mode
- composing helper modules for filtering, navigation, page jump, tag suggestions, metadata import, and related UI logic

The frontend is intentionally stateful in one large entry module, with pure logic extracted into helper modules that are covered by Vitest.

## Core Data Model

### BookSummary

The frontend list and navigation are built around a `BookSummary` shape that includes:

- `fileName`
- `filePath`
- `fileSize`
- `tags`
- `authors`
- `sourceType`
- `coverUrl`
- `locationLabel`
- `isOpenable`

Two important `sourceType` values currently exist:

- `pdf`
- `kindle`

`filePath` is the stable identifier across most of the app.

For external books, `filePath` is synthetic, for example:

- `kindle:B09MLLNP2B`
- `kindle:<uuid>`

### LibrarySnapshot

The backend returns a `LibrarySnapshot` that includes:

- configured library roots
- existing and missing roots
- indexed book count
- merged list of PDF books and external books
- excluded patterns
- active PDF renderer mode

The frontend treats `LibrarySnapshot.books` as the source of truth for the visible library.

## Storage Architecture

### Paths

The app separates:

- config
- data
- cache

In development builds, the repository-root layout is used so local testing does not conflict with the installed app layout.

Legacy layouts are migrated forward automatically.

### SQLite Tables

Current important tables include:

- `books`
  - indexed local PDF files
- `external_books`
  - non-file-backed books such as Kindle purchases
- `book_tags`
  - normalized tags keyed by `file_path`
- `book_metadata`
  - editable metadata for local PDF books
- `notes`
  - book notes
- `viewer_preferences`
  - global and per-file viewer settings
- `reading_positions`
  - last read page and offset ratio

### Metadata Semantics

Metadata is editable for both PDF books and external books.

Fields currently supported:

- title
- authors
- description
- publisher
- release date
- language
- URL
- ASIN
- cover URL

Behavioral rules:

- authors are stored as a JSON array
- release date must use `YYYY-MM-DD`
- empty strings are normalized on save
- JSON import acts as a patch:
  - missing keys mean no change
  - `null` means clear the field
- completely empty metadata must not be saved
- if the form is empty but JSON import text exists, the JSON patch is applied before save

Deletion rules differ by source:

- local PDF books: delete clears stored metadata only
- Kindle books: delete removes the external book entry itself

## Library Indexing

### Local PDFs

Configured `library_roots` are scanned recursively.

Only PDF files are indexed. Exclusion uses `excluded_patterns`, which are glob-style patterns matched against:

- full normalized path
- file name
- synthetic directory probes for directory matching

The backend stores indexed results in `books`, and each rescan removes stale rows using a scan token so excluded or removed books disappear correctly after config changes.

### External Books

External books are stored directly in SQLite and merged into `LibrarySnapshot.books`.

They are not tied to the filesystem watcher or local scanning.

Current external source:

- Kindle

External books participate in:

- list rendering
- search
- tags
- metadata editing
- sidebar navigation

They do not participate in local PDF opening or thumbnail generation from files.

## Navigation Architecture

The app uses a frontend-managed navigation stack rather than delegating navigation to page loads.

Each navigation entry includes:

- selected book
- active directory
- active tag
- active external source
- direct-only tag filter state
- search query
- history index

This state is:

- pushed/replaced into `window.history`
- serialized into the URL query string
- restored on `popstate`

Current query parameters include:

- `book`
- `dir`
- `tag`
- `source`
- `tagMode`
- `q`

This allows restoration of list/viewer state, tag state, and external source filters such as Kindle.

## Sidebar Model

The sidebar currently contains:

- top tool area
  - Home
  - Settings
  - Search
- directories tree
- tags tree
- external sources section

### Directories

Directories are derived from the visible library roots and book paths.

Important behavior:

- library roots are treated as independent roots
- longest matching library root wins
- selecting a directory shows only books directly inside that directory, not all descendants

### Tags

Tags are hierarchical by `/`, similar to Gmail labels.

Important behavior:

- explicit tags such as `language/lean` are stored as-is
- implicit parents such as `language` are synthesized for navigation
- parent tags are clickable
- a direct-only filter can restrict parent-tag views to books directly carrying that exact tag
- tag trees are collapsible

### External Sources

The sidebar has an `EXTERNAL` section.

Current child source:

- Kindle

Selecting it filters the list to `sourceType === "kindle"`.

## Viewer Architecture

Two rendering paths exist:

- `native`
  - iframe/WebView PDF rendering
- `pdfjs`
  - custom PDF.js rendering in the app

### Native Mode

Native mode relies on the platform browser engine for layout and rendering.

### PDF.js Mode

PDF.js mode is used for richer reading features.

Current behaviors include:

- text selection
- internal PDF link handling
- external link handling
- per-file and global viewer preferences
- render-window planning around the current position
- reading position restore using page number and offset ratio

### Page Jump

The viewer includes page jump controls in the overlay:

- always-visible page number input
- compact `Go` button that appears while focused
- support for Enter submission

### Viewer Preferences

Viewer preferences support:

- page mode
- binding direction
- zoom mode
- align mode
- vertical gap mode
- treat-first-page-as-cover

Preferences are stored globally and optionally overridden per file.

The backend normalizes and merges them; the frontend treats the payload as:

- global
- file
- effective

## Notes

Notes are stored in SQLite and rendered in a floating Milkdown editor.

Important current behaviors:

- floating panel
- autosave with debounce
- panel position and size managed in frontend state
- resize behavior can preserve bottom-right offset in relevant layouts

## Thumbnails

Thumbnail generation is currently file-backed and macOS-oriented.

The backend uses:

- `/usr/bin/qlmanage`
- `/usr/bin/sips`

Generated thumbnails are cached under the app cache directory and delivered to the frontend through:

- on-demand `book_thumbnail`
- async `thumbnail-ready` events

External books do not use file-generated thumbnails; they currently rely on `coverUrl`.

## Frontend Module Boundaries

The app still uses a large `main.ts`, but logic-heavy pieces are extracted into helpers such as:

- [src/library-utils.ts](src/library-utils.ts)
- [src/navigation-utils.ts](src/navigation-utils.ts)
- [src/navigation-shortcuts.ts](src/navigation-shortcuts.ts)
- [src/reading-position-utils.ts](src/reading-position-utils.ts)
- [src/viewer-layout-utils.ts](src/viewer-layout-utils.ts)
- [src/pdf-render-window-utils.ts](src/pdf-render-window-utils.ts)
- [src/viewer-settings-utils.ts](src/viewer-settings-utils.ts)
- [src/app-config-utils.ts](src/app-config-utils.ts)
- [src/book-metadata-utils.ts](src/book-metadata-utils.ts)
- [src/tag-utils.ts](src/tag-utils.ts)
- [src/tag-suggestions.ts](src/tag-suggestions.ts)
- [src/pdf-link-utils.ts](src/pdf-link-utils.ts)
- [src/page-jump-utils.ts](src/page-jump-utils.ts)
- [src/note-window-utils.ts](src/note-window-utils.ts)

The general pattern is:

- DOM-heavy orchestration stays in `main.ts`
- pure logic moves into helper modules
- helper modules get Vitest coverage

## Testing Strategy

### Rust

Rust uses:

- unit tests in [src-tauri/src/lib.rs](src-tauri/src/lib.rs)
- property-based tests with `proptest`

Focus areas include:

- config normalization
- excluded pattern behavior
- viewer preference normalization and merging
- reading position normalization
- storage path migration
- snapshot assembly including external books

### Frontend

Frontend uses:

- Vitest for pure helper modules
- Oxc for linting and formatting

Current helper-level coverage includes:

- library filtering
- navigation helpers
- tag validation and suggestions
- metadata import rules
- page jump parsing
- PDF link resolution
- note placement
- viewer layout/render planning
- viewer settings state merging

## Known Architectural Characteristics

- `main.ts` is still the orchestration center and remains large
- frontend state is centralized and mutable rather than store-library-driven
- SQLite acts as both index and user-data store
- local PDFs and external books are intentionally presented through one merged list model
- development and release storage paths intentionally differ to avoid local testing conflicts

## Change Guidance

When touching this architecture, check the following first:

- whether a change affects both `pdf` and `kindle` books
- whether navigation state needs a new query parameter or history field
- whether a new persisted field belongs in `book_metadata`, `external_books`, or both
- whether the change can be moved into a pure helper and tested without DOM rendering
- whether frontend modal logic must preserve IME behavior and input state during rerender
