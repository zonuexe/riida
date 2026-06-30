// Pure layout helpers for the native image-sequence fixed-layout EPUB viewer.
//
// These mirror the PDF spread/fit logic in viewer-layout-utils.ts but operate on
// the per-page page-spread metadata that Rust extracts from the OPF
// (`epub_image_layout` command). Kept DOM-free so they are unit-tested in
// isolation; the DOM wiring lives in src/main.ts.

export type Progression = "ltr" | "rtl";
export type SpreadSide = "left" | "right" | "center" | "";
export type ImagePageMode = "single" | "spread";

/** One spine page resolved to its image. Shapes match the Rust serialization. */
export type ImagePage = {
  index: number;
  /** Resolved zip entry path of the page image, or null for a non-image page. */
  imageEntry: string | null;
  spreadSide: SpreadSide;
  width: number;
  height: number;
};

/** A rendered unit: one page (single / cover) or two pages of one spread. */
export type ImageSpread = {
  pages: ImagePage[];
};

/** Normalize the raw command payload into typed `ImagePage`s in spine order. */
export function normalizeImagePages(
  raw: Array<{
    index: number;
    image_entry: string | null;
    spread_side: string;
    width: number;
    height: number;
  }>,
): ImagePage[] {
  return raw.map((p) => ({
    index: p.index,
    imageEntry: p.image_entry,
    spreadSide:
      p.spread_side === "left" || p.spread_side === "right" || p.spread_side === "center"
        ? p.spread_side
        : "",
    width: p.width,
    height: p.height,
  }));
}

/**
 * Group pages into spreads honoring page-spread-left/right/center.
 *
 * - `center` pages stand alone (cover, single inserts).
 * - The "first" side of a spread (left for ltr, right for rtl) opens a spread
 *   and pairs with the following "second" side page.
 * - A second-side page with no waiting partner is a lone recto (blank facing).
 * - Pages missing an explicit side continue the cadence (pair if one is
 *   pending, otherwise open a new spread).
 * - When no page carries spread metadata at all, fall back to sequential
 *   pairing with the first page treated as a standalone cover.
 *
 * Returns spreads in spine order; on-screen left/right is `visualSpreadOrder`.
 */
export function buildImageSpreads(
  pages: ImagePage[],
  progression: Progression,
  pageMode: ImagePageMode,
): ImageSpread[] {
  if (pageMode === "single") {
    return pages.map((page) => ({ pages: [page] }));
  }

  const hasSideMetadata = pages.some(
    (p) => p.spreadSide === "left" || p.spreadSide === "right" || p.spreadSide === "center",
  );

  if (!hasSideMetadata) {
    const spreads: ImageSpread[] = [];
    if (pages.length > 0) {
      spreads.push({ pages: [pages[0]!] });
    }
    for (let i = 1; i < pages.length; i += 2) {
      spreads.push({
        pages: i + 1 < pages.length ? [pages[i]!, pages[i + 1]!] : [pages[i]!],
      });
    }
    return spreads;
  }

  const firstSide: SpreadSide = progression === "rtl" ? "right" : "left";
  const secondSide: SpreadSide = progression === "rtl" ? "left" : "right";

  const spreads: ImageSpread[] = [];
  let pending: ImagePage | null = null;

  const flushPending = () => {
    if (pending) {
      spreads.push({ pages: [pending] });
      pending = null;
    }
  };

  for (const page of pages) {
    let side = page.spreadSide;
    if (side !== "center" && side !== firstSide && side !== secondSide) {
      side = pending ? secondSide : firstSide;
    }

    if (side === "center") {
      flushPending();
      spreads.push({ pages: [page] });
    } else if (side === firstSide) {
      flushPending();
      pending = page;
    } else {
      if (pending) {
        spreads.push({ pages: [pending, page] });
        pending = null;
      } else {
        spreads.push({ pages: [page] });
      }
    }
  }
  flushPending();

  return spreads;
}

/** On-screen left-to-right order of a spread's pages (rtl reverses the pair). */
export function visualSpreadOrder(spread: ImageSpread, progression: Progression): ImagePage[] {
  if (spread.pages.length < 2) {
    return spread.pages;
  }
  return progression === "rtl" ? [...spread.pages].reverse() : spread.pages;
}

/** Index of the spread containing the given spine page index (0 if not found). */
export function spreadIndexForPage(spreads: ImageSpread[], pageIndex: number): number {
  for (let i = 0; i < spreads.length; i += 1) {
    if (spreads[i]!.pages.some((p) => p.index === pageIndex)) {
      return i;
    }
  }
  return 0;
}

/** 1-based page number of a spread's earliest page (for the page-jump UI). */
export function firstPageNumberOfSpread(spread: ImageSpread): number {
  if (spread.pages.length === 0) {
    return 1;
  }
  const minIndex = spread.pages.reduce((min, p) => Math.min(min, p.index), spread.pages[0]!.index);
  return minIndex + 1;
}

export type FitBox = { widthPx: number; heightPx: number };

/**
 * Contain-fit a spread's images into the stage: all images share a common
 * height (so a two-page spread lines up), scaled down so the combined width
 * (plus gaps) and the height both fit. Never upscales past the stage height.
 */
export function computeImageFit(
  stage: { width: number; height: number },
  images: Array<{ width: number; height: number }>,
  gap: number,
): FitBox[] {
  const allValid = images.length > 0 && images.every((i) => i.width > 0 && i.height > 0);
  if (stage.width <= 0 || stage.height <= 0 || !allValid) {
    return images.map(() => ({ widthPx: 0, heightPx: 0 }));
  }

  const totalGap = Math.max(0, gap) * (images.length - 1);
  const aspectSum = images.reduce((sum, i) => sum + i.width / i.height, 0);
  const heightByWidth = aspectSum > 0 ? (stage.width - totalGap) / aspectSum : stage.height;
  const height = Math.max(0, Math.min(stage.height, heightByWidth));

  return images.map((i) => ({
    widthPx: height * (i.width / i.height),
    heightPx: height,
  }));
}
