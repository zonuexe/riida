import { describe, expect, it } from "vitest";
import { detectSkewAngle } from "./pdf-deskew";
import { blankPage, horizontalTextPage, paint, verticalTextPage } from "./pdf-page-fixtures";

// The sweep refines in 0.05° steps, but on a 640 px sample a step shifts the
// projection by well under a pixel, so the practical precision is ~0.1°.
const ANGLE_TOLERANCE = 0.12;

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
