import { describe, expect, it } from "vitest";
import { blankPage, horizontalTextPage, paint, textBlockFor } from "./pdf-page-fixtures";
import {
  FULL_PAGE_BOX,
  aggregateTrimBoxes,
  cropRectForPage,
  loadCachedPdfTrim,
  measureInkBox,
  parseCachedPdfTrim,
  pdfTrimStorageKey,
  rotateInkBox,
  saveCachedPdfTrim,
  trimBoxForPage,
  trimSamplePageNumbers,
  trimmedPageSize,
  type InkBox,
  type TrimSample,
} from "./pdf-trim";

const box = (left: number, top: number, right: number, bottom: number): InkBox => ({
  left,
  top,
  right,
  bottom,
});

describe("measureInkBox", () => {
  it("finds the printed block of a text page", () => {
    const width = 480;
    const height = 640;
    const block = textBlockFor(width, height);
    const result = measureInkBox(horizontalTextPage(0, width, height));
    expect(result).not.toBeNull();
    // Dashes are 6 px tall and centred on their line, so the ink starts a few
    // pixels above the first baseline; allow one line of slack at the bottom.
    expect(result!.left * width).toBeCloseTo(block.left, -1);
    expect(result!.top * height).toBeCloseTo(block.top - 3, -1);
    expect(result!.right * width).toBeGreaterThan(block.right - 30);
    expect(result!.right * width).toBeLessThanOrEqual(block.right + 1);
    expect(result!.bottom * height).toBeGreaterThan(block.bottom - 20);
    expect(result!.bottom * height).toBeLessThanOrEqual(block.bottom + 4);
  });

  it("returns null for a blank page", () => {
    expect(measureInkBox(blankPage(480, 640))).toBeNull();
  });

  it("returns null for an image too small to measure", () => {
    expect(measureInkBox(blankPage(4, 4))).toBeNull();
    expect(measureInkBox({ width: 100, height: 100, data: new Uint8Array(10) })).toBeNull();
  });

  it("ignores dust specks outside the print", () => {
    const image = horizontalTextPage(0);
    paint(image, 20, 20);
    paint(image, 460, 620);
    const clean = measureInkBox(horizontalTextPage(0));
    expect(measureInkBox(image)).toEqual(clean);
  });

  it("ignores a one-pixel scan line", () => {
    const image = horizontalTextPage(0);
    for (let x = 0; x < image.width; x += 1) {
      paint(image, x, 30);
    }
    const clean = measureInkBox(horizontalTextPage(0));
    expect(measureInkBox(image)).toEqual(clean);
  });

  it("ignores a scanner shadow hugging the edge", () => {
    const image = horizontalTextPage(0);
    for (let y = 0; y < image.height; y += 1) {
      for (let x = 0; x < 6; x += 1) {
        paint(image, x, y, 0);
      }
    }
    const clean = measureInkBox(horizontalTextPage(0));
    expect(measureInkBox(image)).toEqual(clean);
  });

  it("counts a lone folio number as print", () => {
    const image = horizontalTextPage(0);
    // A three-glyph page number well below the block.
    for (let glyph = 0; glyph < 3; glyph += 1) {
      for (let y = 600; y < 608; y += 1) {
        for (let x = 230 + glyph * 8; x < 235 + glyph * 8; x += 1) {
          paint(image, x, y);
        }
      }
    }
    const result = measureInkBox(image);
    expect(result!.bottom * image.height).toBeGreaterThanOrEqual(608);
  });
});

describe("rotateInkBox", () => {
  it("is the identity for a level page", () => {
    expect(rotateInkBox(box(0.1, 0.1, 0.9, 0.9), 0, 480, 640)).toEqual(box(0.1, 0.1, 0.9, 0.9));
  });

  it("grows the box by the rotation and keeps it centred", () => {
    const rotated = rotateInkBox(box(0.1, 0.1, 0.9, 0.9), 1.5, 480, 640);
    expect(rotated.left).toBeLessThan(0.1);
    expect(rotated.top).toBeLessThan(0.1);
    expect(rotated.right).toBeGreaterThan(0.9);
    expect(rotated.bottom).toBeGreaterThan(0.9);
    expect(rotated.left + rotated.right).toBeCloseTo(1, 9);
    expect(rotated.top + rotated.bottom).toBeCloseTo(1, 9);
  });

  it("gives the same bounds for either tilt direction and clamps to the page", () => {
    expect(rotateInkBox(box(0, 0, 1, 1), 2, 480, 640)).toEqual(
      rotateInkBox(box(0, 0, 1, 1), -2, 480, 640),
    );
    expect(rotateInkBox(box(0, 0, 1, 1), 2, 480, 640)).toEqual(FULL_PAGE_BOX);
  });
});

