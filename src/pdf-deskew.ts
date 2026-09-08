// Skew detection for scanned PDF pages.
//
// Book scans (BOOKSCAN and similar services) routinely capture each sheet a
// fraction of a degree off square, so the printed text runs slightly downhill
// across the page. The viewer corrects this per page: it renders the page once
// at a small sampling size, measures the tilt of the printed lines here, then
// renders the real canvas with the counter-rotation folded into the pdf.js
// canvas transform (`deskewCanvasTransform`) and gives the text and link
// overlays the matching CSS transform (`deskewTransformForAngle`).
//
// The estimator is the classic projection-profile method. Dark (ink) pixels
// are projected onto an axis for a sweep of candidate angles; the projection
// whose histogram is sharpest — text rows collapse into narrow spikes with
// empty gutters between them only when the axis is truly perpendicular to the
// lines — marks the skew. The same sweep is run for vertical text columns so
// tategaki (縦書き) pages are handled by the same pass, and the orientation
// whose peak stands out more from its own sweep wins.
//
// Everything here is DOM-free so it can be unit-tested against synthetic
// pages; `measurePdfPageSkew` only touches pdf.js and the canvas through
// structural interfaces that tests can fake.

export type GrayImage = {
  width: number;
  height: number;
  /** Row-major luminance samples, 0 (black) .. 255 (white). */
  data: Uint8Array | Uint8ClampedArray;
};

export type DeskewOptions = {
  /** Largest tilt considered, in degrees. Scans beyond this are left alone. */
  maxAngleDeg: number;
  /** Step of the first (coarse) sweep over `[-maxAngleDeg, maxAngleDeg]`. */
  coarseStepDeg: number;
  /** Step of the refinement sweep around the coarse winner. */
  fineStepDeg: number;
  /** Fraction of each edge ignored so scanner shadows and page borders do not vote. */
  marginRatio: number;
  /** Detected tilts smaller than this are reported as level (`null`). */
  minAngleDeg: number;
  /** Peak-to-median ratio of the sweep a result must reach to be trusted. */
  minConfidence: number;
  /** Fewer ink pixels than this means a blank page; nothing to measure. */
  minDarkPixels: number;
  /** More ink than this fraction of the area means a photo or a dark scan; skip it. */
  maxDarkRatio: number;
};

const DEFAULT_DESKEW_OPTIONS: DeskewOptions = {
  maxAngleDeg: 3,
  coarseStepDeg: 0.25,
  fineStepDeg: 0.05,
  marginRatio: 0.06,
  minAngleDeg: 0.1,
  minConfidence: 1.12,
  minDarkPixels: 400,
  maxDarkRatio: 0.35,
};

export type DeskewOrientation = "rows" | "columns";

export type DeskewResult = {
  /**
   * Tilt of the printed lines in screen coordinates, in degrees. Positive means
   * the text runs downhill to the right (a clockwise tilt as seen on screen), so
   * `rotate(-angleDeg)` levels it.
   */
  angleDeg: number;
  /** Peak-to-median ratio of the winning sweep; larger is more certain. */
  confidence: number;
  /** Whether horizontal rows or vertical columns produced the winning peak. */
  orientation: DeskewOrientation;
};

/** Sampling size used when the viewer downscales a page canvas for detection. */
export const DESKEW_SAMPLE_LONG_EDGE = 640;

const DEG_TO_RAD = Math.PI / 180;

/** Collapse RGBA canvas pixels to Rec. 601 luminance. */
export function rgbaToGray(rgba: Uint8ClampedArray | Uint8Array, pixelCount: number): Uint8Array {
  const gray = new Uint8Array(pixelCount);
  for (let index = 0, offset = 0; index < pixelCount; index += 1, offset += 4) {
    const r = rgba[offset] ?? 0;
    const g = rgba[offset + 1] ?? 0;
    const b = rgba[offset + 2] ?? 0;
    gray[index] = (r * 77 + g * 151 + b * 28) >> 8;
  }
  return gray;
}

/**
 * Otsu's threshold over a 256-bin luminance histogram: the cut that maximises
 * the between-class variance of the two resulting populations. Returns the
 * largest value counted as "dark".
 */
