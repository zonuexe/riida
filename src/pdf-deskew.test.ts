import { describe, expect, it } from "vitest";
import {
  DESKEW_SAMPLE_LONG_EDGE,
  PdfDeskewCache,
  PdfDeskewMeasurer,
  applyPdfPageDeskewStyle,
  deskewCanvasTransform,
  deskewSampleSize,
  deskewTransformForAngle,
  detectSkewAngle,
  measurePdfPageSkew,
  otsuThreshold,
  rgbaToGray,
  type DeskewPageLike,
  type DeskewViewportLike,
  type GrayImage,
} from "./pdf-deskew";

const DEG_TO_RAD = Math.PI / 180;
// The sweep refines in 0.05° steps, but on a 640 px sample a step shifts the
// projection by well under a pixel, so the practical precision is ~0.1°.
const ANGLE_TOLERANCE = 0.12;

function blankPage(width: number, height: number, paper = 235): GrayImage {
  return { width, height, data: new Uint8Array(width * height).fill(paper) };
}

function paint(image: GrayImage, x: number, y: number, value = 20): void {
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || py < 0 || px >= image.width || py >= image.height) {
    return;
  }
  image.data[py * image.width + px] = value;
}

// Fill a rectangle rotated about the page centre by `angleDeg` (clockwise on
// screen, matching DeskewResult.angleDeg): `centerX/centerY` are the
// rectangle's centre before rotation.
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

// A page of horizontal "text": rows of short word-like dashes, tilted as a whole.
function horizontalTextPage(angleDeg: number, width = 480, height = 640): GrayImage {
  const image = blankPage(width, height);
  const lineHeight = 14;
  for (let y = 80; y < height - 80; y += lineHeight) {
    let x = 60;
    while (x < width - 60) {
      const wordWidth = 12 + ((x * 7 + y * 3) % 20);
      paintRotatedRect(image, x + wordWidth / 2, y, wordWidth, 6, angleDeg);
      x += wordWidth + 6;
    }
  }
  return image;
}

// A tategaki page: columns of glyph-sized blocks running top to bottom.
function verticalTextPage(angleDeg: number, width = 480, height = 640): GrayImage {
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

describe("otsuThreshold", () => {
  it("splits a bimodal histogram between its modes", () => {
    const histogram = new Uint32Array(256);
    histogram[30] = 1000;
    histogram[220] = 4000;
    const threshold = otsuThreshold(histogram);
    expect(threshold).toBeGreaterThanOrEqual(30);
    expect(threshold).toBeLessThan(220);
  });

  it("falls back to mid-grey for an empty histogram", () => {
    expect(otsuThreshold(new Uint32Array(256))).toBe(127);
  });

  it("keeps a single-level histogram from dividing by zero", () => {
    const histogram = new Uint32Array(256);
    histogram[200] = 500;
    expect(otsuThreshold(histogram)).toBe(127);
  });
});

describe("rgbaToGray", () => {
  it("weights channels like Rec. 601 luma and ignores alpha", () => {
    const rgba = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 0, 255, 0, 0, 255]);
    const gray = rgbaToGray(rgba, 3);
    expect(gray[0]).toBe(255);
    expect(gray[1]).toBe(0);
    expect(gray[2]).toBe((255 * 77) >> 8);
  });
});

