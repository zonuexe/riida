// Shared PDF.js runtime loader and binary-data factory.
//
// Both src/main.ts (library shell) and src/main-viewer.ts (standalone
// viewer window) consume this module. Each Tauri webview has its own
// JavaScript context, so the cached promise is intentionally per-window —
// concurrent renders in two windows don't share the same PDF.js worker.

type BinaryDataKind = "cMapUrl" | "standardFontDataUrl" | "wasmUrl";

export type PdfJsRuntime = {
  TextLayer: typeof import("pdfjs-dist").TextLayer;
  getDocument: typeof import("pdfjs-dist").getDocument;
};

/**
 * Binary-data factory for PDF.js that works under the Tauri 2 webview
 * protocol on macOS.
 *
 * PDF.js's bundled `DOMBinaryDataFactory` ultimately calls the exported
 * `fetchData()`, which short-circuits on `isValidFetchUrl()` — a hard-coded
 * `http(s):` allow-list. In Tauri 2 macOS production the document loads from
 * `tauri://localhost`, every relative URL resolves to that scheme, and PDF.js
 * falls through to an XHR-based code path that silently completes with an
 * empty body. The result is that CMap files (and standard font data files)
 * appear to load successfully but contain zero bytes, so PDF.js can never do
 * CID → Unicode mapping for non-embedded standard CJK fonts and renders raw
 * CIDs to the canvas as garbage codepoints.
 *
 * The fix is to bypass PDF.js's whitelist by using plain `fetch()` directly —
 * which works on `tauri:` URLs in WKWebView — and feed the resulting bytes
 * into PDF.js via the `BinaryDataFactory` API option.
 */
export class TauriBinaryDataFactory {
  cMapUrl: string | null;
  standardFontDataUrl: string | null;
  wasmUrl: string | null;

  constructor({
    cMapUrl = null,
    standardFontDataUrl = null,
    wasmUrl = null,
  }: {
    cMapUrl?: string | null;
    standardFontDataUrl?: string | null;
    wasmUrl?: string | null;
  }) {
    this.cMapUrl = cMapUrl;
    this.standardFontDataUrl = standardFontDataUrl;
    this.wasmUrl = wasmUrl;
  }

  async fetch({ kind, filename }: { kind: BinaryDataKind; filename: string }): Promise<Uint8Array> {
    const baseUrl = this[kind];
    if (!baseUrl) {
      throw new Error(`Ensure that the \`${kind}\` API parameter is provided.`);
    }
    const url = `${baseUrl}${filename}`;
    let response: Response;
    try {
      response = await fetch(url);
    } catch (error) {
      throw new Error(`Unable to load ${kind} data at: ${url} (${String(error)})`);
    }
    if (!response.ok) {
      throw new Error(`Unable to load ${kind} data at: ${url} (HTTP ${response.status})`);
    }
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }
}

let pdfJsRuntimePromise: Promise<PdfJsRuntime> | null = null;

export async function loadPdfJsRuntime(): Promise<PdfJsRuntime> {
  pdfJsRuntimePromise ??= Promise.all([
    import("pdfjs-dist/build/pdf.min.mjs"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]).then(([runtime, workerModule]) => {
    runtime.GlobalWorkerOptions.workerSrc = workerModule.default;

    return {
      TextLayer: runtime.TextLayer,
      getDocument: runtime.getDocument,
    };
  });

  return pdfJsRuntimePromise;
}
