#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const cargoDir = path.join(rootDir, "src-tauri");
const rustOutputFile = path.join(rootDir, "THIRD-PARTY-LICENSES-rust.md");
const jsOutputFile = path.join(rootDir, "THIRD-PARTY-LICENSES-js.md");
const rustTargets = [
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "x86_64-unknown-linux-gnu",
  "x86_64-pc-windows-msvc",
];
const KNOWN_LICENSE_BODIES = [
  {
    title: "Apache-2.0",
    anchor: "apache-20",
    canonicalContentFile: path.join(rootDir, "licenses", "Apache-2.0.txt"),
    canonicalContentSha256: "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30",
    sha256s: new Set([
      "4bf96504d6e83ce5c6fc7167f1795d9ceaa68e70ab86bc5d08ab93184262bbbe",
      "283ea6cc2997a1a70da0049e09adf9317bb60ca1b51279b65196b83a69e1996b",
      "a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2",
      "62c7a1e35f56406896d7aa7ca52d0cc0d272ac022b5d2796e7d6905db8a3636a",
      "8ada45cd9f843acf64e4722ae262c622a2b3b3007c7310ef36ac1061a30f6adb",
    ]),
    appendixOmittedSha256s: new Set([
      "62c7a1e35f56406896d7aa7ca52d0cc0d272ac022b5d2796e7d6905db8a3636a",
    ]),
  },
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

  return readFileSync(filePath, "utf8").trimEnd();
}

function normalizeNoticeContent(content) {
  return content.replace(/\r/g, "");
}

function noticeContentSha256(content) {
  return createHash("sha256").update(normalizeNoticeContent(content)).digest("hex");
}

function looksLikeApacheLicenseBody(content) {
  const normalizedContent = normalizeNoticeContent(content);
  return (
    /^\s*Apache License\s*\n\s*Version 2\.0, January 2004/m.test(normalizedContent) &&
    normalizedContent.includes("TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION") &&
    normalizedContent.includes('1. Definitions.') &&
    normalizedContent.includes('2. Grant of Copyright License.') &&
    !normalizedContent.includes("```")
  );
}

function resolveKnownLicenseBody(content) {
  const sha256 = noticeContentSha256(content);
  const match = KNOWN_LICENSE_BODIES.find((entry) => {
    if (entry.title === "Apache-2.0" && looksLikeApacheLicenseBody(content)) {
      return true;
    }
    return entry.sha256s.has(sha256);
  });

  if (!match) {
    return null;
  }
  const canonicalContent = normalizeNoticeContent(readFileSync(match.canonicalContentFile, "utf8"));
  const canonicalContentSha256 = noticeContentSha256(canonicalContent);

  if (match.canonicalContentSha256 && canonicalContentSha256 !== match.canonicalContentSha256) {
    throw new Error(
      `${match.title} canonical text hash mismatch: expected ${match.canonicalContentSha256}, got ${canonicalContentSha256}`,
    );
  }

  return {
    title: match.title,
    anchor: match.anchor,
    appendixOmitted: match.appendixOmittedSha256s.has(sha256),
    content: canonicalContent,
    sha256,
  };
}

function formatPackageSection(sectionTitle, packages, appendixEntries, options = {}) {
  const { enableKnownLicenseAppendix = true } = options;
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
      const knownLicenseBody = resolveKnownLicenseBody(noticeFile.content);

      if (knownLicenseBody && enableKnownLicenseAppendix) {
        appendixEntries.set(knownLicenseBody.anchor, knownLicenseBody);
        const referenceLabel =
          knownLicenseBody.title === "Apache-2.0"
            ? "full text of the Apache License 2.0"
            : `full text of ${knownLicenseBody.title}`;
        const referenceText = knownLicenseBody.appendixOmitted
          ? `_See the [${referenceLabel}](#${knownLicenseBody.anchor}). The original package license text omitted the APPENDIX section._`
          : `_See the [${referenceLabel}](#${knownLicenseBody.anchor})._`;
        lines.push(referenceText);
        lines.push("");
        continue;
      }

      lines.push("```text");
      lines.push(normalizeNoticeContent(noticeFile.content));
      lines.push("```");
      lines.push("");
    }
  }

  return lines;
}

