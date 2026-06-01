export type TagValidationResult = { ok: true; value: string } | { ok: false; message: string };

export function validateTagValue(value: string): TagValidationResult {
  const candidate = value.trim();

  if (!candidate) {
    return { ok: false, message: "Tags cannot be empty." };
  }

  if (
    candidate === "/" ||
    candidate.startsWith("/") ||
    candidate.endsWith("/") ||
    candidate.includes("//")
  ) {
    return {
      ok: false,
      message: "Tags cannot start or end with '/', be just '/', or contain '//'.",
    };
  }

  return { ok: true, value: candidate };
}

export type TagDescendantStats = {
  bookCount: number;
  affectedTags: string[];
};

/**
 * Count how many books carry `tagId` itself or any of its hierarchical
 * descendants (`tagId/...`), and collect the distinct affected tags.
 *
 * Pure helper extracted from the tag manager so the matching/counting logic
 * can be unit-tested without the DOM or app state.
 */
export function countBooksWithTagOrDescendants(
  books: ReadonlyArray<{ filePath: string; tags?: string[] }>,
  tagId: string,
): TagDescendantStats {
  const prefix = `${tagId}/`;
  const affectedTagSet = new Set<string>();
  const affectedBookSet = new Set<string>();

  for (const book of books) {
    for (const tag of book.tags ?? []) {
      if (tag === tagId || tag.startsWith(prefix)) {
        affectedTagSet.add(tag);
        affectedBookSet.add(book.filePath);
      }
    }
  }

  return {
    bookCount: affectedBookSet.size,
    affectedTags: [...affectedTagSet].sort((a, b) => a.localeCompare(b, "ja")),
  };
}
