// @vitest-environment jsdom
//
// Integration smoke test for the library-shell entry point (src/main.ts).
//
// Unlike the helper-module unit tests, this imports the real entry point,
// injects the real index.html body, mocks the Tauri backend, and drives the
// DOMContentLoaded boot to completion. It exercises the otherwise-untested
// integration glue (config load, snapshot fetch, renderApp, startup phase)
// and catches frontend boot regressions that pure-logic tests cannot.
//
// It runs under Node/jsdom, so it does NOT reproduce the WKWebView runtime or
// the Rust backend — it asserts the frontend boots and renders, not that the
// real app launches.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import indexHtml from "../index.html?raw";

const BOOKS = [
  {
    fileName: "alpha.pdf",
    title: "Alpha Title",
    filePath: "/books/alpha.pdf",
    fileSize: 1024,
    tags: ["tech"],
    authors: ["Alice"],
    sourceType: "pdf",
    coverUrl: null,
    locationLabel: "/books",
    isOpenable: true,
    asin: null,
    url: null,
    publisher: "Packt",
    language: "en",
    lastReadAt: null,
    indexedAt: 1,
  },
  {
    fileName: "beta.pdf",
    title: "Beta Title",
    filePath: "/books/beta.pdf",
    fileSize: 2048,
    tags: [],
    authors: ["Bob"],
    sourceType: "pdf",
    coverUrl: null,
    locationLabel: "/books",
    isOpenable: true,
    asin: null,
    url: null,
    publisher: null,
    language: "ja",
    lastReadAt: null,
    indexedAt: 2,
  },
];

const SNAPSHOT = {
  libraryRoots: ["/books"],
  existingLibraryRoots: ["/books"],
  missingLibraryRoots: [],
  indexedCount: BOOKS.length,
  books: BOOKS,
  excludedPatterns: [],
  pdfRenderer: "pdfjs",
  customSources: [],
};

const APP_CONFIG = {
  configPath: "/config/riida.toml",
  configExists: true,
  libraryRoots: ["/books"],
  excludedPatterns: [],
  pdfRenderer: "pdfjs",
  theme: "default",
  enabledExternalSources: [],
};

const invoke = vi.fn<(command: string, args?: unknown) => Promise<unknown>>(async (command) => {
  switch (command) {
    case "load_app_config":
      return APP_CONFIG;
    case "list_shelves":
      return [];
    case "library_snapshot":
    case "load_library_snapshot":
      return SNAPSHOT;
    case "book_thumbnail":
      return null;
    default:
      return null;
  }
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  convertFileSrc: (path: string) => path,
}));
vi.mock("@tauri-apps/api/app", () => ({
  getName: async () => "riida",
  getVersion: async () => "0.0.0-test",
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async () => () => {},
}));
vi.mock("@tauri-apps/api/path", () => ({
  homeDir: async () => "/home/test",
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: async () => false,
  message: async () => {},
  open: async () => null,
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: async () => {},
  revealItemInDir: async () => {},
}));

function loadIndexHtmlBody(): string {
  const match = /<body[^>]*>([\s\S]*)<\/body>/.exec(indexHtml);
  const body = match?.[1];
  if (body === undefined) throw new Error("could not extract <body> from index.html");
  return body;
}

describe("library shell boot", () => {
  beforeEach(() => {
    invoke.mockClear();
    // jsdom does not implement IntersectionObserver, which the thumbnail
    // lazy-loader instantiates during render.
    class IntersectionObserverStub {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
      takeRecords(): [] {
        return [];
      }
    }
    vi.stubGlobal("IntersectionObserver", IntersectionObserverStub);
    document.body.innerHTML = loadIndexHtmlBody();
    document.body.dataset.startup = "loading";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("boots without throwing and renders the library snapshot", async () => {
    await import("./main");
    window.dispatchEvent(new Event("DOMContentLoaded"));

    // The startup phase completes once the config load resolves.
    await vi.waitFor(() => {
      expect(document.body.dataset.startup).toBe("ready");
    });

    // The mocked backend was queried for config and the library snapshot.
    const commands = invoke.mock.calls.map((call) => call[0]);
    expect(commands).toContain("load_app_config");
    expect(commands).toContain("library_snapshot");

    // Both books from the snapshot are rendered into the shell.
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Alpha Title");
      expect(document.body.textContent).toContain("Beta Title");
    });
  });
});
