#!/usr/bin/env bash
set -euo pipefail

if ! command -v cargo-mutants >/dev/null 2>&1; then
  cat >&2 <<'EOF'
cargo-mutants is not installed.

Install it first:
  cargo install cargo-mutants --locked

Then rerun:
  nix --extra-experimental-features 'nix-command flakes' develop --command npm run mutants:rust
EOF
  exit 1
fi

exec cargo mutants --manifest-path src-tauri/Cargo.toml "$@"