export function otsuThreshold(histogram: ArrayLike<number>): number {
  let total = 0;
  let weightedSum = 0;
  for (let level = 0; level < 256; level += 1) {
    const count = histogram[level] ?? 0;
    total += count;
    weightedSum += level * count;
  }
  if (total === 0) {
    return 127;
  }

  let bestThreshold = 127;
  let bestVariance = -1;
  let backgroundCount = 0;
  let backgroundSum = 0;
  for (let level = 0; level < 256; level += 1) {
    const count = histogram[level] ?? 0;
    backgroundCount += count;
    if (backgroundCount === 0) {
      continue;
    }
    const foregroundCount = total - backgroundCount;
    if (foregroundCount === 0) {
      break;
    }
    backgroundSum += level * count;
    const backgroundMean = backgroundSum / backgroundCount;
    const foregroundMean = (weightedSum - backgroundSum) / foregroundCount;
    const difference = backgroundMean - foregroundMean;
    const variance = backgroundCount * foregroundCount * difference * difference;
    if (variance > bestVariance) {
      bestVariance = variance;
      bestThreshold = level;
    }
  }
  return bestThreshold;
}

type InkPoints = {
  xs: Int16Array;
  ys: Int16Array;
  count: number;
  width: number;
  height: number;
};

/**
 * Binarise the interior of the page and collect the coordinates of its ink
 * pixels. Coordinates are relative to the cropped region; only relative
 * positions matter for the projection.
 */
function collectInkPoints(image: GrayImage, options: DeskewOptions): InkPoints | null {
  const { width, height, data } = image;
  if (width < 8 || height < 8 || data.length < width * height) {
    return null;
  }

  const marginX = Math.floor(width * options.marginRatio);
  const marginY = Math.floor(height * options.marginRatio);
  const left = marginX;
  const right = width - marginX;
  const top = marginY;
  const bottom = height - marginY;
  const cropWidth = right - left;
  const cropHeight = bottom - top;
  if (cropWidth < 4 || cropHeight < 4) {
    return null;
  }

  const histogram = new Uint32Array(256);
  for (let y = top; y < bottom; y += 1) {
    const rowOffset = y * width;
    for (let x = left; x < right; x += 1) {
      const level = data[rowOffset + x] ?? 255;
      histogram[level] = (histogram[level] ?? 0) + 1;
    }
  }
  const threshold = otsuThreshold(histogram);

  let darkCount = 0;
  for (let level = 0; level <= threshold; level += 1) {
    darkCount += histogram[level] ?? 0;
  }
  const area = cropWidth * cropHeight;
  if (darkCount < options.minDarkPixels || darkCount > area * options.maxDarkRatio) {
    return null;
  }

  const xs = new Int16Array(darkCount);
  const ys = new Int16Array(darkCount);
  let count = 0;
  for (let y = top; y < bottom; y += 1) {
    const rowOffset = y * width;
    for (let x = left; x < right; x += 1) {
      if ((data[rowOffset + x] ?? 255) <= threshold) {
        xs[count] = x - left;
        ys[count] = y - top;
        count += 1;
      }
    }
  }

  return { xs, ys, count, width: cropWidth, height: cropHeight };
}

/**
 * Sharpness of the projection of the ink onto the axis perpendicular to lines
 * tilted by `angleDeg`: the sum of squared bin counts, which is maximal when
 * ink piles into few bins. Row profiles collapse horizontal text lines; column
 * profiles collapse vertical ones.
 */
function projectionScore(
  points: InkPoints,
  angleDeg: number,
  orientation: DeskewOrientation,
  bins: Int32Array,
): number {
  const radians = angleDeg * DEG_TO_RAD;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  // Rotating by -angle maps a line tilted by +angle onto a constant coordinate.
  // Offset keeps every projected coordinate non-negative for the full sweep.
  const offset = Math.ceil(Math.max(points.width, points.height) * Math.abs(sin)) + 1;
  bins.fill(0);
  const { xs, ys, count } = points;
  if (orientation === "rows") {
    for (let index = 0; index < count; index += 1) {
      const projected = Math.round(ys[index]! * cos - xs[index]! * sin) + offset;
      bins[projected] = (bins[projected] ?? 0) + 1;
    }
  } else {
    for (let index = 0; index < count; index += 1) {
      const projected = Math.round(xs[index]! * cos + ys[index]! * sin) + offset;
      bins[projected] = (bins[projected] ?? 0) + 1;
    }
  }

  let score = 0;
  for (let index = 0; index < bins.length; index += 1) {
    const value = bins[index]!;
    score += value * value;
  }
  return score;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length === 0) {
    return 0;
  }
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

