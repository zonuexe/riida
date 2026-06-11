#!/usr/bin/env node
// Fetch the prebuilt libpdfium for a target and stage it under src-tauri/pdfium/
// so `bundle.resources` ships it and `bind_pdfium` can load it at runtime.
//
// Usage:
//   node scripts/fetch-pdfium.mjs [rust-target-triple]
// With no argument it resolves the host platform/arch (handy for local
// `tauri build`). CI passes the matrix target triple explicitly.
//
// The version is pinned and must be >= the `pdfium_NNNN` feature selected for
// pdfium-render in src-tauri/Cargo.toml (the crate's bindings reference that
// build's symbols). Override with PDFIUM_VERSION if needed.

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = process.env.PDFIUM_VERSION ?? "7749";
const REPO = "bblanchon/pdfium-binaries";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const destDir = join(projectRoot, "src-tauri", "pdfium");

// Map a rust target triple (or host platform/arch) to the bblanchon asset and
// the library path inside the archive, plus the runtime library file name
// pdfium-render expects (`pdfium_platform_library_name_at_path`).
const ASSETS = {
  "aarch64-apple-darwin": ["pdfium-mac-arm64.tgz", "lib/libpdfium.dylib", "libpdfium.dylib"],
  "x86_64-apple-darwin": ["pdfium-mac-x64.tgz", "lib/libpdfium.dylib", "libpdfium.dylib"],
  "x86_64-unknown-linux-gnu": ["pdfium-linux-x64.tgz", "lib/libpdfium.so", "libpdfium.so"],
  "aarch64-unknown-linux-gnu": ["pdfium-linux-arm64.tgz", "lib/libpdfium.so", "libpdfium.so"],
  "x86_64-pc-windows-msvc": ["pdfium-win-x64.tgz", "bin/pdfium.dll", "pdfium.dll"],
  "aarch64-pc-windows-msvc": ["pdfium-win-arm64.tgz", "bin/pdfium.dll", "pdfium.dll"],
};

function hostTriple() {
  const p = process.platform;
  const a = process.arch;
  if (p === "darwin") return a === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  if (p === "linux") return a === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
  if (p === "win32") return a === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  throw new Error(`unsupported host platform ${p}/${a}`);
}

async function main() {
  const triple = process.argv[2] ?? hostTriple();
  const entry = ASSETS[triple];
  if (!entry) {
    console.error(`fetch-pdfium: unsupported target ${triple}`);
    console.error(`supported: ${Object.keys(ASSETS).join(", ")}`);
    process.exit(1);
  }
  const [asset, innerPath, outName] = entry;
  const url = `https://github.com/${REPO}/releases/download/chromium%2F${VERSION}/${asset}`;

  const work = mkdtempSync(join(tmpdir(), "pdfium-"));
  const tgz = join(work, asset);
  try {
    console.log(`fetch-pdfium: ${triple} <- ${url}`);
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`download failed: HTTP ${res.status} for ${url}`);
    }
    writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));

    // tar is bsdtar on Windows runners and GNU tar on mac/linux; both extract
    // a .tgz with this form. Extract everything, then copy the files we keep.
    execFileSync("tar", ["-xzf", tgz, "-C", work], { stdio: "inherit" });

    const innerLib = join(work, innerPath);
    if (!existsSync(innerLib)) {
      throw new Error(`archive ${asset} did not contain ${innerPath}`);
    }
    mkdirSync(destDir, { recursive: true });
    const libOut = join(destDir, outName);
    copyFileSync(innerLib, libOut);
    // Ship the upstream license alongside the binary for the notice gate.
    if (existsSync(join(work, "LICENSE"))) {
      copyFileSync(join(work, "LICENSE"), join(destDir, "LICENSE-pdfium"));
    }
    console.log(`fetch-pdfium: wrote ${libOut}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`fetch-pdfium: ${error.message ?? error}`);
  process.exit(1);
});
