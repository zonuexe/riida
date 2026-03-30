#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const cargoDir = path.join(rootDir, "src-tauri");
const outputFile = path.join(rootDir, "THIRD-PARTY-LICENSES.md");

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

function currentRustHost() {
  const versionOutput = run("rustc", ["-vV"], cargoDir);
  const hostLine = versionOutput
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("host: "));

  return hostLine ? hostLine.replace("host: ", "") : null;
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
  const host = currentRustHost();
  const metadataArgs = ["metadata", "--manifest-path", "src-tauri/Cargo.toml", "--format-version", "1", "--offline"];
  if (host) {
    metadataArgs.push("--filter-platform", host);
  }

  const metadata = JSON.parse(
    run("cargo", metadataArgs),
  );

  return metadata.packages
    .filter((pkg) => pkg.source)
    .map((pkg) => {
      const packageDir = path.dirname(pkg.manifest_path);
      const noticeFiles = findNoticeFiles(packageDir).map((name) => ({
        name,
        content: readNoticeFile(path.join(packageDir, name)),
      }));

      return {
        name: pkg.name,
        version: pkg.version,
        license: pkg.license ?? "UNKNOWN",
        authors: Array.isArray(pkg.authors) && pkg.authors.length > 0 ? pkg.authors.join(", ") : null,
        homepage: pkg.homepage ?? pkg.documentation ?? null,
        repository: pkg.repository ?? null,
        noticeFiles,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

function collectNodePackages() {
  const lock = readJson(path.join(rootDir, "package-lock.json"));
  const entries = Object.entries(lock.packages ?? {})
    .filter(([packagePath]) => packagePath.startsWith("node_modules/"))
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