type SweepResult = {
  angleDeg: number;
  confidence: number;
  atBoundary: boolean;
};

function sweepOrientation(
  points: InkPoints,
  orientation: DeskewOrientation,
  options: DeskewOptions,
): SweepResult {
  const longEdge = Math.max(points.width, points.height);
  const maxShift = Math.ceil(longEdge * Math.sin(options.maxAngleDeg * DEG_TO_RAD)) + 1;
  const bins = new Int32Array(longEdge + maxShift * 2 + 2);

  const coarseScores: number[] = [];
  let bestAngle = 0;
  let bestScore = -1;
  const coarseSteps = Math.round((options.maxAngleDeg * 2) / options.coarseStepDeg);
  for (let step = 0; step <= coarseSteps; step += 1) {
    const angle = -options.maxAngleDeg + step * options.coarseStepDeg;
    const score = projectionScore(points, angle, orientation, bins);
    coarseScores.push(score);
    if (score > bestScore) {
      bestScore = score;
      bestAngle = angle;
    }
  }
  const baseline = median(coarseScores);
  const atBoundary = Math.abs(Math.abs(bestAngle) - options.maxAngleDeg) < 1e-9;

  // Refine around the coarse winner; the true peak is within one coarse step.
  const fineSteps = Math.round(options.coarseStepDeg / options.fineStepDeg);
  for (let step = -fineSteps; step <= fineSteps; step += 1) {
    if (step === 0) {
      continue;
    }
    const angle = bestAngle + step * options.fineStepDeg;
    if (Math.abs(angle) > options.maxAngleDeg + 1e-9) {
      continue;
    }
    const score = projectionScore(points, angle, orientation, bins);
    if (score > bestScore) {
      bestScore = score;
      bestAngle = angle;
    }
  }

  return {
    angleDeg: bestAngle,
    confidence: baseline > 0 ? bestScore / baseline : 0,
    atBoundary,
  };
}

/**
 * Estimate the tilt of the printed content of a page sample.
 *
 * Returns `null` when the page is blank, mostly image, too faint to measure,
 * or already level within `minAngleDeg`. A non-null result carries the angle
 * to undo (see `DeskewResult.angleDeg`).
 */
export function detectSkewAngle(
  image: GrayImage,
  overrides: Partial<DeskewOptions> = {},
): DeskewResult | null {
  const options = { ...DEFAULT_DESKEW_OPTIONS, ...overrides };
  const points = collectInkPoints(image, options);
  if (!points) {
    return null;
  }

  const rows = sweepOrientation(points, "rows", options);
  const columns = sweepOrientation(points, "columns", options);
  const winner = rows.confidence >= columns.confidence ? rows : columns;
  const orientation: DeskewOrientation = winner === rows ? "rows" : "columns";

  if (winner.atBoundary || winner.confidence < options.minConfidence) {
    return null;
  }

  const angleDeg = Number(winner.angleDeg.toFixed(2));
  if (Math.abs(angleDeg) < options.minAngleDeg) {
    return null;
  }

  return { angleDeg, confidence: winner.confidence, orientation };
}

export type DeskewTransform = {
  /** CSS rotation, in degrees, that levels the content. */
  rotateDeg: number;
  /** Uniform scale-up so the rotated content still covers the page frame. */
  scale: number;
};

/**
 * Transform that levels content tilted by `angleDeg` inside a `width × height`
 * frame. The content is counter-rotated and enlarged just enough that its
 * rotated bounds still cover the frame, so no background shows in the corners;
 * the frame clips the sliver that spills past each edge.
 */
