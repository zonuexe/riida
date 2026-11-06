---
name: riida-release-prep
description: Cut a riida release on a `release/x.y.z` branch — bump the app version, update the changelog, regenerate bundled third-party license notices, verify, merge the pull request once every CI check is green, tag the merge commit, and publish the GitHub Release from the changelog section. Use when the user asks to prepare the next version, cut or tag a release, write or fix release notes, refresh release metadata, or make sure versioned files are consistent.
metadata:
  internal: true
---

# Riida Release Prep

Release work happens on a `release/x.y.z` branch and reaches `master` only
through a pull request whose checks are all green. `master` takes no direct
push during a release — the PR gate is what proves the release builds
somewhere other than one developer's machine.

Work through the steps in order.

## 1. Start the Release Branch

Decide the next semantic version first, then branch from an up-to-date
`master`:

```bash
git switch master && git pull && git switch -c release/x.y.z
```

Everything below happens on that branch.

## 2. Update Release Metadata

Update these files together:

- `CHANGELOG.md`
- `package.json`
- `package-lock.json`
- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock`
- `src-tauri/tauri.conf.json`
- `src/app/about.ts`

The Rust version lives once, in `[workspace.package]` of
`src-tauri/Cargo.toml`; both `riida` and `riida-core` inherit it.
`src-tauri/Cargo.lock` follows via
`cargo update -p riida -p riida-core --manifest-path src-tauri/Cargo.toml`,
never by hand.

Changelog rules:

- Write the changelog for humans, not machines.
- Add an entry for every released version.
- Keep the newest released version directly below `Unreleased`.
- Add a new `## [x.y.z] - YYYY-MM-DD` section.
- Open the section with a one- or two-sentence summary of the release,
  placed between the version heading and the first `###` heading. Say what
  the release means to a user, and credit an outside contributor by handle
  when the release rests on their work, for example:
  `Thanks to [@i999rri](https://github.com/i999rri), Windows builds work
  again starting with this release.`
- Use Keep a Changelog section headings as needed: `Added`, `Changed`,
  `Deprecated`, `Removed`, `Fixed`, and `Security`.
- Group the same kinds of changes under the same section heading.
- End an entry that came from an outside pull request with the PR link and
  thanks: `([#14](https://github.com/zonuexe/riida/pull/14), thank you
  [@i999rri](https://github.com/i999rri)!)`.
- Keep entries user-facing. Internal refactors belong in the changelog only
  when a user can notice them.
- Keep version headings and bottom-of-file links consistent so releases and
  compare ranges stay linkable.
- Preserve the release date in every version heading.
- Preserve the existing Semantic Versioning note at the top.
- Update the `[Unreleased]` compare link and add the new release link at the
  bottom.

## 3. Regenerate Bundled License Notices

Always regenerate, even when no dependency looks like it moved:

```bash
nix --extra-experimental-features 'nix-command flakes' develop --command npm run generate:third-party-licenses
```

`THIRD-PARTY-LICENSES-rust.md` and `THIRD-PARTY-LICENSES-js.md` join the
release-prep commit when they change.

## 4. Verify Locally

```bash
nix --extra-experimental-features 'nix-command flakes' develop --command npm run check:release
```

A green local run predicts CI without guaranteeing it, and the gap is the
reason the PR gate exists:

- `check:release` runs under the dev shell's pinned rustc, while CI resolves
  `dtolnay/rust-toolchain@stable`. Clippy gains lints between releases, so a
  new one fails the PR while the dev shell stays quiet.
- CI installs the newest `cargo-deny`, whose CLI has moved flags between
  major versions.
- The `cargo deny` license check runs only in CI; `check:release` omits it.

Treat a local failure as work to finish before committing, not as a reason to
wait for CI.

## 5. Commit

Prefer a single release-prep commit carrying the version bumps, the changelog
entry, and the regenerated notices:

```text
Bump up version to x.y.z
```

Verification cleanup — formatting, a lint fix, an unrelated repair the checks
surfaced — goes in its own commit, ordered before the bump. `Bump up version
to x.y.z` is the branch's final commit.

## 6. Open the PR and Take It Green

```bash
git push -u origin release/x.y.z
gh pr create --base master --title "Bump up version to x.y.z" --body "<summary>"
gh pr checks --watch
```

