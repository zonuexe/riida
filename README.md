# riida

Tauri + Rust based ebook library manager for local PDF files under Dropbox.

## Development shell

```bash
nix develop
```

If you use `direnv`, allow the project once:

```bash
direnv allow
```

## Included tools

- `rustc`, `cargo`, `clippy`, `rustfmt`, `rust-analyzer`
- `nodejs`
- `sqlite`
- `pkg-config`

## Bootstrap the app

```bash
nix --extra-experimental-features 'nix-command flakes' develop
npm install
npm run tauri dev
```

## MVP

- Watch `/Users/megurine/Dropbox/EBook/`
- Ignore `backup` directories and `*.bak` files
- Index PDF files into a platform-specific application data directory
- Show the library in a Tauri desktop app
- Open a selected PDF in the embedded viewer

## Configuration

Settings, database files, and caches now follow OS-specific app directory conventions.

- Config: `~/.config/riida/riida.toml` is preferred when `~/.config` exists; otherwise the OS config directory is used
- Data: OS app data directory as `app.db`
- Cache: OS cache directory under `thumbnails/`

On first launch, legacy files from the project root are copied forward automatically:

- `riida.toml`
- `data/app.db`
- `data/thumbnails/`

Typical locations are:

- Linux: `~/.config/riida/riida.toml`, `~/.local/share/riida/app.db`, `~/.cache/riida/thumbnails/`
- macOS: `~/.config/riida/riida.toml` when `~/.config` exists, otherwise `~/Library/Application Support/riida/riida.toml`; cache stays under `~/Library/Caches/riida/thumbnails/`
- Windows: `%APPDATA%\\riida\\riida.toml`, `%APPDATA%\\riida\\app.db`, `%LOCALAPPDATA%\\riida\\thumbnails\\`

For local development, a project-root `riida.toml` is still accepted as a legacy fallback and will be migrated automatically.

```toml
watch_root = "~/Dropbox/EBook/"
excluded_dir_names = ["backup"]
excluded_file_suffixes = [".bak"]
```

## Suggested next commands

```bash
nix develop
npm install
npm run tauri dev
```
