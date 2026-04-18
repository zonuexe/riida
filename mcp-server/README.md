# riida-mcp

MCP server for [riida](https://github.com/zonuexe/riida) — infer and update book metadata by reading PDF content and file paths.

## Requirements

- Node.js 18 or later
- [riida](https://github.com/zonuexe/riida) installed and run at least once (creates the database)

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
