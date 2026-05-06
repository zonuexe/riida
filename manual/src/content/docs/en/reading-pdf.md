---
title: Reading PDFs
description: How to use riida's PDF viewer, navigate pages, and configure display settings.
draft: false
---

riida's PDF viewer is built on PDF.js and supports text selection, links, full-text search, and automatic reading position saving.

## Basic Navigation

### Page Controls

| Action | Method |
|--------|--------|
| Next page | → key / PageDown / scroll |
| Previous page | ← key / PageUp |
| Go to page | Type in the page number field in the toolbar |
| First page | Home key |
| Last page | End key |

### Back / Forward

Use the ← / → buttons in the toolbar, or ⌘[ / ⌘] (macOS) to navigate your history.

## Text Selection

On PDFs with a text layer, drag to select text and copy it. Scanned PDFs without a text layer do not support text selection.

## In-Document Search

Click the search icon in the toolbar (or press ⌘F) to open the search bar. Matches are highlighted in the document.

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
