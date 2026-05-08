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

Use the search bar at the top of the sidebar to search by title or author across your entire library.
