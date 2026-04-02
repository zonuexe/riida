function normalizeTagSearch(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("ja").trim();
}

export function suggestTagCompletions(
  existingTags: string[],
  query: string,
  selectedTags: string[],
  limit = 8,
) {
  const normalizedQuery = normalizeTagSearch(query);

  if (!normalizedQuery) {
    return [];
  }

  return [...new Set(existingTags)]
    .filter((tag) => !selectedTags.includes(tag))
    .map((tag) => {
      const normalizedTag = normalizeTagSearch(tag);
      return {
        tag,
        matchIndex: normalizedTag.indexOf(normalizedQuery),
      };
    })
    .filter((entry) => entry.matchIndex >= 0)
    .sort((a, b) => a.matchIndex - b.matchIndex || a.tag.localeCompare(b.tag, "ja"))
    .slice(0, limit)
    .map((entry) => entry.tag);
}
