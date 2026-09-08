// Grayscale page samples shared by the scan-analysis helpers
// (src/pdf-deskew.ts, src/pdf-trim.ts, src/pdf-page-sample.ts).

export type GrayImage = {
  width: number;
  height: number;
  /** Row-major luminance samples, 0 (black) .. 255 (white). */
  data: Uint8Array | Uint8ClampedArray;
};

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

/**
 * Luminance histogram of the rectangle `[left, right) × [top, bottom)`, the
 * input both binarisers start from.
 */
export function luminanceHistogram(
  image: GrayImage,
  left: number,
  top: number,
  right: number,
  bottom: number,
): Uint32Array {
  const histogram = new Uint32Array(256);
  const { width, data } = image;
  for (let y = top; y < bottom; y += 1) {
    const rowOffset = y * width;
    for (let x = left; x < right; x += 1) {
      const level = data[rowOffset + x] ?? 255;
      histogram[level] = (histogram[level] ?? 0) + 1;
    }
  }
  return histogram;
}
