export type NavigationStateLike = {
  historyIndex: number;
  bookFilePath: string | null;
  epubCfi?: string | null;
  pdfPage?: number | null;
  activeDirectory: string | null;
  activeTag: string | null;
  activeExternalSource: string | null;
  activeTagDirectOnly: boolean;
  searchQuery: string;
};

export function navigationStateSignature(state: NavigationStateLike) {
  return JSON.stringify({
    bookFilePath: state.bookFilePath,
    epubCfi: state.epubCfi ?? null,
    pdfPage: state.pdfPage ?? null,
    activeDirectory: state.activeDirectory,
    activeTag: state.activeTag,
    activeExternalSource: state.activeExternalSource,
    activeTagDirectOnly: state.activeTagDirectOnly,
    searchQuery: state.searchQuery,
  });
}

export function buildNavigationUrl(state: NavigationStateLike): string {
  const params = new URLSearchParams();

  if (state.searchQuery) {
    params.set("q", state.searchQuery);
  }

  if (state.activeDirectory) {
    params.set("dir", state.activeDirectory);
  }

  if (state.activeTag) {
    params.set("tag", state.activeTag);
  }

  if (state.activeExternalSource) {
    params.set("source", state.activeExternalSource);
  }

  if (state.activeTagDirectOnly) {
    params.set("tagMode", "direct");
  }

  if (state.bookFilePath) {
    params.set("book", state.bookFilePath);
  }

  if (state.pdfPage && Number.isFinite(state.pdfPage) && state.pdfPage >= 1) {
    params.set("page", String(state.pdfPage));
  }

  const query = params.toString();
  return query ? `/?${query}` : "/";
}

export function parsePdfPageQueryParam(rawValue: string | null): number | null {
  if (rawValue === null) {
    return null;
  }
  if (!/^\d+$/.test(rawValue)) {
    return null;
  }
  const pageNumber = Number.parseInt(rawValue, 10);
  return Number.isFinite(pageNumber) && pageNumber >= 1 ? pageNumber : null;
}
