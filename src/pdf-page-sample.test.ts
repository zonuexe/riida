import { describe, expect, it } from "vitest";
import {
  PAGE_SAMPLE_LONG_EDGE,
  PdfPageAnalyzer,
  analyzePageSample,
  pageSampleSize,
  renderPageSample,
  resolvePdfTrimBoxes,
  type PdfDocumentLike,
} from "./pdf-page-sample";

import {
  blankPage,
  fakePage,
  fakeSurface,
  horizontalTextPage,
  textBlockFor,
} from "./pdf-page-fixtures";
import { pdfTrimStorageKey, type TrimStorage } from "./pdf-trim";

// The sweep refines in 0.05° steps, but on a 640 px sample a step shifts the
// projection by well under a pixel, so the practical precision is ~0.1°.
const ANGLE_TOLERANCE = 0.12;

describe("pageSampleSize", () => {
  it("shrinks the longer edge to the sample size and keeps the aspect ratio", () => {
    expect(pageSampleSize(1200, 1800)).toEqual({
      width: Math.round(1200 * (PAGE_SAMPLE_LONG_EDGE / 1800)),
      height: PAGE_SAMPLE_LONG_EDGE,
    });
    expect(pageSampleSize(1800, 1200).width).toBe(PAGE_SAMPLE_LONG_EDGE);
  });

  it("never enlarges a page that is already small", () => {
    expect(pageSampleSize(300, 200)).toEqual({ width: 300, height: 200 });
  });

  it("tolerates degenerate dimensions", () => {
    expect(pageSampleSize(0, 0)).toEqual({ width: 1, height: 1 });
  });
});

describe("renderPageSample", () => {
  it("renders at sampling size onto the surface and reads it back as grayscale", async () => {
    const surface = fakeSurface((width, height) => horizontalTextPage(0, width, height));
    const page = fakePage(1200, 1600);
    const image = await renderPageSample(page, surface);
    expect(page.renders).toHaveLength(1);
    expect(page.renders[0]!.height).toBeCloseTo(PAGE_SAMPLE_LONG_EDGE, 6);
    expect(surface.canvas.width).toBe(Math.ceil(page.renders[0]!.width));
    expect(surface.canvas.height).toBe(PAGE_SAMPLE_LONG_EDGE);
    expect(image.width).toBe(surface.canvas.width);
    expect(image.height).toBe(surface.canvas.height);
    expect(image.data.length).toBe(image.width * image.height);
  });
});

describe("analyzePageSample", () => {
  it("measures both the tilt and the printed area", () => {
    const image = horizontalTextPage(0.8);
    const analysis = analyzePageSample(image);
    expect(analysis.angleDeg).not.toBeNull();
    expect(Math.abs(analysis.angleDeg! - 0.8)).toBeLessThanOrEqual(ANGLE_TOLERANCE);
    expect(analysis.inkBox).not.toBeNull();
    expect(analysis.width).toBe(image.width);
    expect(analysis.height).toBe(image.height);
  });

  it("reports nothing for a blank page", () => {
    expect(analyzePageSample(blankPage(480, 640))).toEqual({
      angleDeg: null,
      inkBox: null,
      width: 480,
      height: 640,
    });
  });
});

describe("PdfPageAnalyzer", () => {
  it("measures once per page and serves repeats from the cache", async () => {
    let surfaces = 0;
    const analyzer = new PdfPageAnalyzer(() => {
      surfaces += 1;
      return fakeSurface((width, height) => horizontalTextPage(0.8, width, height));
    });
    const page = fakePage(1000, 1400);

    const first = await analyzer.analyze(page, "scan.pdf", 3);
    const second = await analyzer.analyze(page, "scan.pdf", 3);
    expect(first.angleDeg).not.toBeNull();
    expect(Math.abs(first.angleDeg! - 0.8)).toBeLessThanOrEqual(ANGLE_TOLERANCE);
    expect(first.inkBox).not.toBeNull();
    expect(second).toBe(first);
    expect(page.renders).toHaveLength(1);
    expect(surfaces).toBe(1);
  });

  it("re-measures for a different document and after forget()", async () => {
    const analyzer = new PdfPageAnalyzer(() =>
      fakeSurface((width, height) => horizontalTextPage(0.5, width, height)),
    );
    const page = fakePage(1000, 1400);
    await analyzer.analyze(page, "a.pdf", 1);
    await analyzer.analyze(page, "b.pdf", 1);
    expect(page.renders).toHaveLength(2);
    await analyzer.analyze(page, "b.pdf", 1);
    expect(page.renders).toHaveLength(2);
    analyzer.forget();
    await analyzer.analyze(page, "b.pdf", 1);
    expect(page.renders).toHaveLength(3);
  });

  it("treats a missing surface as unmeasurable and never renders", async () => {
    const analyzer = new PdfPageAnalyzer(() => null);
    const page = fakePage(1000, 1400);
    const analysis = await analyzer.analyze(page, "scan.pdf", 1);
    expect(analysis.angleDeg).toBeNull();
    expect(analysis.inkBox).toBeNull();
    expect(page.renders).toHaveLength(0);
  });

  it("swallows a failing render and remembers the page as unmeasurable", async () => {
    const analyzer = new PdfPageAnalyzer(() =>
      fakeSurface((width, height) => horizontalTextPage(1, width, height)),
    );
    const page = fakePage(1000, 1400, () => Promise.reject(new Error("render failed")));
    expect((await analyzer.analyze(page, "scan.pdf", 1)).angleDeg).toBeNull();
    expect((await analyzer.analyze(page, "scan.pdf", 1)).inkBox).toBeNull();
    expect(page.renders).toHaveLength(1);
  });
});