describe("detectSkewAngle", () => {
  it.each([0.8, -1.2, 2.1, -0.4])("measures horizontal text tilted by %s°", (angle) => {
    const result = detectSkewAngle(horizontalTextPage(angle));
    expect(result).not.toBeNull();
    expect(result!.orientation).toBe("rows");
    expect(Math.abs(result!.angleDeg - angle)).toBeLessThanOrEqual(ANGLE_TOLERANCE);
    expect(result!.confidence).toBeGreaterThan(1.12);
  });

  it.each([0.6, -1.5])("measures vertical text columns tilted by %s°", (angle) => {
    const result = detectSkewAngle(verticalTextPage(angle));
    expect(result).not.toBeNull();
    expect(result!.orientation).toBe("columns");
    expect(Math.abs(result!.angleDeg - angle)).toBeLessThanOrEqual(ANGLE_TOLERANCE);
  });

  it("reports a level page as null", () => {
    expect(detectSkewAngle(horizontalTextPage(0))).toBeNull();
  });

  it("still returns the measured angle when the level threshold is disabled", () => {
    const result = detectSkewAngle(horizontalTextPage(0), { minAngleDeg: 0, minConfidence: 0 });
    expect(result).not.toBeNull();
    expect(Math.abs(result!.angleDeg)).toBeLessThanOrEqual(0.05);
  });

  it("returns null for a blank page", () => {
    expect(detectSkewAngle(blankPage(480, 640))).toBeNull();
  });

  it("returns null for a page that is mostly ink", () => {
    const image = blankPage(480, 640, 20);
    for (let index = 0; index < image.data.length; index += 3) {
      image.data[index] = 240;
    }
    expect(detectSkewAngle(image)).toBeNull();
  });

  it("returns null for structureless noise", () => {
    const image = blankPage(480, 640);
    let seed = 12345;
    for (let index = 0; index < image.data.length; index += 1) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      if (seed % 17 === 0) {
        image.data[index] = 20;
      }
    }
    expect(detectSkewAngle(image)).toBeNull();
  });

  it("returns null when the best candidate sits on the sweep boundary", () => {
    // Tilted past the search range, the sweep peaks at the edge and must not
    // pretend that edge is the answer.
    expect(detectSkewAngle(horizontalTextPage(4.5))).toBeNull();
  });

  it("ignores ink inside the margin band", () => {
    const image = horizontalTextPage(0.9);
    // A scanner shadow: a solid vertical bar hugging the left edge.
    for (let y = 0; y < image.height; y += 1) {
      for (let x = 0; x < 12; x += 1) {
        paint(image, x, y, 0);
      }
    }
    const result = detectSkewAngle(image);
    expect(result).not.toBeNull();
    expect(Math.abs(result!.angleDeg - 0.9)).toBeLessThanOrEqual(ANGLE_TOLERANCE);
  });

  it("rejects images too small to crop", () => {
    expect(detectSkewAngle(blankPage(4, 4))).toBeNull();
    expect(detectSkewAngle({ width: 100, height: 100, data: new Uint8Array(10) })).toBeNull();
  });
});

describe("deskewTransformForAngle", () => {
  it("is the identity for a level page", () => {
    expect(deskewTransformForAngle(0, 400, 600)).toEqual({ rotateDeg: 0, scale: 1 });
  });

  it("counter-rotates and scales just enough to cover the frame", () => {
    const { rotateDeg, scale } = deskewTransformForAngle(1, 400, 600);
    expect(rotateDeg).toBe(-1);
    const expected = Math.cos(1 * DEG_TO_RAD) + (600 / 400) * Math.sin(1 * DEG_TO_RAD);
    expect(scale).toBeCloseTo(expected, 4);
    expect(scale).toBeGreaterThan(1);
  });

  it("uses the same cover scale for either tilt direction", () => {
    expect(deskewTransformForAngle(-1.3, 400, 600).scale).toBe(
      deskewTransformForAngle(1.3, 400, 600).scale,
    );
    expect(deskewTransformForAngle(-1.3, 400, 600).rotateDeg).toBe(1.3);
  });

  it("treats the aspect ratio symmetrically for landscape frames", () => {
    expect(deskewTransformForAngle(1, 600, 400).scale).toBe(
      deskewTransformForAngle(1, 400, 600).scale,
    );
  });
});

describe("deskewCanvasTransform", () => {
  const apply = (matrix: readonly number[], x: number, y: number): { x: number; y: number } => ({
    x: matrix[0]! * x + matrix[2]! * y + matrix[4]!,
    y: matrix[1]! * x + matrix[3]! * y + matrix[5]!,
  });

  it("reduces to the output-scale matrix when the page is level", () => {
    expect(deskewCanvasTransform(0, 400, 600, 2)).toEqual([2, 0, 0, 2, 0, 0]);
  });

  it("keeps the canvas centre fixed", () => {
    const matrix = deskewCanvasTransform(1.5, 400, 600, 2);
    const centre = apply(matrix, 200, 300);
    expect(centre.x).toBeCloseTo(400, 6);
    expect(centre.y).toBeCloseTo(600, 6);
  });

  it("rotates a point on the tilted baseline back to level", () => {
    // A line through the centre that runs downhill to the right by 1° should,
    // after correction, map both of its ends to the same device row.
    const angle = 1;
    const matrix = deskewCanvasTransform(angle, 400, 600, 1);
    const run = 150;
    const rise = run * Math.tan(angle * DEG_TO_RAD);
    const left = apply(matrix, 200 - run, 300 - rise);
    const right = apply(matrix, 200 + run, 300 + rise);
    expect(left.y).toBeCloseTo(right.y, 6);
    expect(right.x).toBeGreaterThan(left.x);
  });

  it("covers every corner of the device canvas", () => {
    const width = 400;
    const height = 600;
    const outputScale = 2;
    const matrix = deskewCanvasTransform(-2.5, width, height, outputScale);
    // Invert the affine map: every device-canvas corner must land inside the
    // CSS-pixel page rectangle so no unpainted background is visible.
    const [a, b, c, d, e, f] = matrix;
    const determinant = a * d - b * c;
    const invert = (x: number, y: number) => ({
      x: (d * (x - e) - c * (y - f)) / determinant,
      y: (-b * (x - e) + a * (y - f)) / determinant,
    });
    for (const [x, y] of [
      [0, 0],
      [width * outputScale, 0],
      [0, height * outputScale],
      [width * outputScale, height * outputScale],
    ] as const) {
      const source = invert(x, y);
      expect(source.x).toBeGreaterThanOrEqual(-1e-6);
      expect(source.x).toBeLessThanOrEqual(width + 1e-6);
      expect(source.y).toBeGreaterThanOrEqual(-1e-6);
      expect(source.y).toBeLessThanOrEqual(height + 1e-6);
    }
  });
});

