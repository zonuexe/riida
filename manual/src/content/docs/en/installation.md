---
title: Installation
description: How to download and install riida.
draft: false
---

## System Requirements

- **macOS** — macOS 13 (Ventura) or later recommended. Supports both Apple Silicon and Intel Macs.
- **Windows / Linux** — Builds are provided but receive less testing than the macOS version.

## Installation (macOS)

### 1. Download

Download the latest `.dmg` file from the [GitHub Releases page](https://github.com/zonuexe/riida/releases).

- Apple Silicon Mac: `riida_x.y.z_aarch64.dmg`
- Intel Mac: `riida_x.y.z_x64.dmg`

### 2. Install

1. Open the downloaded `.dmg` file
2. Drag `riida.app` to your `/Applications` folder

### 3. First Launch

riida is not signed with a paid Apple Developer ID. Before launching, run the following command in Terminal to clear the quarantine attribute:

```bash
xattr -cr /Applications/riida.app
```

After that, you can open riida normally by double-clicking.

## After Installation

After the first launch, set up your library root folder.
See [Library Setup](../library-setup/) for details.

## Uninstalling

Move `riida.app` from `/Applications` to the Trash.

To also remove settings and data:

| Type | Path |
|------|------|
| Settings | `~/.config/riida/` |
| Data (DB, thumbnails) | `~/Library/Application Support/riida/` |
| Cache | `~/Library/Caches/riida/` |