Write the PR body in English: what the version bump touched, the changelog
entries in brief, and how the release was verified.

This step is done when `gh pr checks` reports every check as a pass, with none
pending. A failure is release work like any other: fix it on the release
branch, then rebase so `Bump up version to x.y.z` remains the final commit.
Force-pushing the release branch is expected — that freedom is exactly what
keeps this work off `master`.

## 7. Merge, Tag, and Publish

Merge with a merge commit, matching the existing
`Merge pull request #N from zonuexe/release/x.y.z` history, then tag the merge
commit and push the tag in the same sitting. A merged release PR with no tag is
an unfinished release, so the tag follows the merge without a pause:

```bash
gh pr merge <number> --merge
git switch master && git pull
git tag -a vx.y.z -m "riida x.y.z"
git push origin vx.y.z
```

Pushing the `v*` tag starts the Linux, macOS, and Windows release workflows.
Create the GitHub Release right away, before they finish; each workflow finds
the release by its tag and attaches its bundles to it as it completes.

The release name is the `CHANGELOG.md` heading with its `## ` prefix removed,
for example `[0.8.1] - 2026-08-22`. The body is three blocks separated by a
blank line:

1. That version's `CHANGELOG.md` section, with `###` demoted to `##` and the
   changelog's Markdown links to pull requests, issues, and people reduced to
   bare URLs and `@handles` — GitHub renders those as expanded references
   (`#14` with its title, a linked avatar) in a release body, which a
   Markdown link suppresses:

   ```bash
   awk -v v="x.y.z" '$0 ~ "^## \\["v"\\] - " {i=1;next} i && /^## / {exit} i' CHANGELOG.md \
     | sed -E 's|^### |## |; s|\[#([0-9]+)\]\((https://github\.com/[^)]+)\)|\2|g; s|\[(@[A-Za-z0-9-]+)\]\(https://github\.com/[^)]+\)|\1|g'
   ```

2. `**Full Changelog**: https://github.com/zonuexe/riida/compare/vPREV...vx.y.z`
3. The macOS quarantine note, verbatim from
   [macos-quarantine-note.md](macos-quarantine-note.md).

```bash
gh release create vx.y.z --verify-tag --title "<heading>" --notes-file <body-file>
```

If a workflow has already created the placeholder draft `riida vx.y.z`, edit it
instead:

```bash
gh release edit vx.y.z --title "<heading>" --notes-file <body-file> --draft=false
```

Then take the same note off the previous release, so the listing at
<https://github.com/zonuexe/riida/releases> shows it once — on the newest
release only. The trimmed body ends at its `**Full Changelog**` line.

```bash
gh release view vPREV --json body -q .body | tr -d '\r' > prev-body.md
# drop the trailing macOS note block from prev-body.md
gh release edit vPREV --notes-file prev-body.md
```

`gh` returns release bodies with CRLF line endings, so strip the carriage
returns before matching them against the note file or diffing them.

Watch the three workflows to completion and re-run a failed job when the
failure is unrelated to the code under release (a flaky test, a runner
hiccup); a real failure is fixed on master and shipped as the next patch
version, never by moving the tag.

```bash
gh run list --branch vx.y.z
gh release view vx.y.z --json assets -q '.assets[].name'
```

This step is done when every workflow is green and the published release
carries the Linux (`.deb`, `.rpm`, `.AppImage`), macOS (`aarch64` and `x64`
`.dmg`, two `.app.tar.gz`), and Windows (`-setup.exe`, `.msi`) assets, the
note, and the previous release no longer does.

## Quick Checklist

- Work happened on `release/x.y.z`, and `master` received no direct push.
- Version numbers agree across Rust, npm, Tauri, and the About dialog
  fallback.
- `CHANGELOG.md` describes only user-visible changes, opens the version with a
  summary sentence, and credits outside contributors with PR links.
- Third-party notice files were regenerated.
- `npm run check:release` passed.
- `Bump up version to x.y.z` is the branch's final commit.
- The PR body is in English, and every check on it passed before the merge.
- The annotated tag `vx.y.z` sits on the merge commit and was pushed right
  after the merge.
- The published release is named after the `CHANGELOG.md` heading, carries
  the changelog section, the compare link, and the macOS quarantine note, and
  holds all platform assets.
- The previous release's note was removed, so the listing shows it once.