describe("deskewSampleSize", () => {
  it("shrinks the longer edge to the sample size and keeps the aspect ratio", () => {
    expect(deskewSampleSize(1200, 1800)).toEqual({
      width: Math.round(1200 * (DESKEW_SAMPLE_LONG_EDGE / 1800)),
      height: DESKEW_SAMPLE_LONG_EDGE,
    });
    expect(deskewSampleSize(1800, 1200).width).toBe(DESKEW_SAMPLE_LONG_EDGE);
  });

  it("never enlarges a page that is already small", () => {
    expect(deskewSampleSize(300, 200)).toEqual({ width: 300, height: 200 });
  });

  it("tolerates degenerate dimensions", () => {
    expect(deskewSampleSize(0, 0)).toEqual({ width: 1, height: 1 });
  });
});

describe("measurePdfPageSkew", () => {
  function fakePage(angleDeg: number, baseWidth: number, baseHeight: number) {
    const renders: DeskewViewportLike[] = [];
    const surface = {
      canvas: { width: 0, height: 0 },
      context: {
        getImageData: (_x: number, _y: number, width: number, height: number) => {
          const gray = horizontalTextPage(angleDeg, width, height);
          const data = new Uint8ClampedArray(width * height * 4);
          for (let index = 0; index < width * height; index += 1) {
            const value = gray.data[index]!;
            data[index * 4] = value;
            data[index * 4 + 1] = value;
            data[index * 4 + 2] = value;
            data[index * 4 + 3] = 255;
          }
          return { data };
        },
      },
    };
    const page: DeskewPageLike = {
      getViewport: ({ scale }) => ({ width: baseWidth * scale, height: baseHeight * scale }),
      render: ({ viewport }) => {
        renders.push(viewport);
        return { promise: Promise.resolve() };
      },
    };
    return { page, surface, renders };
  }

  it("renders at sampling size and returns the measured tilt", async () => {
    const { page, surface, renders } = fakePage(0.75, 1200, 1600);
    const result = await measurePdfPageSkew(page, surface);
    expect(renders).toHaveLength(1);
    expect(renders[0]!.height).toBeCloseTo(DESKEW_SAMPLE_LONG_EDGE, 6);
    expect(surface.canvas.width).toBe(Math.ceil(renders[0]!.width));
    expect(surface.canvas.height).toBe(DESKEW_SAMPLE_LONG_EDGE);
    expect(result).not.toBeNull();
    expect(Math.abs(result!.angleDeg - 0.75)).toBeLessThanOrEqual(ANGLE_TOLERANCE);
  });

  it("returns null for a level page", async () => {
    const { page, surface } = fakePage(0, 1200, 1600);
    expect(await measurePdfPageSkew(page, surface)).toBeNull();
  });
});

describe("PdfDeskewCache", () => {
  it("distinguishes unmeasured pages from level ones", () => {
    const cache = new PdfDeskewCache();
    expect(cache.lookup("a.pdf", 1)).toBeUndefined();
    cache.store("a.pdf", 1, null);
    cache.store("a.pdf", 2, 0.6);
    expect(cache.lookup("a.pdf", 1)).toBeNull();
    expect(cache.lookup("a.pdf", 2)).toBe(0.6);
    expect(cache.lookup("a.pdf", 3)).toBeUndefined();
  });

  it("forgets the previous document when another file is stored", () => {
    const cache = new PdfDeskewCache();
    cache.store("a.pdf", 1, 0.5);
    expect(cache.lookup("b.pdf", 1)).toBeUndefined();
    cache.store("b.pdf", 1, -0.5);
    expect(cache.lookup("a.pdf", 1)).toBeUndefined();
    expect(cache.lookup("b.pdf", 1)).toBe(-0.5);
  });

  it("clears everything on demand", () => {
    const cache = new PdfDeskewCache();
    cache.store("a.pdf", 1, 0.5);
    cache.clear();
    expect(cache.lookup("a.pdf", 1)).toBeUndefined();
  });
});

