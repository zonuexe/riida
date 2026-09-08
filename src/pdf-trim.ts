// Margin trimming for scanned PDF pages.
//
// A book scan keeps the whole sheet, so on screen the printed area is framed
// by margins that only cost space: in a two-page spread they push the text
// down to a size that no longer fits the window height. Trimming shows just
// the printed area instead. The printed area is measured once per document on
// a sample of pages (src/pdf-page-sample.ts), aggregated into one crop box
// per page parity — recto and verso carry mirrored gutter margins — with the
// vertical extent shared by both so a spread stays level, and the resulting
// crop is folded into the page render (src/pdf-page-transform.ts). One box
// per parity, rather than one per page, keeps the type size and the page
// frame stable from page to page.

import * as v from "valibot";
import { luminanceHistogram, otsuThreshold, type GrayImage } from "./pdf-gray-image";
import type { CropRect } from "./pdf-page-transform";

/** Printed area of a page as fractions of its width/height (edges exclusive). */
export type InkBox = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export type InkBoxOptions = {
  /** Fraction of each edge ignored so scanner shadows do not count as print. */
  edgeIgnoreRatio: number;
  /** Ink a row/column needs, as a fraction of its length, to count as print. */
  minInkRatio: number;
  /** Absolute floor for that count so dust specks never open the box. */
  minInkPixels: number;
};

const DEFAULT_INK_BOX_OPTIONS: InkBoxOptions = {
  edgeIgnoreRatio: 0.02,
  minInkRatio: 0.004,
  minInkPixels: 3,
};

/**
 * Bounding box of the ink on a page sample, or `null` for a blank page.
 *
 * Rows and columns are counted as printed when they hold enough ink and their
 * neighbour does too, so a stray speck or a one-pixel scan line cannot extend
 * the box, while a lone folio number (a few glyphs) still counts.
 */
export function measureInkBox(
  image: GrayImage,
  overrides: Partial<InkBoxOptions> = {},
): InkBox | null {
  const options = { ...DEFAULT_INK_BOX_OPTIONS, ...overrides };
  const { width, height, data } = image;
  if (width < 8 || height < 8 || data.length < width * height) {
    return null;
  }

  const edgeX = Math.floor(width * options.edgeIgnoreRatio);
  const edgeY = Math.floor(height * options.edgeIgnoreRatio);
  const left = edgeX;
  const right = width - edgeX;
  const top = edgeY;
  const bottom = height - edgeY;
  if (right - left < 4 || bottom - top < 4) {
    return null;
  }

  const histogram = luminanceHistogram(image, left, top, right, bottom);
  const threshold = otsuThreshold(histogram);
  let darkCount = 0;
  for (let level = 0; level <= threshold; level += 1) {
    darkCount += histogram[level] ?? 0;
  }
  if (darkCount === 0) {
    return null;
  }

  const rowInk = new Int32Array(height);
  const columnInk = new Int32Array(width);
  for (let y = top; y < bottom; y += 1) {
    const rowOffset = y * width;
    for (let x = left; x < right; x += 1) {
      if ((data[rowOffset + x] ?? 255) <= threshold) {
        rowInk[y] = (rowInk[y] ?? 0) + 1;
        columnInk[x] = (columnInk[x] ?? 0) + 1;
      }
    }
  }

  const minRowInk = Math.max(
    options.minInkPixels,
    Math.round((right - left) * options.minInkRatio),
  );
  const minColumnInk = Math.max(
    options.minInkPixels,
    Math.round((bottom - top) * options.minInkRatio),
  );
  const rowSpan = printedSpan(rowInk, top, bottom, minRowInk);
  const columnSpan = printedSpan(columnInk, left, right, minColumnInk);
  if (!rowSpan || !columnSpan) {
    return null;
  }

  return {
    left: columnSpan.start / width,
    top: rowSpan.start / height,
    right: columnSpan.end / width,
    bottom: rowSpan.end / height,
  };
}

/** First and one-past-last index in `[from, to)` whose ink count, together with a neighbour's, reaches `minInk`. */
function printedSpan(
  ink: Int32Array,
  from: number,
  to: number,
  minInk: number,
): { start: number; end: number } | null {
  const isPrinted = (index: number) => (ink[index] ?? 0) >= minInk;
  let start = -1;
  for (let index = from; index < to - 1; index += 1) {
    if (isPrinted(index) && isPrinted(index + 1)) {
      start = index;
      break;
    }
  }
  if (start < 0) {
    return null;
  }
  let end = -1;
  for (let index = to - 1; index > start; index -= 1) {
    if (isPrinted(index) && isPrinted(index - 1)) {
      end = index + 1;
      break;
    }
  }
  return end < 0 ? null : { start, end };
}

const DEG_TO_RAD = Math.PI / 180;

