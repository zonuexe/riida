export type BindingDirection = "left" | "right";

export type ViewerPreferencesLike = {
  Direction?: unknown;
  [key: string]: unknown;
};

export type TextStyleLike = {
  vertical?: boolean;
};

export type TextItemLike = {
  str: string;
  fontName: string;
  transform?: ReadonlyArray<number>;
};

export type TextContentSampleLike = {
  items: ReadonlyArray<TextItemLike | { type: string }>;
  styles: { [name: string]: TextStyleLike };
};

const VERTICAL_BINDING_THRESHOLD_RATIO = 0.4;
const VERTICAL_BINDING_MIN_CHARACTERS = 30;

// Geometry path thresholds. Aggregated across all sampled pages so that
// sparse-text PDFs (image-heavy CJK novels with only page-number text)
// can still surface a usable signal. Tuned permissively because real-world
// horizontal Western books still produce |Δx| >> |Δy| by a wide margin —
// we mostly need to clear the noise floor on PDFs with very sparse text.
const GEOMETRY_BINDING_MIN_ITEMS = 20;
const GEOMETRY_BINDING_MIN_TOTAL_DELTA = 100;
const GEOMETRY_BINDING_RATIO = 1.2;

export function detectBindingFromViewerPreferences(
  preferences: ViewerPreferencesLike | null | undefined,
): BindingDirection | null {
  if (!preferences || typeof preferences !== "object") {
    return null;
  }
  const direction = preferences.Direction;
  if (direction === "R2L") {
    return "right";
  }
  if (direction === "L2R") {
    return "left";
  }
  return null;
}

export type TextContentBindingDiagnostic = {
  verticalChars: number;
  horizontalChars: number;
  totalChars: number;
  geometryItems: number;
  cumulativeDx: number;
  cumulativeDy: number;
  cmapPathTriggers: boolean;
  geometryPathTriggers: boolean;
  result: BindingDirection | null;
};

function summarizeBindingFromTextContent(
  samples: ReadonlyArray<TextContentSampleLike>,
): TextContentBindingDiagnostic {
  let verticalChars = 0;
  let horizontalChars = 0;
  let geometryItems = 0;
  let cumulativeDx = 0;
  let cumulativeDy = 0;

  for (const sample of samples) {
    let previousTx: number | null = null;
    let previousTy: number | null = null;

    for (const item of sample.items) {
      if (!isTextItem(item)) continue;
      const length = item.str.length;
      if (length === 0) continue;

      const style = sample.styles[item.fontName];
      if (style?.vertical === true) {
        verticalChars += length;
      } else {
        horizontalChars += length;
      }

      const tx = item.transform?.[4];
      const ty = item.transform?.[5];
      if (typeof tx === "number" && typeof ty === "number") {
        if (previousTx !== null && previousTy !== null) {
          cumulativeDx += Math.abs(tx - previousTx);
          cumulativeDy += Math.abs(ty - previousTy);
        }
        previousTx = tx;
        previousTy = ty;
        geometryItems += 1;
      }
    }
  }

  const totalChars = verticalChars + horizontalChars;
  const cmapPathTriggers =
    totalChars >= VERTICAL_BINDING_MIN_CHARACTERS &&
    verticalChars / totalChars >= VERTICAL_BINDING_THRESHOLD_RATIO;

  const totalDelta = cumulativeDx + cumulativeDy;
  // Treat purely vertical motion (dx === 0) as a definitive vertical signal
  // instead of dividing by zero.
  const ratio = cumulativeDx === 0 ? Infinity : cumulativeDy / cumulativeDx;
  const geometryPathTriggers =
    geometryItems >= GEOMETRY_BINDING_MIN_ITEMS &&
    totalDelta >= GEOMETRY_BINDING_MIN_TOTAL_DELTA &&
    ratio >= GEOMETRY_BINDING_RATIO;

  return {
    verticalChars,
    horizontalChars,
    totalChars,
    geometryItems,
    cumulativeDx,
    cumulativeDy,
    cmapPathTriggers,
    geometryPathTriggers,
    result: cmapPathTriggers || geometryPathTriggers ? "right" : null,
  };
}

export function detectBindingFromTextContent(
  samples: ReadonlyArray<TextContentSampleLike>,
): BindingDirection | null {
  return summarizeBindingFromTextContent(samples).result;
}

