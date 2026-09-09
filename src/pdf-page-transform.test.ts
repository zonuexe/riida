import { describe, expect, it } from "vitest";
import {
  applyPdfPageOverlayTransform,
  canvasRenderScale,
  deskewTransformForAngle,
  mapRectThroughMatrix,
  matrixToCss,
  pageContentTransform,
  type Matrix6,
} from "./pdf-page-transform";

const DEG_TO_RAD = Math.PI / 180;

const apply = (matrix: readonly number[], x: number, y: number): { x: number; y: number } => ({
  x: matrix[0]! * x + matrix[2]! * y + matrix[4]!,
  y: matrix[1]! * x + matrix[3]! * y + matrix[5]!,
});

const invert = (matrix: Matrix6) => {
  const [a, b, c, d, e, f] = matrix;
  const determinant = a * d - b * c;
  return (x: number, y: number) => ({
    x: (d * (x - e) - c * (y - f)) / determinant,
    y: (-b * (x - e) + a * (y - f)) / determinant,
  });
};

describe("canvasRenderScale", () => {
  it("scales a page to the requested canvas height", () => {
    expect(586 * canvasRenderScale(586, 2160)).toBeCloseTo(2160, 6);
  });

  it("costs the same for every paper size, which is the point", () => {
    // A4-ish and B4-ish pages, both drawn to the same height on screen.
    const a4 = 842 * canvasRenderScale(842, 2160);
    const b4 = 1030 * canvasRenderScale(1030, 2160);
    expect(a4).toBeCloseTo(b4, 6);
  });

  it("never exceeds the fixed scale it replaces, so no page is drawn larger", () => {
    // A bunko page would ask for 5.1x; the ceiling is what makes this a saving.
    expect(canvasRenderScale(420, 2160)).toBe(4);
    expect(canvasRenderScale(420, 2160, { max: 2 })).toBe(2);
  });

  it("clamps a page that would be drawn too soft", () => {
    expect(canvasRenderScale(100000, 2160)).toBe(0.25);
    expect(canvasRenderScale(100000, 2160, { min: 0.5 })).toBe(0.5);
  });

  it("tolerates degenerate inputs rather than dividing by zero", () => {
    expect(canvasRenderScale(0, 0)).toBe(1);
    expect(Number.isFinite(canvasRenderScale(-10, -10))).toBe(true);
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

describe("pageContentTransform", () => {
  it("reduces to the output-scale matrix with no corrections", () => {
    expect(
      pageContentTransform({ width: 400, height: 600, outputScale: 2, angleDeg: null, crop: null }),
    ).toEqual({ canvas: [2, 0, 0, 2, 0, 0], overlay: null, contentWidth: 400, contentHeight: 600 });
    expect(
      pageContentTransform({ width: 400, height: 600, outputScale: 1, angleDeg: 0, crop: null }),
    ).toEqual({ canvas: undefined, overlay: null, contentWidth: 400, contentHeight: 600 });
  });

  describe("deskew only", () => {
    it("keeps the canvas centre fixed", () => {
      const { canvas } = pageContentTransform({
        width: 400,
        height: 600,
        outputScale: 2,
        angleDeg: 1.5,
        crop: null,
      });
      const centre = apply(canvas!, 200, 300);
      expect(centre.x).toBeCloseTo(400, 6);
      expect(centre.y).toBeCloseTo(600, 6);
    });

    it("rotates a point on the tilted baseline back to level", () => {
      // A line through the centre that runs downhill to the right by 1° should,
      // after correction, map both of its ends to the same device row.
      const angle = 1;
      const { canvas, overlay } = pageContentTransform({
        width: 400,
        height: 600,
        outputScale: 1,
        angleDeg: angle,
        crop: null,
      });
      const run = 150;
      const rise = run * Math.tan(angle * DEG_TO_RAD);
      const left = apply(canvas!, 200 - run, 300 - rise);
      const right = apply(canvas!, 200 + run, 300 + rise);
      expect(left.y).toBeCloseTo(right.y, 6);
      expect(right.x).toBeGreaterThan(left.x);
      // With outputScale 1 the overlay map is the canvas map.
      expect(overlay).toEqual(canvas);
    });

    it("covers every corner of the device canvas", () => {
      const width = 400;
      const height = 600;
      const outputScale = 2;
      const { canvas } = pageContentTransform({
        width,
        height,
        outputScale,
        angleDeg: -2.5,
        crop: null,
      });
      // Every device-canvas corner must come from inside the page rectangle
      // so no unpainted background is visible.
      const source = invert(canvas!);
      for (const [x, y] of [
        [0, 0],
        [width * outputScale, 0],
        [0, height * outputScale],
        [width * outputScale, height * outputScale],
      ] as const) {
        const point = source(x, y);
        expect(point.x).toBeGreaterThanOrEqual(-1e-6);
        expect(point.x).toBeLessThanOrEqual(width + 1e-6);
        expect(point.y).toBeGreaterThanOrEqual(-1e-6);
        expect(point.y).toBeLessThanOrEqual(height + 1e-6);
      }
    });

    it("scales the overlay by the same cover factor as the canvas", () => {
      const { canvas, overlay } = pageContentTransform({
        width: 400,
        height: 600,
        outputScale: 2,
        angleDeg: 1,
        crop: null,
      });
      expect(overlay![0]! * 2).toBeCloseTo(canvas![0]!, 9);
      expect(overlay![4]! * 2).toBeCloseTo(canvas![4]!, 9);
    });
  });

  describe("crop only", () => {
    it("moves the crop's corner to the origin and reports the trimmed size", () => {
      const result = pageContentTransform({
        width: 400,
        height: 600,
        outputScale: 2,
        angleDeg: null,
        crop: { x: 40, y: 60, width: 300, height: 480 },
      });
      expect(result.contentWidth).toBe(300);
      expect(result.contentHeight).toBe(480);
      expect(result.canvas).toEqual([2, 0, 0, 2, -80, -120]);
      expect(result.overlay).toEqual([1, 0, 0, 1, -40, -60]);
      const corner = apply(result.canvas!, 40, 60);
      expect(corner).toEqual({ x: 0, y: 0 });
      const far = apply(result.canvas!, 340, 540);
      expect(far).toEqual({ x: 600, y: 960 });
    });
  });

  describe("crop and deskew together", () => {
    it("rotates about the page centre without the cover scale", () => {
      const width = 400;
      const height = 600;
      const crop = { x: 40, y: 60, width: 300, height: 480 };
      const { canvas, overlay } = pageContentTransform({
        width,
        height,
        outputScale: 1,
        angleDeg: 2,
        crop,
      });
      // The page centre is a fixed point of the rotation, so it lands at the
      // centre minus the crop offset.
      const centre = apply(canvas!, width / 2, height / 2);
      expect(centre.x).toBeCloseTo(width / 2 - crop.x, 6);
      expect(centre.y).toBeCloseTo(height / 2 - crop.y, 6);
      // No enlargement: the linear part is a pure rotation.
      expect(Math.hypot(canvas![0]!, canvas![1]!)).toBeCloseTo(1, 9);
      expect(overlay).toEqual(canvas);
    });
  });
});

describe("matrixToCss", () => {
  it("emits a CSS matrix() with trimmed precision", () => {
    expect(matrixToCss([1, 0, 0, 1, -40.123456789, 60])).toBe("matrix(1, 0, 0, 1, -40.123457, 60)");
  });
});

describe("applyPdfPageOverlayTransform", () => {
  function fakeElement() {
    const properties = new Map<string, string>();
    return {
      element: {
        dataset: {} as { contentTransform?: string },
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

  it("marks the page and publishes the overlay map", () => {
    const { element, properties } = fakeElement();
    applyPdfPageOverlayTransform(element, [1, 0, 0, 1, -40, -60]);
    expect(element.dataset.contentTransform).toBe("true");
    expect(properties.get("--pdf-overlay-transform")).toBe("matrix(1, 0, 0, 1, -40, -60)");
  });

  it("clears the mark and property when there is nothing to apply", () => {
    const { element, properties } = fakeElement();
    applyPdfPageOverlayTransform(element, [1, 0, 0, 1, -40, -60]);
    applyPdfPageOverlayTransform(element, null);
    expect(element.dataset.contentTransform).toBeUndefined();
    expect(properties.has("--pdf-overlay-transform")).toBe(false);
  });
});

describe("mapRectThroughMatrix", () => {
  it("translates a rectangle", () => {
    expect(
      mapRectThroughMatrix([1, 0, 0, 1, -40, -60], { left: 100, top: 100, width: 50, height: 20 }),
    ).toEqual({ left: 60, top: 40, width: 50, height: 20 });
  });

  it("returns the bounds of a rotated rectangle", () => {
    const radians = 90 * DEG_TO_RAD;
    const rotate: Matrix6 = [
      Math.cos(radians),
      Math.sin(radians),
      -Math.sin(radians),
      Math.cos(radians),
      0,
      0,
    ];
    const mapped = mapRectThroughMatrix(rotate, { left: 0, top: 0, width: 50, height: 20 });
    expect(mapped.left).toBeCloseTo(-20, 9);
    expect(mapped.top).toBeCloseTo(0, 9);
    expect(mapped.width).toBeCloseTo(20, 9);
    expect(mapped.height).toBeCloseTo(50, 9);
  });
});
