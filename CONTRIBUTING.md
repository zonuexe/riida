# Contributing to riida

## Project Direction

This project is developed first and foremost to satisfy my own personal reading and library-management needs.

I am still a beginner with Rust, Tauri, and TypeScript, so thoughtful advice from experienced contributors is very welcome. If you notice architectural issues, ecosystem conventions I am missing, or implementation choices that are likely to cause trouble later, I would genuinely appreciate that kind of feedback in an issue.

At the same time, I am not looking for unplanned "AI slop" style improvements that expand the project without a clear reason. Drive-by suggestions or changes that add complexity without understanding the actual goals of the project are not something I intend to accept, and they may simply be declined without discussion.

Bug reports, requests, and other ideas are also welcome through issues, and you should not hesitate to open one. However, because this is a personal project, not every request will be accepted or prioritized.

## Before You Start

Use the flake shell before running frontend or Rust commands.

```bash
nix --extra-experimental-features 'nix-command flakes' develop
npm install
```

## Run the App

```bash
npm run tauri dev
```

## Verify Changes

Run both checks before submitting changes.

```bash
npm run check
```

Or run the individual checks when iterating on one area:

```bash
npm run rust:fmt:check
npm run rust:lint
npm run lint
npm run fmt:check
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
```

Run the test suites when touching frontend logic, Rust behavior, or shared state handling.

```bash
npm test
cargo test --manifest-path src-tauri/Cargo.toml
```

For deeper Rust test-quality audits, you can also run mutation testing locally:

```bash
cargo install cargo-mutants --locked
npm run mutants:rust:list
npm run mutants:rust
```

## Project Structure

- [src-tauri/src/lib.rs](/Users/megurine/repo/rust/riida/src-tauri/src/lib.rs): backend, config, SQLite, library scan/watch, thumbnails
- [src/main.ts](/Users/megurine/repo/rust/riida/src/main.ts): frontend state, navigation, PDF viewer, notes
- [src/styles.css](/Users/megurine/repo/rust/riida/src/styles.css): UI styling

## Expectations

- Keep changes small and verifiable when possible.
- Prefer preserving user data over destructive cleanup.
- Mention practical manual test steps when changing persistence, navigation, or PDF rendering.

## More Detail

Development notes and implementation details live in [AGENTS.md](AGENTS.md).
