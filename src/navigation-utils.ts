export type NavigationStateLike = {
  historyIndex: number;
  bookFilePath: string | null;
  activeDirectory: string | null;
  activeTag: string | null;
  searchQuery: string;
};

export function navigationStateSignature(state: NavigationStateLike) {
  return JSON.stringify({
    bookFilePath: state.bookFilePath,
    activeDirectory: state.activeDirectory,
    activeTag: state.activeTag,
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

  if (state.bookFilePath) {
    params.set("book", state.bookFilePath);
  }

  const query = params.toString();
  return query ? `/?${query}` : "/";
}
