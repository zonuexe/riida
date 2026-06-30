import { describe, expect, it } from "vitest";
import { convertPdfRectToViewport } from "./pdf-rect-utils";

describe("convertPdfRectToViewport", () => {
  it("returns the rect unchanged under the identity transform", () => {
    expect(convertPdfRectToViewport([10, 20, 30, 40], [1, 0, 0, 1, 0, 0])).toEqual([
      10, 20, 30, 40,
    ]);
  });

  it("flips the y axis like the default scale-1 viewport transform", () => {
    // pdfjs viewport transform at scale 1 for a 792-tall page: [1, 0, 0, -1, 0, 792].
    expect(convertPdfRectToViewport([0, 0, 100, 200], [1, 0, 0, -1, 0, 792])).toEqual([
      0, 792, 100, 592,
    ]);
  });

  it("applies scale and translation", () => {
    expect(convertPdfRectToViewport([1, 1, 2, 3], [2, 0, 0, 2, 5, 7])).toEqual([7, 9, 9, 13]);
  });

  it("defaults missing matrix/rect entries safely", () => {
    expect(convertPdfRectToViewport([], [])).toEqual([0, 0, 0, 0]);
  });
});
