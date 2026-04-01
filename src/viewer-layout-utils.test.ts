import { describe, expect, it } from "vitest";
import { buildPageGroups, getVisualPageOrder } from "./viewer-layout-utils";

describe("buildPageGroups", () => {
  it("builds single-page groups in single-page mode", () => {
    expect(
      buildPageGroups(3, {
        pageMode: "single",
        bindingDirection: "left",
        treatFirstPageAsCover: true,
      }),
    ).toEqual([[1], [2], [3]]);
  });

  it("treats the first page as a cover in spread mode when enabled", () => {
    expect(
      buildPageGroups(5, {
        pageMode: "spread",
        bindingDirection: "left",
        treatFirstPageAsCover: true,
      }),
    ).toEqual([[1], [2, 3], [4, 5]]);
  });

  it("groups pages from the start when cover mode is disabled", () => {
    expect(
      buildPageGroups(5, {
        pageMode: "spread",
        bindingDirection: "left",
        treatFirstPageAsCover: false,
      }),
    ).toEqual([[1, 2], [3, 4], [5]]);
  });
});

describe("getVisualPageOrder", () => {
  it("keeps left-bound spreads in document order", () => {
    expect(
      getVisualPageOrder([2, 3], {
        pageMode: "spread",
        bindingDirection: "left",
        treatFirstPageAsCover: true,
      }),
    ).toEqual([2, 3]);
  });

  it("reverses right-bound spreads", () => {
    expect(
      getVisualPageOrder([2, 3], {
        pageMode: "spread",
        bindingDirection: "right",
        treatFirstPageAsCover: true,
      }),
    ).toEqual([3, 2]);
  });

  it("does not reverse single-page groups", () => {
    expect(
      getVisualPageOrder([5], {
        pageMode: "single",
        bindingDirection: "right",
        treatFirstPageAsCover: false,
      }),
    ).toEqual([5]);
  });
});
