import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, normalizePath } from "vite";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
import { viteStaticCopy } from "vite-plugin-static-copy";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  build: {
    target: "es2024",
    rollupOptions: {
      input: {
        index: path.resolve(projectRoot, "index.html"),
        viewer: path.resolve(projectRoot, "viewer.html"),
      },
    },
  },
  esbuild: {
    target: "es2024",
  },
  define: {
    __BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10)),
  },
  assetsInclude: ["**/LICENSE", "**/THIRD-PARTY-LICENSES-rust.md", "**/THIRD-PARTY-LICENSES-js.md"],

  plugins: [
    viteStaticCopy({
      targets: [
        {
          src: normalizePath(path.resolve("node_modules/pdfjs-dist/cmaps/*")),
          dest: "pdfjs/cmaps",
          structured: false,
        },
        {
          src: normalizePath(path.resolve("node_modules/pdfjs-dist/standard_fonts/*")),
          dest: "pdfjs/standard_fonts",
          structured: false,
        },
      ],
    }),
  ],

  test: {
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "mcp-server/**",
      "**/.stryker-tmp/**",
      ".claude/worktrees/**",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      all: true,
      include: ["src/**/*.ts"],
      exclude: [
        "src/main.ts",
        "src/main-viewer.ts",
        "src/note-editor.ts",
        "src/cjk-radical-map.ts",
        "src/vendor/**",
        "src/**/*.test.ts",
        "src/vite-env.d.ts",
      ],
      thresholds: {
        lines: 80,
        functions: 90,
        branches: 70,
        statements: 80,
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
