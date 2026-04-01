import { describe, expect, it } from "vitest";
import { buildPdfRenderWindowPlan } from "./pdf-render-window-utils";

describe("buildPdfRenderWindowPlan", () => {
  it("builds a symmetric render order around the active group", () => {
    expect(buildPdfRenderWindowPlan(10, 5, 2, 3)).toEqual({
      activeGroupIndex: 5,
      renderMin: 3,
      renderMax: 7,
      keepMin: 2,
      keepMax: 8,
      renderOrder: [5, 4, 6, 3, 7],
    });
  });

  it("clamps render and keep ranges at the start", () => {
    expect(buildPdfRenderWindowPlan(6, 0, 2, 3)).toEqual({
      activeGroupIndex: 0,
      renderMin: 0,
      renderMax: 2,
      keepMin: 0,
      keepMax: 3,
      renderOrder: [0, 1, 2],
    });
  });

  it("clamps render and keep ranges at the end", () => {
    expect(buildPdfRenderWindowPlan(6, 5, 2, 3)).toEqual({
      activeGroupIndex: 5,
      renderMin: 3,
      renderMax: 5,
      keepMin: 2,
      keepMax: 5,
      renderOrder: [5, 4, 3],
    });
  });
});
