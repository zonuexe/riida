// Sample renders of PDF pages and the per-document analysis built on them.
//
// Every scan correction starts from the same small grayscale render of a page
// (long edge 640 px): deskew reads the tilt of the printed lines from it
// (src/pdf-deskew.ts) and margin trimming reads the extent of the print
// (src/pdf-trim.ts). `PdfPageAnalyzer` renders that sample once per page,
// runs both measurements, and memoises the result per document, so the
// trimming pre-pass and the per-page deskew at render time share their work.
//
// Nothing here touches the DOM directly; pdf.js and the canvas are reached
// through structural interfaces that tests can fake.

import { detectSkewAngle } from "./pdf-deskew";
import { rgbaToGray, type GrayImage } from "./pdf-gray-image";
import {
  aggregateTrimBoxes,
  loadCachedPdfTrim,
  measureInkBox,
  rotateInkBox,
  saveCachedPdfTrim,
  trimSamplePageNumbers,
  type InkBox,
  type TrimBoxes,
  type TrimSample,
  type TrimStorage,
} from "./pdf-trim";

/** Long edge, in pixels, of the sample a page is rendered at for analysis. */
export const PAGE_SAMPLE_LONG_EDGE = 640;

/** Sample dimensions that shrink `width × height` so its longer edge is `longEdge`. */
export function pageSampleSize(
  width: number,
  height: number,
  longEdge: number = PAGE_SAMPLE_LONG_EDGE,
): { width: number; height: number } {
  const safeWidth = Math.max(width, 1);
  const safeHeight = Math.max(height, 1);
  const factor = Math.min(1, longEdge / Math.max(safeWidth, safeHeight));
  return {
    width: Math.max(1, Math.round(safeWidth * factor)),
    height: Math.max(1, Math.round(safeHeight * factor)),
  };
}

export type PageViewportLike = {
  width: number;
  height: number;
};

export type SampleCanvasLike = {
  width: number;
  height: number;
};

export type SampleContextLike = {
  getImageData: (
    x: number,
    y: number,
    width: number,
    height: number,
  ) => { data: Uint8ClampedArray | Uint8Array };
};

// Method signatures (not function-typed properties) so pdf.js's PDFPageProxy,
// whose render() takes a wider parameter object, is assignable here.
export type PdfPageLike = {
  getViewport(params: { scale: number }): PageViewportLike;
  render(params: {
    canvas?: SampleCanvasLike | null;
    canvasContext?: SampleContextLike | null;
    viewport: PageViewportLike;
  }): { promise: Promise<unknown> };
};

export type PdfDocumentLike = {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageLike>;
};

export type PageSampleSurface = {
  canvas: SampleCanvasLike;
  context: SampleContextLike;
};

/**
 * Render `page` at sampling size onto `surface` and read it back as
 * grayscale. The surface is a scratch canvas the caller keeps around (ideally
 * created with `willReadFrequently`) so every page reuses one backing store.
 * Rendering is cheap: pdf.js caches the decoded page images, so this is a
 * single downscaled draw plus one pixel read-back.
 */
export async function renderPageSample(
  page: PdfPageLike,
  surface: PageSampleSurface,
): Promise<GrayImage> {
  const base = page.getViewport({ scale: 1 });
  const sample = pageSampleSize(base.width, base.height);
  const scale = sample.width / Math.max(base.width, 1);
  const viewport = page.getViewport({ scale });
  const width = Math.max(1, Math.ceil(viewport.width));
  const height = Math.max(1, Math.ceil(viewport.height));
  surface.canvas.width = width;
  surface.canvas.height = height;
  await page.render({ canvas: surface.canvas, canvasContext: surface.context, viewport }).promise;
  const { data } = surface.context.getImageData(0, 0, width, height);
  return { width, height, data: rgbaToGray(data, width * height) };
}

export type PdfPageAnalysis = {
  /** Measured tilt of the print (DeskewResult.angleDeg), or `null` when level or unmeasurable. */
  angleDeg: number | null;
  /** Extent of the print as page fractions, or `null` for a blank page. */
  inkBox: InkBox | null;
  /** Sample dimensions, which carry the page's aspect ratio. */
  width: number;
  height: number;
};