describe("aggregateTrimBoxes", () => {
  const samples = (count: number, make: (pageNumber: number) => InkBox): TrimSample[] =>
    Array.from({ length: count }, (_, index) => ({
      pageNumber: index + 1,
      box: make(index + 1),
    }));

  it("keeps mirrored gutters per parity and one height for both", () => {
    const boxes = aggregateTrimBoxes(
      samples(8, (page) =>
        page % 2 === 0 ? box(0.05, 0.08, 0.9, 0.94) : box(0.1, 0.07, 0.95, 0.93),
      ),
      { paddingRatio: 0 },
    );
    expect(boxes).not.toBeNull();
    expect(boxes!.even).toEqual(box(0.05, 0.07, 0.9, 0.94));
    expect(boxes!.odd).toEqual(box(0.1, 0.07, 0.95, 0.94));
  });

  it("pads the printed area and clamps to the page", () => {
    const boxes = aggregateTrimBoxes(
      samples(2, () => box(0.01, 0.1, 0.99, 0.9)),
      {
        paddingRatio: 0.02,
      },
    );
    expect(boxes!.odd).toEqual(box(0, 0.08, 1, 0.92));
  });

  it("drops one full-bleed outlier once there are enough samples", () => {
    const boxes = aggregateTrimBoxes(
      samples(16, (page) => (page === 3 ? box(0, 0, 1, 1) : box(0.1, 0.1, 0.9, 0.9))),
      { paddingRatio: 0 },
    );
    expect(boxes!.odd).toEqual(box(0.1, 0.1, 0.9, 0.9));
    expect(boxes!.even).toEqual(box(0.1, 0.1, 0.9, 0.9));
  });

  it("keeps every page's print when there are too few samples to drop any", () => {
    const boxes = aggregateTrimBoxes(
      samples(4, (page) => (page === 3 ? box(0, 0.1, 1, 0.9) : box(0.1, 0.1, 0.9, 0.9))),
      { paddingRatio: 0 },
    );
    expect(boxes!.odd).toEqual(box(0, 0.1, 1, 0.9));
    expect(boxes!.even).toEqual(box(0.1, 0.1, 0.9, 0.9));
  });

  it("returns null with fewer samples than required", () => {
    expect(aggregateTrimBoxes(samples(1, () => box(0.1, 0.1, 0.9, 0.9)))).toBeNull();
    expect(aggregateTrimBoxes([])).toBeNull();
  });

  it("falls back to the whole page for a degenerate box", () => {
    const boxes = aggregateTrimBoxes(
      samples(4, () => box(0.4, 0.1, 0.5, 0.9)),
      {
        paddingRatio: 0,
      },
    );
    expect(boxes!.odd).toEqual(FULL_PAGE_BOX);
  });

  it("uses every sample for a parity that has none of its own", () => {
    const boxes = aggregateTrimBoxes(
      [
        { pageNumber: 2, box: box(0.05, 0.1, 0.9, 0.9) },
        { pageNumber: 4, box: box(0.06, 0.1, 0.91, 0.9) },
      ],
      { paddingRatio: 0 },
    );
    expect(boxes!.odd).toEqual(box(0.05, 0.1, 0.91, 0.9));
    expect(boxes!.even).toEqual(box(0.05, 0.1, 0.91, 0.9));
  });
});

describe("trimSamplePageNumbers", () => {
  it("measures a short document in full", () => {
    expect(trimSamplePageNumbers(5)).toEqual([1, 2, 3, 4, 5]);
    expect(trimSamplePageNumbers(0)).toEqual([]);
  });

  it("spreads pairs through a long document with both parities", () => {
    const pages = trimSamplePageNumbers(584);
    expect(pages).toHaveLength(16);
    expect(pages.filter((page) => page % 2 === 0)).toHaveLength(8);
    expect(pages[0]).toBeGreaterThanOrEqual(1);
    expect(pages[pages.length - 1]).toBeLessThanOrEqual(584);
    expect([...pages].sort((a, b) => a - b)).toEqual(pages);
    expect(new Set(pages).size).toBe(pages.length);
  });

  it("never runs past the last page", () => {
    for (const total of [17, 18, 33, 640, 641]) {
      const pages = trimSamplePageNumbers(total);
      expect(Math.max(...pages)).toBeLessThanOrEqual(total);
      expect(Math.min(...pages)).toBeGreaterThanOrEqual(1);
      expect(pages.some((page) => page % 2 === 0)).toBe(true);
      expect(pages.some((page) => page % 2 === 1)).toBe(true);
    }
  });
});