export function deskewTransformForAngle(
  angleDeg: number,
  width: number,
  height: number,
): DeskewTransform {
  const radians = Math.abs(angleDeg) * DEG_TO_RAD;
  const safeWidth = Math.max(width, 1);
  const safeHeight = Math.max(height, 1);
  const aspect = Math.max(safeWidth / safeHeight, safeHeight / safeWidth);
  const scale = Math.cos(radians) + aspect * Math.sin(radians);
  return {
    rotateDeg: Number((-angleDeg).toFixed(2)),
    scale: Number(scale.toFixed(4)),
  };
}

/**
 * Canvas transform (the `transform` argument of pdf.js `page.render`) that
 * draws a page tilted by `angleDeg` level. `width × height` is the viewport in
 * CSS pixels and `outputScale` the device-pixel multiplier the canvas backing
 * store uses; the result composes that multiplier with a counter-rotation and
 * cover-scale about the canvas centre, in the `[a, b, c, d, e, f]` form of
 * `CanvasRenderingContext2D.setTransform`.
 *
 * Baking the correction into the raster keeps the page frame — its edges,
 * shadow, and white background — perfectly square; only the printed content
 * turns. Overlay layers (text selection, links) receive the matching CSS
 * transform through `deskewTransformForAngle` so hit targets stay aligned.
 */
export function deskewCanvasTransform(
  angleDeg: number,
  width: number,
  height: number,
  outputScale: number,
): [number, number, number, number, number, number] {
  const { rotateDeg, scale } = deskewTransformForAngle(angleDeg, width, height);
  const radians = rotateDeg * DEG_TO_RAD;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const k = scale * outputScale;
  const centerX = (width * outputScale) / 2;
  const centerY = (height * outputScale) / 2;
  // p' = k·R·p + (c − s·R·c): scale the CSS-pixel input into device pixels,
  // rotate about the origin, then shift so the canvas centre maps onto itself.
  // `+ 0` folds a signed zero (from `-k * 0`) into plain zero so a level page
  // yields the exact output-scale matrix.
  return [
    k * cos,
    k * sin + 0,
    -k * sin + 0,
    k * cos,
    centerX - scale * (cos * centerX - sin * centerY) + 0,
    centerY - scale * (sin * centerX + cos * centerY) + 0,
  ];
}

/** Sample dimensions that shrink `width × height` so its longer edge is `longEdge`. */
export function deskewSampleSize(
  width: number,
  height: number,
  longEdge: number = DESKEW_SAMPLE_LONG_EDGE,
): { width: number; height: number } {
  const safeWidth = Math.max(width, 1);
  const safeHeight = Math.max(height, 1);
  const factor = Math.min(1, longEdge / Math.max(safeWidth, safeHeight));
  return {
    width: Math.max(1, Math.round(safeWidth * factor)),
    height: Math.max(1, Math.round(safeHeight * factor)),
  };
}

export type DeskewViewportLike = {
  width: number;
  height: number;
};

// Method signatures (not function-typed properties) so pdf.js's PDFPageProxy,
// whose render() takes a wider parameter object, is assignable here.
export type DeskewPageLike = {
  getViewport(params: { scale: number }): DeskewViewportLike;
  render(params: {
    canvas?: DeskewCanvasLike | null;
    canvasContext?: DeskewContextLike | null;
    viewport: DeskewViewportLike;
  }): { promise: Promise<unknown> };
};

export type DeskewCanvasLike = {
  width: number;
  height: number;
};

export type DeskewContextLike = {
  getImageData: (
    x: number,
    y: number,
    width: number,
    height: number,
  ) => { data: Uint8ClampedArray | Uint8Array };
};

export type DeskewSampleSurface = {
  canvas: DeskewCanvasLike;
  context: DeskewContextLike;
};

/**
 * Render a page at sampling size onto `surface` and measure its skew. The
 * surface is a scratch canvas the caller keeps around (ideally created with
 * `willReadFrequently`) so every page reuses one backing store. Rendering is
 * cheap here: pdf.js has already decoded the page's images for the main
 * render, so this is a single downscaled draw plus one pixel read-back.
 */
