#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const cargoDir = path.join(rootDir, "src-tauri");
const outputFile = path.join(rootDir, "THIRD-PARTY-LICENSES.md");
const rustTargets = [
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "x86_64-unknown-linux-gnu",
  "x86_64-pc-windows-msvc",
];

function run(command, args, cwd = rootDir) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 128 * 1024 * 1024,
  });

  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `${command} ${args.join(" ")} failed`);
  }

  return result.stdout;
}

function runWithResult(command, args, cwd = rootDir) {
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 128 * 1024 * 1024,
  });
}

function cargoMetadata(target, { offline }) {
  const args = [
    "metadata",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "--format-version",
    "1",
    "--filter-platform",
    target,
  ];

  if (offline) {
    args.push("--offline");
  }

  const result = runWithResult("cargo", args, rootDir);
  if (result.status !== 0) {
    const error = new Error(result.stderr.trim() || `cargo ${args.join(" ")} failed`);
    error.stderr = result.stderr ?? "";
    throw error;
  }

  return JSON.parse(result.stdout);
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function stringifyPeople(value) {
  if (!value) {
    return null;
  }

  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => stringifyPeople(entry)).filter(Boolean).join(", ");
  }

  if (typeof value === "object") {
    const parts = [];
    if (value.name) {
      parts.push(value.name);
    }
    if (value.email) {
      parts.push(`<${value.email}>`);
    }
    if (value.url) {
      parts.push(`(${value.url})`);
    }
    return parts.join(" ");
  }

  return null;
}

function stringifyLicense(value) {
  if (!value) {
    return "UNKNOWN";
  }

  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => stringifyLicense(entry)).filter(Boolean).join(", ");
  }

  if (typeof value === "object" && value.type) {
    return value.type;
  }

  return "UNKNOWN";
}

function normalizeRepository(value) {
  if (!value) {
    return null;
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "object" && typeof value.url === "string") {
    return value.url;
  }

  return null;
}

function findNoticeFiles(packageDir) {
  if (!existsSync(packageDir)) {
    return [];
  }

  const entries = readdirSync(packageDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => /^(license|licence|copying|notice)([._-].+)?$/i.test(name))
    .sort((a, b) => a.localeCompare(b));
}

function readNoticeFile(filePath) {
  const stats = statSync(filePath);
  if (stats.size > 512 * 1024) {
    return "[omitted: notice file is larger than 512 KiB]";
  }

  return readFileSync(filePath, "utf8").trim();
}

function formatPackageSection(sectionTitle, packages) {
  const lines = [`## ${sectionTitle}`, ""];

  for (const entry of packages) {
    lines.push(`### ${entry.name} ${entry.version}`);
    lines.push("");
    lines.push(`- License: ${entry.license}`);
    if (entry.authors) {
      lines.push(`- Authors: ${entry.authors}`);
    }
    if (entry.repository) {
      lines.push(`- Source: ${entry.repository}`);
    } else if (entry.homepage) {
      lines.push(`- Homepage: ${entry.homepage}`);
    }
    lines.push("");

    if (entry.noticeFiles.length === 0) {
      lines.push("_No local license or notice file was found in the installed package._");
      lines.push("");
      continue;
    }

    for (const noticeFile of entry.noticeFiles) {
      lines.push(`#### ${noticeFile.name}`);
      lines.push("");
      lines.push("```text");
      lines.push(noticeFile.content);
      lines.push("```");
      lines.push("");
    }
  }

  return lines;
}

function collectRustPackages() {
  const packages = new Map();

  for (const target of rustTargets) {
    let metadata;
    try {
      metadata = cargoMetadata(target, { offline: true });
    } catch (error) {
      const stderr = typeof error?.stderr === "string" ? error.stderr : "";
      const needsOnlineRetry =
        stderr.includes("you're using offline mode") ||
        stderr.includes("no matching package named") ||
        stderr.includes("failed to download");

      if (!needsOnlineRetry) {
        throw error;
      }

      metadata = cargoMetadata(target, { offline: false });
    }

    for (const pkg of metadata.packages.filter((candidate) => candidate.source)) {
      if (packages.has(pkg.id)) {
        continue;
      }

      const packageDir = path.dirname(pkg.manifest_path);
      const noticeFiles = findNoticeFiles(packageDir).map((name) => ({
        name,
        content: readNoticeFile(path.join(packageDir, name)),
      }));

      packages.set(pkg.id, {
        name: pkg.name,
        version: pkg.version,
        license: pkg.license ?? "UNKNOWN",
        authors: Array.isArray(pkg.authors) && pkg.authors.length > 0 ? pkg.authors.join(", ") : null,
        homepage: pkg.homepage ?? pkg.documentation ?? null,
        repository: pkg.repository ?? null,
        noticeFiles,
      });
    }
  }

  return [...packages.values()]
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

function collectNodePackages() {
  const lock = readJson(path.join(rootDir, "package-lock.json"));
  const entries = Object.entries(lock.packages ?? {})
    .filter(([packagePath, pkg]) => {
      if (!packagePath.startsWith("node_modules/")) {
        return false;
      }

      // Skip platform-specific optional packages so the generated notices stay
      // stable across macOS/Linux CI environments.
      if (pkg?.optional && (Array.isArray(pkg.os) || Array.isArray(pkg.cpu))) {
        return false;
      }

      return true;
    })
    .map(([packagePath]) => {
      const packageDir = path.join(rootDir, packagePath);
      const packageJsonPath = path.join(packageDir, "package.json");
      if (!existsSync(packageJsonPath)) {
        return null;
      }

      const pkg = readJson(packageJsonPath);
      const noticeFiles = findNoticeFiles(packageDir).map((name) => ({
        name,
        content: readNoticeFile(path.join(packageDir, name)),
      }));

      return {
        name: pkg.name ?? packagePath.replace(/^node_modules\//, ""),
        version: pkg.version ?? "UNKNOWN",
        license: stringifyLicense(pkg.license),
        authors:
          stringifyPeople(pkg.author) ??
          stringifyPeople(pkg.authors) ??
          stringifyPeople(pkg.contributors),
        homepage: typeof pkg.homepage === "string" ? pkg.homepage : null,
        repository: normalizeRepository(pkg.repository),
        noticeFiles,
      };
    })
    .filter(Boolean);

  return entries.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

const rustPackages = collectRustPackages();
const nodePackages = collectNodePackages();

const output = [
  "# Third-Party Licenses",
  "",
  "This file was generated from the currently installed Rust and npm dependencies used by riida.",
  "",
  `- Rust dependencies: ${rustPackages.length}`,
  `- npm dependencies: ${nodePackages.length}`,
  "",
  "_Regenerate with `npm run generate:third-party-licenses` inside the Nix development shell._",
  "",
  ...formatPackageSection("Rust Dependencies", rustPackages),
  ...formatPackageSection("npm Dependencies", nodePackages),
].join("\n");

writeFileSync(outputFile, `${output}\n`, "utf8");
console.log(`Wrote ${path.relative(rootDir, outputFile)}`);