describe("PdfDeskewMeasurer", () => {
  function fakeSurface(angleDeg: number) {
    return {
      canvas: { width: 0, height: 0 },
      context: {
        getImageData: (_x: number, _y: number, width: number, height: number) => {
          const gray = horizontalTextPage(angleDeg, width, height);
          const data = new Uint8ClampedArray(width * height * 4);
          for (let index = 0; index < width * height; index += 1) {
            data[index * 4] = gray.data[index]!;
            data[index * 4 + 1] = gray.data[index]!;
            data[index * 4 + 2] = gray.data[index]!;
            data[index * 4 + 3] = 255;
          }
          return { data };
        },
      },
    };
  }

  function countingPage(): { page: DeskewPageLike; renders: () => number } {
    let renders = 0;
    return {
      page: {
        getViewport: ({ scale }) => ({ width: 1000 * scale, height: 1400 * scale }),
        render: () => {
          renders += 1;
          return { promise: Promise.resolve() };
        },
      },
      renders: () => renders,
    };
  }

  it("measures once per page and serves repeats from the cache", async () => {
    let surfaces = 0;
    const measurer = new PdfDeskewMeasurer(() => {
      surfaces += 1;
      return fakeSurface(0.8);
    });
    const { page, renders } = countingPage();

    const first = await measurer.angleFor(page, "scan.pdf", 3);
    const second = await measurer.angleFor(page, "scan.pdf", 3);
    expect(first).not.toBeNull();
    expect(Math.abs(first! - 0.8)).toBeLessThanOrEqual(ANGLE_TOLERANCE);
    expect(second).toBe(first);
    expect(renders()).toBe(1);
    expect(surfaces).toBe(1);
  });

  it("reports level pages as null without measuring twice", async () => {
    const measurer = new PdfDeskewMeasurer(() => fakeSurface(0));
    const { page, renders } = countingPage();
    expect(await measurer.angleFor(page, "scan.pdf", 1)).toBeNull();
    expect(await measurer.angleFor(page, "scan.pdf", 1)).toBeNull();
    expect(renders()).toBe(1);
  });

  it("treats a missing surface as level and never renders", async () => {
    const measurer = new PdfDeskewMeasurer(() => null);
    const { page, renders } = countingPage();
    expect(await measurer.angleFor(page, "scan.pdf", 1)).toBeNull();
    expect(renders()).toBe(0);
  });

  it("swallows a failing render and remembers the page as level", async () => {
    const measurer = new PdfDeskewMeasurer(() => fakeSurface(1));
    let renders = 0;
    const page: DeskewPageLike = {
      getViewport: ({ scale }) => ({ width: 1000 * scale, height: 1400 * scale }),
      render: () => {
        renders += 1;
        return { promise: Promise.reject(new Error("render failed")) };
      },
    };
    expect(await measurer.angleFor(page, "scan.pdf", 1)).toBeNull();
    expect(await measurer.angleFor(page, "scan.pdf", 1)).toBeNull();
    expect(renders).toBe(1);
  });

  it("re-measures after forget()", async () => {
    const measurer = new PdfDeskewMeasurer(() => fakeSurface(0.8));
    const { page, renders } = countingPage();
    await measurer.angleFor(page, "scan.pdf", 1);
    measurer.forget();
    await measurer.angleFor(page, "scan.pdf", 1);
    expect(renders()).toBe(2);
  });
});

describe("applyPdfPageDeskewStyle", () => {
  function fakeElement() {
    const properties = new Map<string, string>();
    return {
      element: {
        dataset: {} as { deskew?: string },
        style: {
          setProperty: (name: string, value: string) => {
            properties.set(name, value);
          },
          removeProperty: (name: string) => {
            const previous = properties.get(name) ?? "";
            properties.delete(name);
            return previous;
          },
        },
      },
      properties,
    };
  }

  it("marks the page and publishes the overlay transform", () => {
    const { element, properties } = fakeElement();
    applyPdfPageDeskewStyle(element, 0.75, 400, 600);
    expect(element.dataset.deskew).toBe("true");
    expect(properties.get("--deskew-rotate")).toBe("-0.75deg");
    expect(properties.get("--deskew-scale")).toBe(
      String(deskewTransformForAngle(0.75, 400, 600).scale),
    );
  });

  it("clears the mark and properties for a level page", () => {
    const { element, properties } = fakeElement();
    applyPdfPageDeskewStyle(element, 0.75, 400, 600);
    applyPdfPageDeskewStyle(element, null, 400, 600);
    expect(element.dataset.deskew).toBeUndefined();
    expect(properties.has("--deskew-rotate")).toBe(false);
    expect(properties.has("--deskew-scale")).toBe(false);
  });
});
