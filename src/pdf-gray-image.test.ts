import { describe, expect, it } from "vitest";
import { luminanceHistogram, otsuThreshold, rgbaToGray } from "./pdf-gray-image";

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

  it("accepts a plain array with gaps", () => {
    const histogram: number[] = [];
    histogram[10] = 100;
    histogram[240] = 100;
    const threshold = otsuThreshold(histogram);
    expect(threshold).toBeGreaterThanOrEqual(10);
    expect(threshold).toBeLessThan(240);
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

  it("treats missing samples as black", () => {
    const gray = rgbaToGray(new Uint8Array([200, 200, 200, 255]), 2);
    expect(gray[0]).toBeGreaterThan(190);
    expect(gray[1]).toBe(0);
  });
});

describe("luminanceHistogram", () => {
  it("counts only the requested rectangle", () => {
    const width = 4;
    const height = 4;
    const data = new Uint8Array(width * height).fill(255);
    data[0] = 0; // outside the rectangle
    data[1 * width + 1] = 10;
    data[2 * width + 2] = 10;
    const histogram = luminanceHistogram({ width, height, data }, 1, 1, 3, 3);
    expect(histogram[10]).toBe(2);
    expect(histogram[0]).toBe(0);
    expect(histogram[255]).toBe(2);
  });
});
