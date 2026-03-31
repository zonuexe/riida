# riida

`riida` is a Tauri + Rust desktop app for managing and reading local PDF libraries.

It was created to meet the needs of an author who owns more than 1,000 ebooks and wants to reach the right book quickly through a single bookshelf app with a built-in PDF reader.

The name "Riida" comes from "Reader", reflecting that primary goal.

It is currently focused on:

- indexing PDFs from a watched local folder
- browsing the library by directory and search
- reading with either native PDF rendering or PDF.js
- keeping per-file notes and viewer preferences locally

## Current Status

This project is still in active development.

The current working setup assumes a local PDF collection such as:

```toml
library_roots = ["~/Documents/Ebooks/"]
```

## Configuration

Configuration is loaded from `riida.toml`.

The app prefers:

- `~/.config/riida/riida.toml` when `~/.config` exists
- otherwise the OS-native config directory

Example:

```toml
library_roots = ["~/Documents/Ebooks/"]
excluded_dir_names = ["backup"]
excluded_file_suffixes = [".bak"]
pdf_renderer = "pdfjs"
```

## Local Storage

The app separates storage by role:

- config: config directory
- data: app data directory, including SQLite
- cache: cache directory, including thumbnails

Legacy project-root files are migrated forward automatically on startup when possible.

## License and Copyright

This project is licensed under the [Mozilla Public License 2.0](https://www.mozilla.org/en-US/MPL/2.0/). See [`LICENSE`](LICENSE).

Licenses and notice texts for bundled Rust and JavaScript dependencies are collected in [`THIRD-PARTY-LICENSES-rust.md`](THIRD-PARTY-LICENSES-rust.md) and [`THIRD-PARTY-LICENSES-js.md`](THIRD-PARTY-LICENSES-js.md).

> This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at <https://mozilla.org/MPL/2.0/>.

Copyright belongs to the contributors to this repository unless otherwise noted.

## Development

The project includes a Nix flake-based development shell.

```bash
nix --extra-experimental-features 'nix-command flakes' develop
npm install
npm run tauri dev
```

Basic verification:

```bash
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
```

## Contributing

- Minimum contributor workflow: [CONTRIBUTING.md](/Users/megurine/repo/rust/riida/CONTRIBUTING.md)
- Development details and implementation notes: [AGENTS.md](/Users/megurine/repo/rust/riida/AGENTS.md)