describe("resolvePdfTrimBoxes", () => {
  function memoryStorage(): TrimStorage & { map: Map<string, string> } {
    const map = new Map<string, string>();
    return {
      map,
      getItem: (key) => map.get(key) ?? null,
      setItem: (key, value) => {
        map.set(key, value);
      },
    };
  }

  function fakeDocument(
    numPages: number,
  ): PdfDocumentLike & { requested: number[]; pages: Map<number, ReturnType<typeof fakePage>> } {
    const requested: number[] = [];
    const pages = new Map<number, ReturnType<typeof fakePage>>();
    return {
      numPages,
      requested,
      pages,
      getPage: async (pageNumber) => {
        requested.push(pageNumber);
        let page = pages.get(pageNumber);
        if (!page) {
          page = fakePage(1000, 1400);
          pages.set(pageNumber, page);
        }
        return page;
      },
    };
  }

  // The analyzer's surface paints the same synthetic page for every request.
  const analyzerFor = (angleDeg: number) =>
    new PdfPageAnalyzer(() =>
      fakeSurface((width, height) => horizontalTextPage(angleDeg, width, height)),
    );

  it("samples a spread of pages, aggregates them, and caches the result", async () => {
    const storage = memoryStorage();
    const document = fakeDocument(584);
    const progress: Array<[number, number]> = [];
    const boxes = await resolvePdfTrimBoxes({
      document,
      filePath: "/books/scan.pdf",
      deskew: false,
      analyzer: analyzerFor(0),
      storage,
      onProgress: (measured, total) => progress.push([measured, total]),
    });
    expect(boxes).not.toBeNull();
    expect(document.requested).toHaveLength(16);
    expect(progress[progress.length - 1]).toEqual([16, 16]);
    // The synthetic print sits inside the fixture's text block.
    const width = 640 * (1000 / 1400);
    const block = textBlockFor(Math.ceil(width), 640);
    expect(boxes!.odd.left * width).toBeLessThanOrEqual(block.left);
    expect(boxes!.odd.left).toBeGreaterThan(0.05);
    expect(boxes!.odd.top).toBeGreaterThan(0.05);
    expect(boxes!.odd.right).toBeLessThan(0.95);
    expect(boxes!.odd.bottom).toBeLessThan(0.95);
    expect(storage.map.has(pdfTrimStorageKey("/books/scan.pdf"))).toBe(true);

    // A second resolve is served from the cache without touching the document.
    const again = await resolvePdfTrimBoxes({
      document: fakeDocument(584),
      filePath: "/books/scan.pdf",
      deskew: false,
      analyzer: analyzerFor(0),
      storage,
    });
    expect(again).toEqual(boxes);
  });

  it("releases every sampled page, so the pre-pass leaves no decoded images behind", async () => {
    const document = fakeDocument(120);
    await resolvePdfTrimBoxes({
      document,
      filePath: "/books/released.pdf",
      deskew: false,
      analyzer: analyzerFor(0),
      storage: memoryStorage(),
    });

    expect(document.pages.size).toBeGreaterThan(0);
    for (const page of document.pages.values()) {
      expect(page.cleanups).toBe(1);
    }
  });

  it("widens the boxes for the rotation when deskew is on", async () => {
    const storage = memoryStorage();
    const level = await resolvePdfTrimBoxes({
      document: fakeDocument(20),
      filePath: "/books/level.pdf",
      deskew: true,
      analyzer: analyzerFor(0),
      storage,
    });
    const tilted = await resolvePdfTrimBoxes({
      document: fakeDocument(20),
      filePath: "/books/tilted.pdf",
      deskew: true,
      analyzer: analyzerFor(2),
      storage,
    });
    expect(level).not.toBeNull();
    expect(tilted).not.toBeNull();
    // The tilted print's own extent is wider than the level print's, and its
    // rotated bounds widen it further; either way it must stay inside the page.
    expect(tilted!.odd.right - tilted!.odd.left).toBeGreaterThan(
      level!.odd.right - level!.odd.left,
    );
    expect(tilted!.odd.left).toBeGreaterThanOrEqual(0);
    expect(tilted!.odd.right).toBeLessThanOrEqual(1);
  });

  it("stops and returns null when cancelled", async () => {
    let calls = 0;
    const document = fakeDocument(584);
    const boxes = await resolvePdfTrimBoxes({
      document,
      filePath: "/books/scan.pdf",
      deskew: false,
      analyzer: analyzerFor(0),
      storage: memoryStorage(),
      isCancelled: () => {
        calls += 1;
        return calls > 3;
      },
    });
    expect(boxes).toBeNull();
    expect(document.requested.length).toBeLessThan(16);
  });

  it("returns null when no page has measurable print", async () => {
    const storage = memoryStorage();
    const boxes = await resolvePdfTrimBoxes({
      document: fakeDocument(10),
      filePath: "/books/blank.pdf",
      deskew: false,
      analyzer: new PdfPageAnalyzer(() => fakeSurface((width, height) => blankPage(width, height))),
      storage,
    });
    expect(boxes).toBeNull();
    expect(storage.map.size).toBe(0);
  });
});