export function detectPdfBinding(
  preferences: ViewerPreferencesLike | null | undefined,
  samples: ReadonlyArray<TextContentSampleLike>,
): BindingDirection | null {
  const fromPrefs = detectBindingFromViewerPreferences(preferences);
  if (fromPrefs !== null) {
    return fromPrefs;
  }
  return detectBindingFromTextContent(samples);
}

export type PdfPageLike = {
  streamTextContent?: (params?: object) => ReadableStream<TextContentSampleLike>;
  getTextContent?: () => Promise<TextContentSampleLike>;
};

export type PdfBindingDocumentLike = {
  numPages: number;
  getViewerPreferences?: () => Promise<unknown>;
  getPage: (pageNumber: number) => Promise<PdfPageLike>;
};

// Sparse-text Japanese tategaki PDFs often place real body content well
// past the cover and front matter, so the heuristic walks up to this many
// linear pages before giving up.
const PDF_BINDING_DETECT_MAX_PAGES = 50;

/**
 * Resolve a `bindingDirection: "auto"` preference against an actual PDF
 * document by combining three signals, from highest confidence to lowest:
 * the catalog's `Direction` viewer preference, the binding hint that falls
 * out of text-content styles (vertical CMaps), and the geometry heuristic
 * over consecutive text item positions.
 *
 * Returns `null` when detection is inconclusive (e.g. pure-image PDFs).
 * Callers should fall back to a saved preference or a hard default in that
 * case.
 *
 * `isCancelled` is consulted between async steps so that navigating away
 * mid-detection (e.g. opening a new book) does not waste work or return a
 * stale result.
 */
export async function detectPdfBindingDirection(
  pdfDocument: PdfBindingDocumentLike,
  isCancelled: () => boolean,
): Promise<BindingDirection | null> {
  let viewerPreferences: unknown = null;
  if (typeof pdfDocument.getViewerPreferences === "function") {
    try {
      viewerPreferences = await pdfDocument.getViewerPreferences();
    } catch {
      viewerPreferences = null;
    }
  }
  if (isCancelled()) return null;
  const fromPrefs = detectBindingFromViewerPreferences(
    viewerPreferences as Parameters<typeof detectBindingFromViewerPreferences>[0],
  );
  if (fromPrefs !== null) {
    return fromPrefs;
  }

  const limit = Math.min(PDF_BINDING_DETECT_MAX_PAGES, pdfDocument.numPages);
  const samples: TextContentSampleLike[] = [];
  let firstError: unknown = null;
  let errorCount = 0;
  for (let pageNumber = 1; pageNumber <= limit; pageNumber += 1) {
    if (isCancelled()) return null;
    try {
      const page = await pdfDocument.getPage(pageNumber);
      const content = await readPageTextContentForBinding(page);
      samples.push(content);
    } catch (error) {
      // Best-effort: skip individual page failures, but surface the first
      // so we can diagnose runtime errors that wipe out every sample.
      errorCount += 1;
      if (firstError === null) firstError = error;
    }
  }
  if (errorCount > 0) {
    console.warn(
      `[riida] binding-detect: ${errorCount}/${limit} sample pages threw; first error:`,
      firstError,
    );
  }
  return summarizeBindingFromTextContent(samples).result;
}

/**
 * Drain a pdf.js page's text content into a single sample. Tauri's
 * WKWebView on macOS does not implement
 * `ReadableStream[Symbol.asyncIterator]`, but `PDFPageProxy.getTextContent`
 * (pdf.js 5.6) consumes the underlying `streamTextContent` ReadableStream
 * with `for await ... of`. Read the stream by hand via `getReader()` so
 * detection works in production builds while still falling back to
 * `getTextContent` if a runtime exposes only that.
 */
export async function readPageTextContentForBinding(
  page: PdfPageLike,
): Promise<TextContentSampleLike> {
  if (typeof page.streamTextContent !== "function") {
    if (typeof page.getTextContent === "function") {
      return page.getTextContent();
    }
    throw new Error("Page exposes neither streamTextContent nor getTextContent");
  }
  const stream = page.streamTextContent();
  const reader = stream.getReader();
  const items: Array<TextContentSampleLike["items"][number]> = [];
  const styles: TextContentSampleLike["styles"] = {};
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (Array.isArray(value.items)) items.push(...value.items);
      if (value.styles) Object.assign(styles, value.styles);
    }
  } finally {
    reader.releaseLock();
  }
  return { items, styles };
}

function isTextItem(candidate: TextItemLike | { type: string }): candidate is TextItemLike {
  return (
    typeof (candidate as TextItemLike).str === "string" &&
    typeof (candidate as TextItemLike).fontName === "string"
  );
}
