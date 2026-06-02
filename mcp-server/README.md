# riida-mcp

MCP server for [riida](https://github.com/zonuexe/riida) — infer and update book metadata by reading PDF content and file paths.

## Requirements

- Node.js 18 or later
- [riida](https://github.com/zonuexe/riida) installed and run at least once (creates the database)
- *(optional)* poppler's `pdftotext` on `PATH` — improves `read_pdf_colophon` ISBN coverage for PDFs whose colophon fonts pdf.js cannot read (`brew install poppler` / `apt install poppler-utils`)

## Setup

Add to your Claude Code project config (`.mcp.json`):

```json
{
  "mcpServers": {
    "riida": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "riida-mcp"]
    }
  }
}
```

Or for Claude Desktop, add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "riida": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "riida-mcp"]
    }
  }
}
```

## Tools

### `search_books`

Search the library by any combination of filters.

| Parameter | Type | Description |
|-----------|------|-------------|
| `directory` | string | Only books whose path starts with this directory |
| `path_contains` | string | Only books whose file path contains this string |
| `title_contains` | string | Only books whose title contains this string (case-insensitive) |
| `author_contains` | string | Only books whose author list contains this string (case-insensitive) |
| `tag` | string | Only books that have exactly this tag |
| `missing_metadata` | boolean | If true, only books missing title or authors |
| `limit` | number | Max results to return (default 50) |

### `list_books_needing_metadata`

Lists books that are missing title or authors. Returns file paths with directory structure useful for metadata inference.

| Parameter | Type | Description |
|-----------|------|-------------|
| `limit` | number | Max books to return (default 50) |

### `get_book_metadata`

Gets the current stored metadata for a book.

| Parameter | Type | Description |
|-----------|------|-------------|
| `file_path` | string | Absolute path to the PDF file |

### `read_pdf_pages`

Extracts plain text from the first N pages of a PDF file. Use this to infer title, authors, and publisher from the book content.

| Parameter | Type | Description |
|-----------|------|-------------|
| `file_path` | string | Absolute path to the PDF file |
| `max_pages` | number | Number of pages to read (default 3, max 10) |

### `read_pdf_colophon`

Extracts the colophon (奥付) from the **last** pages of a PDF and parses its
bibliographic data. This is the counterpart to `read_pdf_pages`: Japanese books
print the ISBN, first-edition date, and publisher on a final colophon page.

| Parameter | Type | Description |
|-----------|------|-------------|
| `file_path` | string | Absolute path to the PDF file |
| `max_pages` | number | Number of trailing pages to read (default 8, max 15) |

The result includes `total_pages`, the raw tail `text`, an `isbn_source`
(`pdfjs`, `pdftotext`, or `null` — see below), and a parsed `colophon` object:

| Field | Description |
|-------|-------------|
| `isbn` | Chosen ISBN as printed (separators preserved), or `null` |
| `isbn_normalized` | Same ISBN reduced to digits (and a trailing `X`) |
| `isbn_valid` | Whether the ISBN-10/13 check digit validates |
| `isbn_confidence` | `high` / `low` / `none` — see below |
| `c_code` | Japanese C-code following the ISBN (e.g. `C3055`), or `null` |
| `release_date` | Publication date (`YYYY-MM-DD`) — the first printing of the latest edition listed — or `""` |
| `publisher` | Best-effort publisher name, or `""` |
| `printed_in_japan` | Whether a "Printed in Japan" marker is present |
| `isbn_candidates` | Every ISBN-like token found, in document order |

The own-book ISBN is chosen over advertised titles in the back matter by its
Japanese C-code and its proximity to colophon keywords (発行所 / Printed in
Japan). `isbn_confidence` is `low` when several ISBNs were found but none could
be confirmed as the book's own — typically a back-cover ad list when the real
colophon is image-only and not text-extractable. Always cross-check a `low`
result (and the `release_date` / `publisher`, which are best-effort) against the
returned raw `text`. ISBNs printed only as a barcode image cannot be extracted.

**pdftotext fallback.** Some colophons use fonts without a ToUnicode CMap, so
pdf.js (the default parser) extracts little or no usable text from them while
poppler's `pdftotext` reads them cleanly. O'Reilly Japan is the common case: its
colophon ISBN and "Printed in Japan" are ASCII and survive, but the Japanese
発行日 / 発行所 do not — so pdf.js reports a confident ISBN yet an empty date and
publisher. The tool therefore re-reads the trailing pages with `pdftotext`
whenever **any** of {ISBN, `release_date`, `publisher`} is missing, then takes
from poppler only the fields pdf.js could not read. If poppler supplies a
strictly better ISBN, `isbn_source` reports `pdftotext`; otherwise the pdf.js
ISBN is kept and only the date/publisher are filled. `pdftotext` is run with
`-layout` so multi-column colophons keep each date beside its 第N版第N刷 label.
This fallback is best-effort and optional: if `pdftotext` is not on `PATH` (nor
at the usual Homebrew/`/usr/bin` locations) the tool silently degrades to
pdf.js-only. Install it via poppler (`brew install poppler`,
`apt install poppler-utils`) to enable it.

### `update_books_metadata`

Updates metadata for one or more books in a single transaction. Only the fields you provide are changed; omitted fields keep their current values.

| Parameter | Type | Description |
|-----------|------|-------------|
| `books` | array | List of books to update |
| `books[].file_path` | string | Absolute path to the PDF file |
| `books[].title` | string | Book title |
| `books[].authors` | string[] | Author names |
| `books[].publisher` | string | Publisher name |
| `books[].release_date` | string | Publication date (YYYY-MM-DD) |
| `books[].description` | string | Description or synopsis |
| `books[].language` | string | ISO 639-1 language code (e.g. `ja`, `en`) |

### `get_book_tags`

Gets the tags for a book.

| Parameter | Type | Description |
|-----------|------|-------------|
| `file_path` | string | Absolute path to the PDF file |

### `set_book_tags`

Replaces all tags for a book with the provided list. Pass an empty array to remove all tags.

| Parameter | Type | Description |
|-----------|------|-------------|
| `file_path` | string | Absolute path to the PDF file |
| `tags` | string[] | Full list of tags to set |

## Example workflow

```
List books with missing metadata, read the first few pages of each PDF,
infer the title and authors from the content and file path, then update
the metadata for all of them.
```

Claude will call `list_books_needing_metadata`, then `read_pdf_pages` for each book, and finally `update_books_metadata` to write everything in one transaction.

When the front matter is ambiguous, `read_pdf_colophon` recovers the ISBN, first-edition date, and publisher from the colophon at the end of the book — for Japanese books that is often the most reliable single source, and the extracted ISBN can seed a precise techbook-mcp lookup.

## Combining with techbook-mcp

[techbook-mcp](https://github.com/zonuexe/techbook-mcp) is a companion MCP server that searches Japanese technical book metadata across multiple publishers (技術評論社, 達人出版会, 技術書典, etc.).

When both MCP servers are active in Claude Code, you can ask Claude to fill missing metadata by cross-referencing techbook-mcp search results:

```
list_books_needing_metadata でメタデータ不足の本を一覧して、
techbook-mcp で書名検索し、一致した書誌情報を update_books_metadata で書き込んで
```

Claude will:
1. Call `list_books_needing_metadata` to find books missing title or authors
2. For each identifiable book, call `techbook-mcp:search_books` with the title (inferred from filename or PDF content)
3. Confirm the match and call `update_books_metadata` to write the title, authors, publisher, and release date in a single transaction

### Setup

Add both servers to your Claude Code project config (`.mcp.json`):

```json
{
  "mcpServers": {
    "riida": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "riida-mcp"]
    },
    "techbook-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "techbook-mcp"]
    }
  }
}
```

### Tips

- techbook-mcp covers Japanese technical publishers. For books not indexed there, use `read_pdf_pages` to extract metadata directly from the PDF content.
- BOOKSCAN-style filenames (`書名 著者名 ページ数_ISBN.pdf`) often contain enough information to fill title and authors without any search.
- Magazine split-files (e.g. Software Design 総集編) can be batch-updated from the directory path alone — no search needed.

## Database path

The server automatically connects to the riida database:

| Platform | Path |
|----------|------|
| macOS | `~/Library/Application Support/me.zonu.riida/app.db` |
| Windows | `%APPDATA%\me.zonu.riida\app.db` |
| Linux | `$XDG_DATA_HOME/me.zonu.riida/app.db` |

## License

MPL-2.0
