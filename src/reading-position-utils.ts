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

export function parseCachedReadingPosition(rawValue: string | null): ReadingPositionLike | null {
  if (!rawValue) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawValue) as Partial<ReadingPositionLike>;
    if (
      typeof parsed.filePath !== "string" ||
      typeof parsed.pageNumber !== "number" ||
      typeof parsed.pageOffsetRatio !== "number"
    ) {
      return null;
    }

    return {
      filePath: parsed.filePath,
      pageNumber: parsed.pageNumber,
      pageOffsetRatio: clampReadingPositionOffsetRatio(parsed.pageOffsetRatio),
      cfi: typeof parsed.cfi === "string" ? parsed.cfi : null,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : null,
    };
  } catch {
    return null;
  }
}
