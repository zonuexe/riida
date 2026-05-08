---
title: Reading PDFs
description: How to use riida's PDF viewer, navigate pages, and configure display settings.
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
      {"@context":"https://schema.org","@type":"HowTo","name":"Reading PDFs","description":"How to use riida's PDF viewer, navigate pages, and configure display settings.","inLanguage":"en","step":[{"@type":"HowToStep","position":1,"name":"Open a PDF","text":"Click a book in your library to open it in the PDF viewer."},{"@type":"HowToStep","position":2,"name":"Navigate","text":"Use the → key or PageDown for next page, ← key or PageUp for previous page."},{"@type":"HowToStep","position":3,"name":"Search","text":"Press ⌘F or click the search icon to open the in-document search."}],"url":"https://zonuexe.github.io/riida/en/reading-pdf/"}
---

riida's PDF viewer is built on PDF.js and supports text selection, links, full-text search, and automatic reading position saving.

## Basic Navigation

### Page Controls

| Action | Method |
|--------|--------|
| Next page | <kbd>→</kbd> / <kbd>PageDown</kbd> / scroll |
| Previous page | <kbd>←</kbd> / <kbd>PageUp</kbd> |
| Go to page | Type in the page number field in the toolbar |
| First page | <kbd>Home</kbd> |
| Last page | <kbd>End</kbd> |

### Back / Forward

Use the ← / → buttons in the toolbar, or <kbd>⌘[</kbd> / <kbd>⌘]</kbd> (macOS) to navigate your history.

## Text Selection

On PDFs with a text layer, drag to select text and copy it. Scanned PDFs without a text layer do not support text selection.

## In-Document Search

Click the search icon in the toolbar (or press <kbd>⌘F</kbd>) to open the search bar. Matches are highlighted in the document.

## Reading Position

When you close the viewer or switch to another book, your current page and scroll position are saved automatically. The next time you open the file, reading resumes from where you left off.

## Spread Layout

Change the page layout from viewer settings:

- **Single page**: one page at a time
- **Spread (left-to-right)**: for Western books
- **Spread (right-to-left)**: for Japanese books
- **Auto-detect**: inferred from the PDF content (default)

Japanese vertical-text PDFs are detected and displayed right-to-left automatically.

## Viewer Settings

Click the settings icon in the toolbar to adjust display options. Settings have two scopes:

- **Global**: defaults for all books
- **This file**: overrides for the current book only

## Notes

Click the note icon in the toolbar while a PDF is open to open the floating note panel. Notes are autosaved.
