---
name: riida-dependency-update
description: Update riida's third-party dependencies — npm/JavaScript and Cargo/Rust — keeping the lock files, bundled license notices, and license allowlists consistent, then running release verification. Use when the user asks to update or refresh dependencies, bump locked versions, pick up upstream patches, or upgrade a specific library.
metadata:
  internal: true
---

# Riida Dependency Update

Follow this workflow when updating `riida`'s third-party dependencies.

The npm and Cargo dependency sets are independent. Update and commit them
separately so each change is easy to review and to bisect.

There is no automated dependency service (no Dependabot or Renovate); updates
are deliberate and manual. CI only *validates* dependencies — it never updates
them.

Run every command inside the Nix development shell:

```bash
nix --extra-experimental-features 'nix-command flakes' develop --command <command>
```

## Decide The Scope

Decide which kind of update is being made before starting.

- **Routine (in-range) update**: pick up newer versions already allowed by the
  ranges in `package.json` / `src-tauri/Cargo.toml`. Only the lock files
  change. This is the common case.
- **Major / out-of-range update**: move a dependency past its current range.
  This edits the manifest (`package.json` or `src-tauri/Cargo.toml`) and may
  involve breaking changes. Do one library, or one related group, at a time.

## Update Rust Dependencies

Inspect, then apply in-range updates to `src-tauri/Cargo.lock`:

```bash
cargo update --manifest-path src-tauri/Cargo.toml --dry-run
cargo update --manifest-path src-tauri/Cargo.toml
```

For a major update, raise the version in `src-tauri/Cargo.toml` first, then
update that crate, e.g. `cargo update -p <crate> --manifest-path src-tauri/Cargo.toml`.

Rules:

- Keep every `tauri` / `tauri-build` / `tauri-plugin-*` crate on the same major
  version, and in sync with the `@tauri-apps/*` npm packages.
- `src-tauri/Cargo.lock` is committed; never hand-edit it.
- `cargo machete` (unused crates) and `cargo audit` (security advisories) run as
  part of `check:rust`. An advisory must be resolved, not ignored.

## Update npm Dependencies

Inspect, then apply in-range updates to `package-lock.json`:

```bash
npm outdated
npm update
```

`npm outdated` shows `Wanted` (newest in-range) and `Latest` (newest published).
For a major update, raise the range in `package.json` yourself, then run
`npm install`.

Rules:

- Keep the `@tauri-apps/*` packages in sync with the Rust `tauri*` crates.
- `package-lock.json` is committed.
- `npm update` should not need to modify `package.json`; if it does, review the
  change before keeping it.
- `knip` (part of `check:frontend`) flags dependencies that are no longer used.

## Regenerate Bundled License Notices

Any dependency change can add, remove, or relicense bundled code, so always
regenerate the third-party notices after updating:

```bash
npm run generate:third-party-licenses
```

Review the diff to `THIRD-PARTY-LICENSES-rust.md` and
`THIRD-PARTY-LICENSES-js.md`, and commit the regenerated file alongside the lock
file that caused the change (the Rust notice with `Cargo.lock`, the JS notice
with `package-lock.json`).

If a newly pulled dependency introduces an SPDX license that is not already
allowed, the license checks fail. Do not silently widen the allowlist. Confirm
the license is acceptable for an MPL-2.0 application first, then add it to all
three allowlists together:

- `deny.toml` — `[licenses] allow` (Rust, `cargo-deny`)
- the `check:licenses:npm` script in `package.json` — the `--onlyAllow` list (npm)
- `.github/dependency-review-config.yml` — `allow-licenses` (CI pull-request review)

## Verify

Run the full release gate after each dependency set is updated:

```bash
npm run check:release
```

It covers Rust (`fmt`, `clippy`, `cargo-machete`, `nextest`, `cargo check`,
`cargo audit`), the frontend (`oxlint`, `oxfmt`, `knip`, coverage, build,
bundle-size), and the license checks (`check:licenses:npm`, `check:notices`).
`check:notices` regenerates the notices and fails on any uncommitted diff, so
stage the regenerated files first.

Dependency updates can change runtime behavior that `check:release` cannot
catch. After a Tauri, PDF.js, epub.js, or Milkdown update, manually re-check the
affected area in the running Tauri app — `check:release` runs under Node and
does not exercise the WKWebView runtime.

## Commit

Commit the npm and Cargo updates as separate commits so each is independently
reviewable and revertable. Include the regenerated notice file in the same
commit as the lock file that caused it to change.

Use these commit messages:

- `Update Rust dependencies`
- `Update npm dependencies`
- For a single deliberate upgrade, name it instead: `Update <library> to <version>`

If `check:release` required allowlist edits or other non-dependency cleanup,
keep that in its own commit, separate from the lock-file updates.

## Quick Checklist

- The kind of update (routine in-range vs. major) was decided up front.
- npm and Cargo updates are in separate commits.
- `tauri*` crates and `@tauri-apps/*` packages share the same major version.
- Lock files are committed and were not hand-edited.
- Third-party notices were regenerated and committed with their lock file.
- Any new SPDX license was vetted and added to all three allowlists.
- `npm run check:release` passed.
- Tauri-runtime-affecting updates were manually re-checked in the app.
