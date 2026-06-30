import { describe, expect, it } from "vitest";
import {
  buildImageSpreads,
  computeImageFit,
  firstPageNumberOfSpread,
  type ImagePage,
  normalizeImagePages,
  spreadIndexForPage,
  visualSpreadOrder,
} from "./epub-image-layout-utils";

function page(index: number, spreadSide: ImagePage["spreadSide"]): ImagePage {
  return {
    index,
    imageEntry: `item/image/img${index}.jpg`,
    spreadSide,
    width: 1396,
    height: 1980,
  };
}

// Mirrors the sample EPUB: cover (center), then alternating right/left content.
function samplePages(): ImagePage[] {
  return [
    page(0, "center"),
    page(1, "right"),
    page(2, "left"),
    page(3, "right"),
    page(4, "left"),
    page(5, "right"),
  ];
}

describe("normalizeImagePages", () => {
  it("maps the raw command payload and coerces unknown sides to empty", () => {
    expect(
      normalizeImagePages([
        { index: 0, image_entry: "a.jpg", spread_side: "center", width: 1, height: 2 },
        { index: 1, image_entry: null, spread_side: "weird", width: 0, height: 0 },
      ]),
    ).toEqual([
      { index: 0, imageEntry: "a.jpg", spreadSide: "center", width: 1, height: 2 },
      { index: 1, imageEntry: null, spreadSide: "", width: 0, height: 0 },
    ]);
  });
});

describe("buildImageSpreads", () => {
  it("puts every page on its own spread in single mode", () => {
    const spreads = buildImageSpreads(samplePages(), "ltr", "single");
    expect(spreads.map((s) => s.pages.map((p) => p.index))).toEqual([[0], [1], [2], [3], [4], [5]]);
  });

  it("keeps the cover alone and pairs left+right for ltr", () => {
    const spreads = buildImageSpreads(samplePages(), "ltr", "spread");
    expect(spreads.map((s) => s.pages.map((p) => p.index))).toEqual([
      [0], // center cover
      [1], // lone recto (right with blank facing)
      [2, 3], // left + right
      [4, 5], // left + right
    ]);
  });

  it("opens spreads on the right and pairs with the following left for rtl", () => {
    const pages = [
      page(0, "center"),
      page(1, "left"),
      page(2, "right"),
      page(3, "left"),
      page(4, "right"),
      page(5, "left"),
    ];
    const spreads = buildImageSpreads(pages, "rtl", "spread");
    expect(spreads.map((s) => s.pages.map((p) => p.index))).toEqual([[0], [1], [2, 3], [4, 5]]);
  });

  it("alternates from progression when sides are missing", () => {
    const pages = [page(0, "center"), page(1, ""), page(2, ""), page(3, ""), page(4, "")];
    const spreads = buildImageSpreads(pages, "ltr", "spread");
    expect(spreads.map((s) => s.pages.map((p) => p.index))).toEqual([[0], [1, 2], [3, 4]]);
  });

  it("falls back to first-as-cover sequential pairing with no metadata", () => {
    const pages = [page(0, ""), page(1, ""), page(2, ""), page(3, ""), page(4, "")];
    const spreads = buildImageSpreads(pages, "ltr", "spread");
    expect(spreads.map((s) => s.pages.map((p) => p.index))).toEqual([[0], [1, 2], [3, 4]]);
  });

  it("flushes a trailing lone left page", () => {
    const pages = [page(1, "left"), page(2, "right"), page(3, "left")];
    const spreads = buildImageSpreads(pages, "ltr", "spread");
    expect(spreads.map((s) => s.pages.map((p) => p.index))).toEqual([[1, 2], [3]]);
  });
});

describe("visualSpreadOrder", () => {
  it("keeps spine order for ltr", () => {
    const spread = { pages: [page(2, "left"), page(3, "right")] };
    expect(visualSpreadOrder(spread, "ltr").map((p) => p.index)).toEqual([2, 3]);
  });

  it("reverses the pair for rtl", () => {
    const spread = { pages: [page(2, "right"), page(3, "left")] };
    expect(visualSpreadOrder(spread, "rtl").map((p) => p.index)).toEqual([3, 2]);
  });

  it("leaves single-page spreads untouched", () => {
    const spread = { pages: [page(0, "center")] };
    expect(visualSpreadOrder(spread, "rtl").map((p) => p.index)).toEqual([0]);
  });
});

describe("spreadIndexForPage / firstPageNumberOfSpread", () => {
  it("finds the spread containing a page index", () => {
    const spreads = buildImageSpreads(samplePages(), "ltr", "spread");
    expect(spreadIndexForPage(spreads, 3)).toBe(2);
    expect(spreadIndexForPage(spreads, 0)).toBe(0);
    expect(spreadIndexForPage(spreads, 999)).toBe(0);
  });

  it("returns the 1-based number of a spread's earliest page", () => {
    expect(firstPageNumberOfSpread({ pages: [page(2, "left"), page(3, "right")] })).toBe(3);
    expect(firstPageNumberOfSpread({ pages: [] })).toBe(1);
  });
});

describe("computeImageFit", () => {
  it("contains a single page within the stage height", () => {
    const box = computeImageFit(
      { width: 2000, height: 1000 },
      [{ width: 1396, height: 1980 }],
      0,
    )[0]!;
    expect(box.heightPx).toBe(1000);
    expect(box.widthPx).toBeCloseTo((1000 * 1396) / 1980, 5);
  });

  it("shrinks a two-page spread so the combined width fits", () => {
    // Two 1:1 images side by side in a 1000x1000 stage with no gap: each must
    // be 500 wide, so height is constrained to 500 (not the 1000 stage height).
    const boxes = computeImageFit(
      { width: 1000, height: 1000 },
      [
        { width: 100, height: 100 },
        { width: 100, height: 100 },
      ],
      0,
    );
    expect(boxes).toHaveLength(2);
    expect(boxes[0]!.heightPx).toBeCloseTo(500, 5);
    expect(boxes[0]!.widthPx).toBeCloseTo(500, 5);
  });

  it("accounts for the gap between pages", () => {
    const boxes = computeImageFit(
      { width: 1020, height: 1000 },
      [
        { width: 100, height: 100 },
        { width: 100, height: 100 },
      ],
      20,
    );
    // Available width for images = 1020 - 20 = 1000 -> 500 each.
    expect(boxes[0]!.widthPx).toBeCloseTo(500, 5);
  });

  it("returns zero boxes when dimensions are unknown", () => {
    expect(computeImageFit({ width: 1000, height: 1000 }, [{ width: 0, height: 0 }], 0)).toEqual([
      { widthPx: 0, heightPx: 0 },
    ]);
    expect(computeImageFit({ width: 0, height: 0 }, [{ width: 10, height: 10 }], 0)).toEqual([
      { widthPx: 0, heightPx: 0 },
    ]);
  });
});
