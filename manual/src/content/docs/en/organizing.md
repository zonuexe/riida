---
title: Organizing Your Books
description: How to use tags, metadata, and shelves to organize your library.
draft: false
head:
  - tag: meta
    attrs:
      property: og:locale
      content: en_US
  - tag: script
    attrs:
      type: application/ld+json
    content: |-
      {"@context":"https://schema.org","@type":"Article","name":"Organizing Your Books","description":"How to use tags, metadata, and shelves to organize your library.","inLanguage":"en","about":{"@type":"SoftwareApplication","name":"riida"},"url":"https://zonuexe.github.io/riida/en/organizing/"}
---

## Tags

Tags let you freely classify your books.

### Adding Tags

1. Right-click a book row, or click the tag icon while a book is open
2. Type a tag name and press Enter
3. Existing tags appear as autocomplete suggestions

### Filtering by Tag

Click a tag in the sidebar tag list to show only books with that tag.

### Bulk Tagging

Select multiple books in the main list (⌘-click or Shift-click), then right-click and choose **Edit Tags**.

## Editing Metadata

Right-click a book and choose **Edit Metadata** to edit:

| Field | Description |
|-------|-------------|
| Title | Book title |
| Authors | One per line |
| Publisher | Publisher name |
| Release date | YYYY-MM-DD format |
| Language | Language code (e.g. `ja`, `en`) |
| Description | Synopsis, notes, etc. |
| Cover URL | URL of cover image |
| URL | Official page or store link |
| <abbr title="Amazon Standard Identification Number">ASIN</abbr> | Amazon Standard Identification Number |

### JSON Patch Import

To update multiple fields at once, use the JSON patch format:

```json
{
  "title": "New Title",
  "authors": ["Author Name"],
  "language": "en"
}
```

Omitted fields are left unchanged. Setting a field to `null` clears it.

## Shelves

Shelves are virtual collections defined by conditions (tags, language, publisher, etc.).
Create a shelf from the sidebar using **Add Shelf**, then configure its matching conditions.

## Search

Use the search bar at the top of the sidebar to search your library by title or author.

### Full-text Search (Searching Inside Books)

Once you build an index, the search bar also matches the **contents** of your books — PDF/EPUB body text, notes, metadata, and tags. Results jump straight to the matching page or section, with the surrounding text shown as a snippet. Japanese text is segmented with a dedicated tokenizer, so search works across vertical (tategaki) books and OCR'd scans.

#### Building the Index

1. Open **Settings**
2. Under **Full-text search**, press **Build index**
3. Once the library scan finishes, sidebar search results include hits from inside your books

Indexing is opt-in. Because it consumes disk space, the index is created only when you build it here — it never starts on its own. Use **Clear** to discard the index and reclaim the space at any time.

#### Online-only Cloud Files

Files that exist only in the cloud — "online-only" placeholders such as macOS File Provider or Dropbox — have their body text skipped by default so building the index never silently downloads your whole library (their metadata and notes are still indexed). To index their body text too, tick **download online-only files** before building. Skipped files are indexed automatically once you open them and a local copy exists.
