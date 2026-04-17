export function clampEpubPageNumber(pageNumber: number, totalPages: number) {
  if (!Number.isFinite(pageNumber)) {
    return 1;
  }

  const normalizedTotalPages = Math.max(Math.trunc(totalPages), 1);
  const normalizedPageNumber = Math.trunc(pageNumber);
  return Math.min(Math.max(normalizedPageNumber, 1), normalizedTotalPages);
}

export function epubLocationIndexFromPageNumber(pageNumber: number, totalPages: number) {
  return clampEpubPageNumber(pageNumber, totalPages) - 1;
}

export function epubPageNumberFromLocation(
  location: number | null | undefined,
  totalPages: number,
) {
  if (!Number.isFinite(location)) {
    return 1;
  }

  return clampEpubPageNumber(Math.trunc(location as number) + 1, totalPages);
}