describe("cropRectForPage / trimmedPageSize", () => {
  const boxes = { odd: box(0.1, 0.05, 0.9, 0.95), even: box(0.2, 0.05, 1, 0.95) };

  const rounded = (rect: Record<string, number> | null) =>
    rect &&
    Object.fromEntries(Object.entries(rect).map(([key, value]) => [key, Number(value.toFixed(6))]));

  it("selects the parity box and scales it to the viewport", () => {
    expect(trimBoxForPage(boxes, 3)).toBe(boxes.odd);
    expect(trimBoxForPage(boxes, 4)).toBe(boxes.even);
    expect(rounded(cropRectForPage(boxes, 3, { width: 1000, height: 2000 }))).toEqual({
      x: 100,
      y: 100,
      width: 800,
      height: 1800,
    });
    expect(rounded(cropRectForPage(boxes, 4, { width: 1000, height: 2000 }))).toEqual({
      x: 200,
      y: 100,
      width: 800,
      height: 1800,
    });
    expect(rounded(trimmedPageSize(boxes, 3, { width: 1000, height: 2000 }))).toEqual({
      width: 800,
      height: 1800,
    });
  });

  it("passes the viewport through without trimming", () => {
    expect(cropRectForPage(null, 1, { width: 10, height: 20 })).toBeNull();
    expect(trimmedPageSize(null, 1, { width: 10, height: 20 })).toEqual({ width: 10, height: 20 });
  });
});

describe("cached trim boxes", () => {
  const boxes = { odd: box(0.1, 0.05, 0.9, 0.95), even: box(0.2, 0.05, 1, 0.95) };

  function memoryStorage() {
    const map = new Map<string, string>();
    return {
      map,
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => {
        map.set(key, value);
      },
    };
  }

  it("round-trips through storage keyed by file", () => {
    const storage = memoryStorage();
    saveCachedPdfTrim("/books/a.pdf", 584, true, boxes, storage);
    expect(storage.map.has(pdfTrimStorageKey("/books/a.pdf"))).toBe(true);
    expect(loadCachedPdfTrim("/books/a.pdf", 584, true, storage)).toEqual(boxes);
  });

  it("rejects entries measured for a different page count or deskew setting", () => {
    const storage = memoryStorage();
    saveCachedPdfTrim("/books/a.pdf", 584, true, boxes, storage);
    expect(loadCachedPdfTrim("/books/a.pdf", 583, true, storage)).toBeNull();
    expect(loadCachedPdfTrim("/books/a.pdf", 584, false, storage)).toBeNull();
    expect(loadCachedPdfTrim("/books/b.pdf", 584, true, storage)).toBeNull();
  });

  it("rejects malformed, foreign-version, and insane entries", () => {
    expect(parseCachedPdfTrim(null, 1, false)).toBeNull();
    expect(parseCachedPdfTrim("not json", 1, false)).toBeNull();
    expect(parseCachedPdfTrim(JSON.stringify({ version: 2 }), 1, false)).toBeNull();
    expect(
      parseCachedPdfTrim(
        JSON.stringify({
          version: 1,
          pageCount: 1,
          deskew: false,
          odd: box(0.9, 0, 0.1, 1),
          even: boxes.even,
        }),
        1,
        false,
      ),
    ).toBeNull();
    expect(
      parseCachedPdfTrim(
        JSON.stringify({
          version: 1,
          pageCount: 1,
          deskew: false,
          odd: boxes.odd,
          even: boxes.even,
        }),
        1,
        false,
      ),
    ).toEqual(boxes);
  });

  it("tolerates a missing or throwing storage", () => {
    expect(loadCachedPdfTrim("/books/a.pdf", 1, false, null)).toBeNull();
    expect(loadCachedPdfTrim("", 1, false, memoryStorage())).toBeNull();
    const throwing = {
      getItem: () => {
        throw new Error("quota");
      },
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(loadCachedPdfTrim("/books/a.pdf", 1, false, throwing)).toBeNull();
    expect(() => saveCachedPdfTrim("/books/a.pdf", 1, false, boxes, throwing)).not.toThrow();
    expect(() => saveCachedPdfTrim("", 1, false, boxes, memoryStorage())).not.toThrow();
    expect(() => saveCachedPdfTrim("/books/a.pdf", 1, false, boxes, null)).not.toThrow();
  });
});
