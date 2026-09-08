// Synthetic page images and pdf.js fakes shared by the scan-analysis tests
// (pdf-deskew, pdf-trim, pdf-page-sample). Pages are drawn as blocks of
// word-like dashes so the projection and ink-box measurements have realistic
// structure to work on, with the whole print rotated about the page centre by
// a known tilt.

import type { GrayImage } from "./pdf-gray-image";
import type { PageSampleSurface, PageViewportLike, PdfPageLike } from "./pdf-page-sample";

const DEG_TO_RAD = Math.PI / 180;

const PAPER = 235;
const INK = 20;

export function blankPage(width: number, height: number, paper = PAPER): GrayImage {
  return { width, height, data: new Uint8Array(width * height).fill(paper) };
}

export function paint(image: GrayImage, x: number, y: number, value = INK): void {
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || py < 0 || px >= image.width || py >= image.height) {
    return;
  }
  image.data[py * image.width + px] = value;
}

/**
 * Fill a rectangle rotated about the page centre by `angleDeg` (clockwise on
 * screen, matching DeskewResult.angleDeg); `centerX/centerY` locate the
 * rectangle before rotation.
 */
function paintRotatedRect(
  image: GrayImage,
  centerX: number,
  centerY: number,
  width: number,
  height: number,
  angleDeg: number,
): void {
  const radians = angleDeg * DEG_TO_RAD;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const pivotX = image.width / 2;
  const pivotY = image.height / 2;
  for (let dy = -height / 2; dy <= height / 2; dy += 0.5) {
    for (let dx = -width / 2; dx <= width / 2; dx += 0.5) {
      const x = centerX + dx - pivotX;
      const y = centerY + dy - pivotY;
      paint(image, pivotX + x * cos - y * sin, pivotY + x * sin + y * cos);
    }
  }
}

export type TextBlock = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

/** Print rectangle used by `horizontalTextPage` / `verticalTextPage`, in pixels. */
export function textBlockFor(width: number, height: number): TextBlock {
  return { left: 60, top: 80, right: width - 60, bottom: height - 80 };
}

/** A page of horizontal "text": rows of short word-like dashes, tilted as a whole. */
export function horizontalTextPage(angleDeg: number, width = 480, height = 640): GrayImage {
  const image = blankPage(width, height);
  const block = textBlockFor(width, height);
  const lineHeight = 14;
  for (let y = block.top; y < block.bottom; y += lineHeight) {
    let x = block.left;
    while (x < block.right) {
      const wordWidth = Math.min(12 + ((x * 7 + y * 3) % 20), block.right - x);
      paintRotatedRect(image, x + wordWidth / 2, y, wordWidth, 6, angleDeg);
      x += wordWidth + 6;
    }
  }
  return image;
}

/** A tategaki page: columns of glyph-sized blocks running top to bottom. */
export function verticalTextPage(angleDeg: number, width = 480, height = 640): GrayImage {
  const image = blankPage(width, height);
  const columnPitch = 16;
  for (let x = 70; x < width - 70; x += columnPitch) {
    let y = 70;
    while (y < height - 70) {
      const glyphHeight = 8 + ((x * 5 + y * 2) % 6);
      paintRotatedRect(image, x, y + glyphHeight / 2, 7, glyphHeight, angleDeg);
      y += glyphHeight + 3;
    }
  }
  return image;
}

/** Expand a grayscale page into the RGBA layout a canvas read-back returns. */
function grayToRgba(image: GrayImage): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(image.width * image.height * 4);
  for (let index = 0; index < image.width * image.height; index += 1) {
    const value = image.data[index]!;
    rgba[index * 4] = value;
    rgba[index * 4 + 1] = value;
    rgba[index * 4 + 2] = value;
    rgba[index * 4 + 3] = 255;
  }
  return rgba;
}

/**
 * A scratch surface whose read-back paints `draw(width, height)` — the page
 * image the "render" is supposed to have produced at the requested size.
 */
export function fakeSurface(
  draw: (width: number, height: number) => GrayImage,
): PageSampleSurface & { reads: number } {
  const surface = {
    reads: 0,
    canvas: { width: 0, height: 0 },
    context: {
      getImageData: (_x: number, _y: number, width: number, height: number) => {
        surface.reads += 1;
        return { data: grayToRgba(draw(width, height)) };
      },
    },
  };
  return surface;
}

/** A pdf.js page stand-in with a base size, counting render calls. */
export function fakePage(
  baseWidth: number,
  baseHeight: number,
  onRender?: (viewport: PageViewportLike) => Promise<unknown>,
): PdfPageLike & { renders: PageViewportLike[] } {
  const page = {
    renders: [] as PageViewportLike[],
    getViewport: ({ scale }: { scale: number }) => ({
      width: baseWidth * scale,
      height: baseHeight * scale,
    }),
    render: ({ viewport }: { viewport: PageViewportLike }) => {
      page.renders.push(viewport);
      return { promise: onRender ? onRender(viewport) : Promise.resolve() };
    },
  };
  return page;
}
