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