/**
 * Bounds of `box` after the page is deskewed by `angleDeg` (rotated about its
 * centre, see DeskewResult.angleDeg). `width × height` fixes the page's aspect
 * ratio, which the rotation needs since the box is stored as fractions.
 */
export function rotateInkBox(box: InkBox, angleDeg: number, width: number, height: number): InkBox {
  const radians = -angleDeg * DEG_TO_RAD;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const centerX = width / 2;
  const centerY = height / 2;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [fx, fy] of [
    [box.left, box.top],
    [box.right, box.top],
    [box.left, box.bottom],
    [box.right, box.bottom],
  ] as const) {
    const dx = fx * width - centerX;
    const dy = fy * height - centerY;
    const x = centerX + dx * cos - dy * sin;
    const y = centerY + dx * sin + dy * cos;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return clampInkBox({
    left: minX / width,
    top: minY / height,
    right: maxX / width,
    bottom: maxY / height,
  });
}

function clampInkBox(box: InkBox): InkBox {
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  return {
    left: clamp(box.left),
    top: clamp(box.top),
    right: clamp(box.right),
    bottom: clamp(box.bottom),
  };
}

export const FULL_PAGE_BOX: InkBox = { left: 0, top: 0, right: 1, bottom: 1 };

/** Crop boxes for a document: odd-numbered pages and even-numbered pages. */
export type TrimBoxes = {
  odd: InkBox;
  even: InkBox;
};

export type TrimSample = {
  pageNumber: number;
  box: InkBox;
};

export type TrimAggregateOptions = {
  /** Breathing room added around the printed area, as a fraction of the page. */
  paddingRatio: number;
  /** Share of samples per edge that may be ignored as outliers (a full-bleed plate). */
  outlierShare: number;
  /** Fewer measured pages than this and the document is left untrimmed. */
  minSamples: number;
  /** A box narrower or shorter than this fraction of the page is rejected as noise. */
  minSizeRatio: number;
};

const DEFAULT_TRIM_AGGREGATE_OPTIONS: TrimAggregateOptions = {
  paddingRatio: 0.015,
  outlierShare: 1 / 8,
  minSamples: 2,
  minSizeRatio: 0.3,
};

/**
 * Combine per-page ink boxes into the document's crop boxes.
 *
 * Each edge takes the most extended value across its samples after dropping
 * `outlierShare` of them, so one full-bleed illustration does not pin the box
 * to the sheet edge while every ordinary page keeps all of its print. Left and
 * right are aggregated per parity (mirrored gutters); top and bottom across
 * every sample, so facing pages share one height.
 */
export function aggregateTrimBoxes(
  samples: readonly TrimSample[],
  overrides: Partial<TrimAggregateOptions> = {},
): TrimBoxes | null {
  const options = { ...DEFAULT_TRIM_AGGREGATE_OPTIONS, ...overrides };
  if (samples.length < options.minSamples) {
    return null;
  }

  const drop = (count: number) => Math.floor(count * options.outlierShare);
  const top = pickEdge(
    samples.map((sample) => sample.box.top),
    "low",
    drop(samples.length),
  );
  const bottom = pickEdge(
    samples.map((sample) => sample.box.bottom),
    "high",
    drop(samples.length),
  );

  const horizontal = (parity: 0 | 1): { left: number; right: number } => {
    let group = samples.filter((sample) => sample.pageNumber % 2 === parity);
    if (group.length === 0) {
      group = [...samples];
    }
    return {
      left: pickEdge(
        group.map((sample) => sample.box.left),
        "low",
        drop(group.length),
      ),
      right: pickEdge(
        group.map((sample) => sample.box.right),
        "high",
        drop(group.length),
      ),
    };
  };

  const finish = (edges: { left: number; right: number }): InkBox => {
    const padded = clampInkBox({
      left: edges.left - options.paddingRatio,
      top: top - options.paddingRatio,
      right: edges.right + options.paddingRatio,
      bottom: bottom + options.paddingRatio,
    });
    if (
      padded.right - padded.left < options.minSizeRatio ||
      padded.bottom - padded.top < options.minSizeRatio
    ) {
      return { ...FULL_PAGE_BOX };
    }
    return padded;
  };

  return { odd: finish(horizontal(1)), even: finish(horizontal(0)) };
}

/**
 * The value that, after discarding `drop` of the most extended samples, still
 * covers every remaining one: the `drop`-th smallest for a "low" edge (top,
 * left) or the `drop`-th largest for a "high" edge (bottom, right).
 */
function pickEdge(values: number[], side: "low" | "high", drop: number): number {
  const sorted = [...values].sort((a, b) => (side === "low" ? a - b : b - a));
  const index = Math.min(Math.max(drop, 0), sorted.length - 1);
  return sorted[index] ?? (side === "low" ? 0 : 1);
}

