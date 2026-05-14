import * as v from "valibot";

export type ReadingPositionLike = {
  filePath: string;
  pageNumber: number;
  pageOffsetRatio: number;
  cfi?: string | null;
  updatedAt: number | null;
};

export function readingPositionStorageKey(filePath: string) {
  return `riida:reading-position:${filePath}`;
}

export function clampReadingPositionOffsetRatio(value: number) {
  return Math.min(Math.max(value, 0), 1);
}

/**
 * Pick the index of the page anchoring the current reading position.
 *
 * The anchor is the last page whose `offsetTop` is at or above the
 * `anchorLine` (i.e. the page that the line cuts through, or the
 * one immediately above it). Pages must be supplied in document
 * order. Returns -1 only when the input is empty.
 */
export function selectAnchorPageIndex(pageOffsetTops: readonly number[], anchorLine: number) {
  if (pageOffsetTops.length === 0) return -1;
  let anchorIndex = 0;
  for (let i = 0; i < pageOffsetTops.length; i++) {
    const top = pageOffsetTops[i];
    if (top === undefined) continue;
    if (top <= anchorLine) {
      anchorIndex = i;
    } else {
      break;
    }
  }
  return anchorIndex;
}

/**
 * Compute the reading-position fraction within the anchor page.
 *
 * `(scrollTop - anchorOffsetTop) / pageHeight`, clamped to [0, 1].
 * `pageHeight` is treated as at least 1 to avoid division-by-zero
 * when a page hasn't laid out yet.
 */
export function computePageOffsetRatio(
  scrollTop: number,
  anchorOffsetTop: number,
  pageHeight: number,
) {
  const safeHeight = Math.max(pageHeight, 1);
  return clampReadingPositionOffsetRatio((scrollTop - anchorOffsetTop) / safeHeight);
}

const cachedReadingPositionSchema = v.pipe(
  v.object({
    filePath: v.string(),
    pageNumber: v.number(),
    pageOffsetRatio: v.number(),
    cfi: v.optional(v.nullable(v.string()), null),
    updatedAt: v.nullable(v.number(), null),
  }),
  v.transform(
    (parsed): ReadingPositionLike => ({
      filePath: parsed.filePath,
      pageNumber: parsed.pageNumber,
      pageOffsetRatio: clampReadingPositionOffsetRatio(parsed.pageOffsetRatio),
      cfi: typeof parsed.cfi === "string" ? parsed.cfi : null,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : null,
    }),
  ),
);

export function parseCachedReadingPosition(rawValue: string | null): ReadingPositionLike | null {
  if (!rawValue) return null;
  try {
    const parsed = JSON.parse(rawValue);
    const result = v.safeParse(cachedReadingPositionSchema, parsed);
    return result.success ? result.output : null;
  } catch {
    return null;
  }
}

export type ReadingPositionStorage = Pick<Storage, "getItem" | "setItem">;

function defaultReadingPositionStorage(): ReadingPositionStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadCachedReadingPosition(
  filePath: string,
  storage: ReadingPositionStorage | null = defaultReadingPositionStorage(),
): ReadingPositionLike | null {
  if (!filePath || !storage) return null;
  try {
    return parseCachedReadingPosition(storage.getItem(readingPositionStorageKey(filePath)));
  } catch {
    return null;
  }
}

export function saveCachedReadingPosition(
  position: ReadingPositionLike,
  storage: ReadingPositionStorage | null = defaultReadingPositionStorage(),
): void {
  if (!position?.filePath || !storage) return;
  try {
    storage.setItem(readingPositionStorageKey(position.filePath), JSON.stringify(position));
  } catch {
    // Storage full or unavailable — skip caching.
  }
}

/**
 * In a PDF spread layout, multiple pages share the same `offsetTop`. When the
 * anchor falls inside such a spread, prefer the smallest page number — the
 * "head-side" page — so switching from spread to single-page lands closer to
 * the start of the book rather than on the trailing page.
 *
 * Pages may be supplied in any order. Returns the entry with the smallest
 * page number among those that share `anchorOffsetTop` with the anchor entry.
 * Returns the anchor unchanged when nothing else shares its offsetTop or when
 * the candidates list is empty.
 */
export function selectHeadSidePageInSpread<T extends { pageNumber: number; offsetTop: number }>(
  anchor: T,
  candidates: readonly T[],
): T {
  let best = anchor;
  for (const candidate of candidates) {
    if (candidate.offsetTop !== anchor.offsetTop) continue;
    if (candidate.pageNumber > 0 && candidate.pageNumber < best.pageNumber) {
      best = candidate;
    }
  }
  return best;
}