const EMPTY_ANALYSIS: PdfPageAnalysis = { angleDeg: null, inkBox: null, width: 0, height: 0 };

export function analyzePageSample(image: GrayImage): PdfPageAnalysis {
  return {
    angleDeg: detectSkewAngle(image)?.angleDeg ?? null,
    inkBox: measureInkBox(image),
    width: image.width,
    height: image.height,
  };
}

/**
 * Lazily-created scratch surface plus per-document memo behind
 * `renderPageSample` + `analyzePageSample`. A failure (a page that refuses to
 * render, a context that cannot be created) is remembered as "nothing
 * measured" so it is neither retried on every re-render nor allowed to break
 * page rendering.
 */
export class PdfPageAnalyzer {
  private filePath: string | null = null;
  private pages = new Map<number, PdfPageAnalysis>();
  private surface: PageSampleSurface | null | undefined;

  constructor(private readonly createSurface: () => PageSampleSurface | null) {}

  async analyze(page: PdfPageLike, filePath: string, pageNumber: number): Promise<PdfPageAnalysis> {
    if (this.filePath !== filePath) {
      this.filePath = filePath;
      this.pages = new Map();
    }
    const cached = this.pages.get(pageNumber);
    if (cached) {
      return cached;
    }
    if (this.surface === undefined) {
      this.surface = this.createSurface();
    }
    let analysis = EMPTY_ANALYSIS;
    if (this.surface) {
      try {
        analysis = analyzePageSample(await renderPageSample(page, this.surface));
      } catch (error) {
        console.warn("[riida] page analysis failed:", error);
      }
    }
    // Guard against a different document having been opened meanwhile.
    if (this.filePath === filePath) {
      this.pages.set(pageNumber, analysis);
    }
    return analysis;
  }

  forget(): void {
    this.filePath = null;
    this.pages = new Map();
  }
}

export type ResolvePdfTrimBoxesParams = {
  document: PdfDocumentLike;
  filePath: string;
  /** Whether deskew is active; the print's extent is then taken after rotation. */
  deskew: boolean;
  analyzer: PdfPageAnalyzer;
  isCancelled?: () => boolean;
  onProgress?: (measured: number, total: number) => void;
  storage?: TrimStorage | null;
};

/**
 * The document's crop boxes: from the per-file cache when present, otherwise
 * measured on a spread of sample pages and cached. Returns `null` when the
 * document is cancelled mid-way or yields nothing trimmable.
 */
export async function resolvePdfTrimBoxes(
  params: ResolvePdfTrimBoxesParams,
): Promise<TrimBoxes | null> {
  const { document, filePath, deskew, analyzer, isCancelled, onProgress } = params;
  const cached =
    params.storage === undefined
      ? loadCachedPdfTrim(filePath, document.numPages, deskew)
      : loadCachedPdfTrim(filePath, document.numPages, deskew, params.storage);
  if (cached) {
    return cached;
  }

  const pageNumbers = trimSamplePageNumbers(document.numPages);
  const samples: TrimSample[] = [];
  for (const [index, pageNumber] of pageNumbers.entries()) {
    if (isCancelled?.()) {
      return null;
    }
    const page = await document.getPage(pageNumber);
    const analysis = await analyzer.analyze(page, filePath, pageNumber);
    if (analysis.inkBox) {
      const box =
        deskew && analysis.angleDeg !== null
          ? rotateInkBox(analysis.inkBox, analysis.angleDeg, analysis.width, analysis.height)
          : analysis.inkBox;
      samples.push({ pageNumber, box });
    }
    onProgress?.(index + 1, pageNumbers.length);
  }
  if (isCancelled?.()) {
    return null;
  }

  const boxes = aggregateTrimBoxes(samples);
  if (boxes) {
    if (params.storage === undefined) {
      saveCachedPdfTrim(filePath, document.numPages, deskew, boxes);
    } else {
      saveCachedPdfTrim(filePath, document.numPages, deskew, boxes, params.storage);
    }
  }
  return boxes;
}
