export function parseRequestedPageNumber(rawValue: string) {
  const trimmed = rawValue.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }

  const pageNumber = Number.parseInt(trimmed, 10);
  return Number.isFinite(pageNumber) && pageNumber >= 1 ? pageNumber : null;
}
