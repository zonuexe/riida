---
title: Library Setup
description: How to add and configure library root folders.
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
      {"@context":"https://schema.org","@type":"HowTo","name":"Library Setup","description":"How to add and configure library root folders.","inLanguage":"en","step":[{"@type":"HowToStep","position":1,"name":"Open Settings","text":"Open Settings from the top of the sidebar."},{"@type":"HowToStep","position":2,"name":"Select Library tab","text":"Select the Library tab."},{"@type":"HowToStep","position":3,"name":"Add Folder","text":"Click + Add Folder and choose a folder."}],"url":"https://zonuexe.github.io/riida/en/library-setup/"}
---

riida recursively scans your registered library root folders and automatically indexes all PDFs and EPUBs it finds.

## Adding a Library Root

1. Open **Settings** from the top of the sidebar
2. Select the **Library** tab
3. Click **+ Add Folder** and choose a folder
4. Scanning begins immediately after the folder is added

You can register multiple root folders.

## Exclude Patterns

To skip certain folders or files, add glob-format exclude patterns.

**Examples:**

```
**/backup/**
*.bak.pdf
**/tmp/**
```

Enter one pattern per line in the "Exclude Patterns" field in Settings.

## Automatic File Tracking

riida watches your library roots for changes. Files added, modified, or deleted are reflected in the library automatically — no manual rescan needed.

## Config File Location

Library settings are saved to `~/.config/riida/riida.toml`:

```toml
library_roots = ["~/Documents/Ebooks/"]
excluded_patterns = ["**/backup/**"]
```