export async function measurePdfPageSkew(
  page: DeskewPageLike,
  surface: DeskewSampleSurface,
  overrides: Partial<DeskewOptions> = {},
): Promise<DeskewResult | null> {
  const base = page.getViewport({ scale: 1 });
  const sample = deskewSampleSize(base.width, base.height);
  const scale = sample.width / Math.max(base.width, 1);
  const viewport = page.getViewport({ scale });
  const width = Math.max(1, Math.ceil(viewport.width));
  const height = Math.max(1, Math.ceil(viewport.height));
  surface.canvas.width = width;
  surface.canvas.height = height;
  await page.render({ canvas: surface.canvas, canvasContext: surface.context, viewport }).promise;
  const { data } = surface.context.getImageData(0, 0, width, height);
  return detectSkewAngle({ width, height, data: rgbaToGray(data, width * height) }, overrides);
}

/**
 * Per-document memo of measured page angles. Re-renders (zoom, resize, scroll
 * window shifts) hit the cache instead of sampling the page again; opening a
 * different file drops the previous document's entries.
 */
export class PdfDeskewCache {
  private filePath: string | null = null;
  private angles = new Map<number, number | null>();

  /** `undefined` when the page has not been measured for this file yet. */
  lookup(filePath: string, pageNumber: number): number | null | undefined {
    if (this.filePath !== filePath) {
      return undefined;
    }
    return this.angles.get(pageNumber);
  }

  store(filePath: string, pageNumber: number, angleDeg: number | null): void {
    if (this.filePath !== filePath) {
      this.filePath = filePath;
      this.angles = new Map();
    }
    this.angles.set(pageNumber, angleDeg);
  }

  clear(): void {
    this.filePath = null;
    this.angles = new Map();
  }
}

/**
 * Lazily-created scratch surface plus per-document cache behind
 * `measurePdfPageSkew`, so an entry point only has to say how to make a
 * canvas. A measurement failure (a page that refuses to render, a context
 * that cannot be created) is remembered as "level" for the document so it is
 * neither retried on every re-render nor allowed to break page rendering.
 */
export class PdfDeskewMeasurer {
  private readonly cache = new PdfDeskewCache();
  private surface: DeskewSampleSurface | null | undefined;

  constructor(private readonly createSurface: () => DeskewSampleSurface | null) {}

  async angleFor(
    page: DeskewPageLike,
    filePath: string,
    pageNumber: number,
  ): Promise<number | null> {
    const cached = this.cache.lookup(filePath, pageNumber);
    if (cached !== undefined) {
      return cached;
    }
    if (this.surface === undefined) {
      this.surface = this.createSurface();
    }
    let angle: number | null = null;
    if (this.surface) {
      try {
        angle = (await measurePdfPageSkew(page, this.surface))?.angleDeg ?? null;
      } catch (error) {
        console.warn("[riida] deskew: page measurement failed:", error);
      }
    }
    this.cache.store(filePath, pageNumber, angle);
    return angle;
  }

  forget(): void {
    this.cache.clear();
  }
}

export type DeskewStyledElement = {
  dataset: { deskew?: string };
  style: {
    setProperty: (name: string, value: string) => void;
    removeProperty: (name: string) => string;
  };
};

/**
 * Mark a page element as deskewed by `angleDeg` (or clear the mark for
 * `null`). The stylesheet reads `data-deskew` and the two custom properties
 * to rotate the overlay layers; `width × height` is the page frame the
 * overlays cover, which fixes the cover-scale.
 */
export function applyPdfPageDeskewStyle(
  pageEl: DeskewStyledElement,
  angleDeg: number | null,
  width: number,
  height: number,
): void {
  if (angleDeg === null) {
    delete pageEl.dataset.deskew;
    pageEl.style.removeProperty("--deskew-rotate");
    pageEl.style.removeProperty("--deskew-scale");
    return;
  }
  const { rotateDeg, scale } = deskewTransformForAngle(angleDeg, width, height);
  pageEl.dataset.deskew = "true";
  pageEl.style.setProperty("--deskew-rotate", `${rotateDeg}deg`);
  pageEl.style.setProperty("--deskew-scale", String(scale));
}
