import { readdir, stat } from "node:fs/promises";
import path from "node:path";

const assetsDir = path.resolve("dist/assets");

async function main() {
  const entries = await readdir(assetsDir);
  const targets = entries.filter(
    (entry) =>
      entry.startsWith("index-") ||
      entry.startsWith("pdf.worker-") ||
      entry.startsWith("THIRD-PARTY-LICENSES-"),
  );

  const rows = await Promise.all(
    targets
      .sort((a, b) => a.localeCompare(b))
      .map(async (entry) => {
        const filePath = path.join(assetsDir, entry);
        const info = await stat(filePath);
        return {
          entry,
          bytes: info.size,
          kib: (info.size / 1024).toFixed(1),
        };
      }),
  );

  console.log("Bundle size report:");
  for (const row of rows) {
    console.log(`- ${row.entry}: ${row.kib} KiB (${row.bytes} bytes)`);
  }
}

main().catch((error) => {
  console.error(`Failed to report bundle sizes: ${error}`);
  process.exitCode = 1;
});
