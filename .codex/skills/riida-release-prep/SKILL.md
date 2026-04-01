---
name: riida-release-prep
description: Prepare a riida release by bumping the app version, updating the changelog, regenerating bundled third-party license notices, and running release verification commands. Use when the user asks to prepare the next version, cut a release, refresh release metadata, or make sure versioned files are consistent before tagging.
---

# Riida Release Prep

Follow this workflow when preparing a new `riida` release.

## Update Release Metadata

Decide the next semantic version first, then update all versioned files together.

Update these files:

- `CHANGELOG.md`
- `package.json`
- `package-lock.json`
- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock`
- `src-tauri/tauri.conf.json`
- `src/main.ts`

Use these rules:

- Write the changelog for humans, not machines.
- Add an entry for every released version.
- Keep the newest released version directly below `Unreleased`.
- Add a new `## [x.y.z] - YYYY-MM-DD` section to `CHANGELOG.md`.
- Use Keep a Changelog section headings as needed: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, and `Security`.
- Group the same kinds of changes under the same section heading.
- Keep changelog entries user-facing. Do not list internal refactors unless they affect users.
- Keep version headings and bottom-of-file links consistent so releases and compare ranges stay linkable.
- Preserve the release date in every version heading.
- Preserve the existing Semantic Versioning note at the top of `CHANGELOG.md`.
- Update the `[Unreleased]` compare link and add the new release link at the bottom of `CHANGELOG.md`.
- Keep the release commit message in the form `Bump up version to x.y.z`.

## Regenerate Bundled License Notices

Always regenerate bundled third-party notices as part of release preparation.

Run inside the Nix development shell:

```bash
nix --extra-experimental-features 'nix-command flakes' develop --command npm run generate:third-party-licenses
```

Check which notice files changed:

- `THIRD-PARTY-LICENSES-rust.md`
- `THIRD-PARTY-LICENSES-js.md`

If notice regeneration is the only remaining change after a release bump, use a separate commit only when the user asks for it. Otherwise include the regenerated files in the release-prep commit.

## Verify the Release

Run these commands before committing:

```bash
nix --extra-experimental-features 'nix-command flakes' develop --command cargo check --manifest-path src-tauri/Cargo.toml
nix --extra-experimental-features 'nix-command flakes' develop --command npm run build
```

Run targeted extra checks when the touched area warrants them:

- `cargo test --manifest-path src-tauri/Cargo.toml` when Rust behavior changed
- `npm run check:licenses:npm` when JS dependencies or license generation changed

## Commit the Result

Prefer a single release-prep commit containing:

- version bumps
- changelog update
- regenerated license notices

Use:

```text
Bump up version to x.y.z
```

If the user asks for separate commits, keep the release version bump as the final commit.

## Quick Checklist

- Working tree starts clean or you understand every pending change.
- Version numbers are consistent across Rust, npm, Tauri, and the About dialog fallback.
- `CHANGELOG.md` describes only user-visible release changes.
- Third-party notice files were regenerated.
- `cargo check` and `npm run build` passed.
- The final commit message follows the established release format.
