// Skew detection for scanned PDF pages.
//
// Book scans (BOOKSCAN and similar services) routinely capture each sheet a
// fraction of a degree off square, so the printed text runs slightly downhill
// across the page. The viewer measures the tilt on a small sample render of
// each page (src/pdf-page-sample.ts) and draws the real canvas with the
// counter-rotation folded into the pdf.js transform (src/pdf-page-transform.ts).
//
// The estimator is the classic projection-profile method. Dark (ink) pixels
// are projected onto an axis for a sweep of candidate angles; the projection
// whose histogram is sharpest — text rows collapse into narrow spikes with
// empty gutters between them only when the axis is truly perpendicular to the
// lines — marks the skew. The same sweep is run for vertical text columns so
// tategaki (縦書き) pages are handled by the same pass, and the orientation
// whose peak stands out more from its own sweep wins.

import { luminanceHistogram, otsuThreshold, type GrayImage } from "./pdf-gray-image";

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

const DEG_TO_RAD = Math.PI / 180;

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

  const histogram = luminanceHistogram(image, left, top, right, bottom);
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
