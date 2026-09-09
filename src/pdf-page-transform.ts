// Geometry for drawing a PDF page with scan corrections applied.
//
// Two corrections can act on a page: deskew (rotate the printed content level,
// see src/pdf-deskew.ts) and margin trimming (show only the printed area, see
// src/pdf-trim.ts). Both are folded into the pdf.js canvas `transform` so the
// raster is drawn corrected in one pass and the canvas itself is the clip; the
// text-selection and link overlays, which pdf.js lays out in plain viewport
// coordinates, receive the same affine map as a CSS `matrix()` so hit targets
// stay registered with what is drawn.

export type Matrix6 = [number, number, number, number, number, number];

/** A rectangle in viewport CSS pixels of the untrimmed page. */
export type CropRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PageContentTransformInput = {
  /** Untrimmed page size at the render scale, in CSS pixels. */
  width: number;
  height: number;
  /** Device-pixel multiplier of the canvas backing store. */
  outputScale: number;
  /** Measured tilt (see DeskewResult.angleDeg); `null` or 0 leaves the page unrotated. */
  angleDeg: number | null;
  /** Printed area to keep; `null` keeps the whole page. */
  crop: CropRect | null;
};

export type PageContentTransform = {
  /** `transform` argument for pdf.js `page.render`; `undefined` means identity. */
  canvas: Matrix6 | undefined;
  /** Same map in CSS pixels for the overlay layers; `null` when they need none. */
  overlay: Matrix6 | null;
  /** Size of the drawn content (the page element and canvas), in CSS pixels. */
  contentWidth: number;
  contentHeight: number;
};

const DEG_TO_RAD = Math.PI / 180;

/**
 * Render scale for a page whose canvas should come out `targetHeightPx` tall.
 *
 * A canvas costs four bytes per pixel, so deriving its size from the page's own
 * dimensions makes the cost depend on the paper rather than on the screen: a
 * B4 art book or a 600dpi capture pays several times what a paperback page
 * pays at the same size on screen. Sizing from the height the canvas will
 * actually occupy instead makes the cost per page uniform.
 *
 * `limits.max` is what keeps this a saving rather than a trade: set to the
 * fixed scale it replaces, no page is ever drawn at a higher resolution than
 * before, and only the pages that were being over-rendered come down.
 * `limits.min` keeps a poster-sized sheet from going blurry.
 */
export function canvasRenderScale(
  pageHeight: number,
  targetHeightPx: number,
  limits: { min?: number; max?: number } = {},
): number {
  const scale = Math.max(targetHeightPx, 1) / Math.max(pageHeight, 1);
  return Math.min(Math.max(scale, limits.min ?? 0.25), limits.max ?? 4);
}

export type DeskewTransform = {
  /** CSS rotation, in degrees, that levels the content. */
  rotateDeg: number;
  /** Uniform scale-up so the rotated content still covers the page frame. */
  scale: number;
};

/**
 * Rotation that levels content tilted by `angleDeg` inside a `width × height`
 * frame, plus the enlargement that keeps the rotated bounds covering the frame
 * so no background shows in the corners.
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
 * Affine map from untrimmed-page CSS pixels to the drawn content.
 *
 * The content is rotated about the page centre (deskew), then shifted so the
 * crop's top-left corner lands on the origin. Without a crop the rotation also
 * enlarges by the cover scale so the page frame stays filled; with a crop the
 * trimmed margins already hide the rotated corners, so the print keeps its
 * measured size. The device matrix multiplies the whole map by `outputScale`.
 */
export function pageContentTransform(input: PageContentTransformInput): PageContentTransform {
  const { width, height, outputScale, crop } = input;
  const angleDeg = input.angleDeg ?? 0;
  const contentWidth = crop?.width ?? width;
  const contentHeight = crop?.height ?? height;

  if (angleDeg === 0 && !crop) {
    return {
      canvas: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
      overlay: null,
      contentWidth,
      contentHeight,
    };
  }

  const { rotateDeg, scale: coverScale } = deskewTransformForAngle(angleDeg, width, height);
  const scale = crop ? 1 : coverScale;
  const radians = rotateDeg * DEG_TO_RAD;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const centerX = width / 2;
  const centerY = height / 2;
  const offsetX = crop?.x ?? 0;
  const offsetY = crop?.y ?? 0;
  // p' = o·(s·R·(p − C) + C − offset). `+ 0` folds signed zeros so a page
  // with no rotation yields the plain translation matrix.
  const build = (o: number): Matrix6 => [
    o * scale * cos,
    o * scale * sin + 0,
    -o * scale * sin + 0,
    o * scale * cos,
    o * (centerX - scale * (cos * centerX - sin * centerY) - offsetX) + 0,
    o * (centerY - scale * (sin * centerX + cos * centerY) - offsetY) + 0,
  ];

  return {
    canvas: build(outputScale),
    overlay: build(1),
    contentWidth,
    contentHeight,
  };
}

export function matrixToCss(matrix: Matrix6): string {
  return `matrix(${matrix.map((value) => Number(value.toFixed(6))).join(", ")})`;
}

export type OverlayStyledElement = {
  dataset: { contentTransform?: string };
  style: {
    setProperty: (name: string, value: string) => void;
    removeProperty: (name: string) => string;
  };
};

/**
 * Publish (or clear) the overlay map on a page element. The stylesheet reads
 * `data-content-transform` and `--pdf-overlay-transform` to move the text and
 * link layers with the raster.
 */
export function applyPdfPageOverlayTransform(
  pageEl: OverlayStyledElement,
  overlay: Matrix6 | null,
): void {
  if (!overlay) {
    delete pageEl.dataset.contentTransform;
    pageEl.style.removeProperty("--pdf-overlay-transform");
    return;
  }
  pageEl.dataset.contentTransform = "true";
  pageEl.style.setProperty("--pdf-overlay-transform", matrixToCss(overlay));
}

export type Rect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

/** Axis-aligned bounds of `rect` after mapping its corners through `matrix`. */
export function mapRectThroughMatrix(matrix: Matrix6, rect: Rect): Rect {
  const [a, b, c, d, e, f] = matrix;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [x, y] of [
    [rect.left, rect.top],
    [rect.left + rect.width, rect.top],
    [rect.left, rect.top + rect.height],
    [rect.left + rect.width, rect.top + rect.height],
  ] as const) {
    const mappedX = a * x + c * y + e;
    const mappedY = b * x + d * y + f;
    minX = Math.min(minX, mappedX);
    minY = Math.min(minY, mappedY);
    maxX = Math.max(maxX, mappedX);
    maxY = Math.max(maxY, mappedY);
  }
  return { left: minX, top: minY, width: maxX - minX, height: maxY - minY };
}