/**
 * Pages to measure: `pairs` positions spread evenly through the document, each
 * taken together with its successor so both parities are always represented.
 * Short documents are measured in full.
 */
export function trimSamplePageNumbers(numPages: number, pairs = 8): number[] {
  const total = Math.max(0, Math.floor(numPages));
  if (total <= pairs * 2) {
    return Array.from({ length: total }, (_, index) => index + 1);
  }
  const pages = new Set<number>();
  for (let index = 0; index < pairs; index += 1) {
    const first = Math.min(total - 1, Math.max(1, Math.round(1 + ((index + 0.5) * total) / pairs)));
    pages.add(first);
    pages.add(first + 1);
  }
  return [...pages].sort((a, b) => a - b);
}

export function trimBoxForPage(boxes: TrimBoxes, pageNumber: number): InkBox {
  return pageNumber % 2 === 0 ? boxes.even : boxes.odd;
}

export type PageSize = {
  width: number;
  height: number;
};

/** Crop rectangle of a page in the units of `viewport`, or `null` without trimming. */
export function cropRectForPage(
  boxes: TrimBoxes | null,
  pageNumber: number,
  viewport: PageSize,
): CropRect | null {
  if (!boxes) {
    return null;
  }
  const box = trimBoxForPage(boxes, pageNumber);
  return {
    x: box.left * viewport.width,
    y: box.top * viewport.height,
    width: (box.right - box.left) * viewport.width,
    height: (box.bottom - box.top) * viewport.height,
  };
}

/** Size the page occupies once trimmed, in the units of `viewport`. */
export function trimmedPageSize(
  boxes: TrimBoxes | null,
  pageNumber: number,
  viewport: PageSize,
): PageSize {
  const crop = cropRectForPage(boxes, pageNumber, viewport);
  return crop
    ? { width: crop.width, height: crop.height }
    : { width: viewport.width, height: viewport.height };
}

// ---------------------------------------------------------------------------
// Persistence: the measured boxes are cached per file in localStorage so a
// document pays the sampling pass once, not on every open.

const TRIM_CACHE_VERSION = 1;

const inkBoxSchema = v.object({
  left: v.number(),
  top: v.number(),
  right: v.number(),
  bottom: v.number(),
});

const cachedTrimSchema = v.object({
  version: v.literal(TRIM_CACHE_VERSION),
  pageCount: v.number(),
  deskew: v.boolean(),
  odd: inkBoxSchema,
  even: inkBoxSchema,
});

export type TrimStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
};

export function pdfTrimStorageKey(filePath: string): string {
  return `riida:pdf-trim:${filePath}`;
}

function isSaneInkBox(box: InkBox): boolean {
  return (
    box.left >= 0 &&
    box.top >= 0 &&
    box.right <= 1 &&
    box.bottom <= 1 &&
    box.right > box.left &&
    box.bottom > box.top
  );
}

/**
 * Decode a cached entry, accepting it only when it was measured for the same
 * page count and the same deskew setting (deskew changes where the print
 * lands, so the boxes differ).
 */
export function parseCachedPdfTrim(
  rawValue: string | null,
  pageCount: number,
  deskew: boolean,
): TrimBoxes | null {
  if (!rawValue) {
    return null;
  }
  try {
    const result = v.safeParse(cachedTrimSchema, JSON.parse(rawValue));
    if (!result.success) {
      return null;
    }
    const { output } = result;
    if (output.pageCount !== pageCount || output.deskew !== deskew) {
      return null;
    }
    if (!isSaneInkBox(output.odd) || !isSaneInkBox(output.even)) {
      return null;
    }
    return { odd: output.odd, even: output.even };
  } catch {
    return null;
  }
}

function defaultTrimStorage(): TrimStorage | null {
  try {
    if (typeof window === "undefined") {
      return null;
    }
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadCachedPdfTrim(
  filePath: string,
  pageCount: number,
  deskew: boolean,
  storage: TrimStorage | null = defaultTrimStorage(),
): TrimBoxes | null {
  if (!filePath || !storage) {
    return null;
  }
  try {
    return parseCachedPdfTrim(storage.getItem(pdfTrimStorageKey(filePath)), pageCount, deskew);
  } catch {
    return null;
  }
}

export function saveCachedPdfTrim(
  filePath: string,
  pageCount: number,
  deskew: boolean,
  boxes: TrimBoxes,
  storage: TrimStorage | null = defaultTrimStorage(),
): void {
  if (!filePath || !storage) {
    return;
  }
  try {
    storage.setItem(
      pdfTrimStorageKey(filePath),
      JSON.stringify({
        version: TRIM_CACHE_VERSION,
        pageCount,
        deskew,
        odd: boxes.odd,
        even: boxes.even,
      }),
    );
  } catch {
    // Storage full or unavailable — the boxes are simply measured again next time.
  }
}