function formatLicenseBodyAppendix(appendixEntries) {
  if (appendixEntries.size === 0) {
    return [];
  }

  const lines = ["## License body", ""];

  for (const entry of appendixEntries.values()) {
    lines.push(`### ${entry.title}`);
    lines.push("");
    lines.push("```text");
    lines.push(entry.content);
    lines.push("```");
    lines.push("");
  }

  return lines;
}

// Compute the set of package ids reachable from the workspace members through
// normal/build dependency edges, excluding dev-only edges. Dev-dependencies
// (e.g. proptest) and crates reachable only through them are compiled for
// `cargo test` but never shipped in the release binary, so they do not belong
// in the bundled notices — the analogue of `license-checker --production` on
// the npm side. Returns null if the metadata lacks resolve info, in which case
// the caller falls back to including every package.
function computeProductionPackageIds(metadata) {
  const resolve = metadata.resolve;
  if (!resolve || !Array.isArray(resolve.nodes)) {
    return null;
  }

  const nodeById = new Map(resolve.nodes.map((node) => [node.id, node]));
  const roots =
    Array.isArray(metadata.workspace_members) && metadata.workspace_members.length > 0
      ? metadata.workspace_members
      : resolve.root
        ? [resolve.root]
        : [];

  const included = new Set();
  const stack = [...roots];
  while (stack.length > 0) {
    const id = stack.pop();
    if (included.has(id)) {
      continue;
    }
    included.add(id);

    const node = nodeById.get(id);
    if (!node || !Array.isArray(node.deps)) {
      continue;
    }

    for (const dep of node.deps) {
      const kinds = Array.isArray(dep.dep_kinds) ? dep.dep_kinds : [];
      // Keep normal (kind === null) and build edges; drop dev-only edges. An
      // empty dep_kinds (older cargo) is treated as a normal dependency.
      const isProduction =
        kinds.length === 0 || kinds.some((entry) => entry.kind === null || entry.kind === "build");
      if (isProduction && !included.has(dep.pkg)) {
        stack.push(dep.pkg);
      }
    }
  }

  return included;
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

    const productionIds = computeProductionPackageIds(metadata);

    for (const pkg of metadata.packages.filter((candidate) => candidate.source)) {
      if (packages.has(pkg.id)) {
        continue;
      }

      // Skip dev-only crates (not part of the shipped binary).
      if (productionIds && !productionIds.has(pkg.id)) {
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

      // Skip dev-only dependencies. These bundled notices cover code shipped in
      // the production build, mirroring `license-checker --production`; test and
      // build tooling (vitest, oxlint, jsdom, WebdriverIO, …) is not shipped.
      // npm's lockfile (v3) marks dev-only packages with `dev: true`.
      if (pkg?.dev === true) {
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
const rustAppendixEntries = new Map();
const jsAppendixEntries = new Map();

const rustOutput = [
  "# Third-Party Licenses (Rust)",
  "",
  "This file was generated from the production Rust dependencies used by riida. Dev-only crates are excluded.",
  "",
  `- Rust dependencies: ${rustPackages.length}`,
  "",
  "_Regenerate with `npm run generate:third-party-licenses` inside the Nix development shell._",
  "",
  ...formatPackageSection("Rust Dependencies", rustPackages, rustAppendixEntries, {
    enableKnownLicenseAppendix: true,
  }),
  ...formatLicenseBodyAppendix(rustAppendixEntries),
].join("\n");

const jsOutput = [
  "# Third-Party Licenses (JavaScript)",
  "",
  "This file was generated from the production (bundled) JavaScript dependencies used by riida. Dev-only tooling is excluded.",
  "",
  `- npm dependencies: ${nodePackages.length}`,
  "",
  "_Regenerate with `npm run generate:third-party-licenses` inside the Nix development shell._",
  "",
  ...formatPackageSection("npm Dependencies", nodePackages, jsAppendixEntries, {
    enableKnownLicenseAppendix: true,
  }),
  ...formatLicenseBodyAppendix(jsAppendixEntries),
].join("\n");

writeFileSync(rustOutputFile, `${rustOutput}\n`, "utf8");
writeFileSync(jsOutputFile, `${jsOutput}\n`, "utf8");
console.log(`Wrote ${path.relative(rootDir, rustOutputFile)}`);
console.log(`Wrote ${path.relative(rootDir, jsOutputFile)}`);
