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
- Index PDF files into SQLite at `data/app.db`
- Show the library in a Tauri desktop app
- Open a selected PDF in the embedded viewer

## Configuration

Settings are loaded from `riida.toml` in the project root.

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
