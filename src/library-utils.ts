export type DirectoryNode = {
  id: string;
  label: string;
  path: string;
  depth: number;
  count: number;
  parentPath: string | null;
  hasChildren: boolean;
};

type DirectorySnapshot = {
  libraryRoots: string[];
  books: Array<{ filePath: string }>;
};

type SearchableBook = {
  fileName: string;
  filePath: string;
  tags?: string[];
  locationLabel?: string | null;
  authors?: string[];
};

export type TagNode = {
  id: string;
  label: string;
  count: number;
  depth: number;
  explicit: boolean;
  hasChildren: boolean;
};

export function formatFileSize(fileSize: number) {
  const units = ["B", "KB", "MB", "GB"];
  let size = fileSize;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

export function normalizeSearchText(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("ja")
    .replace(/[\s\-_./]+/g, "");
}

export function formatBookLocation(filePath: string, homePath: string | null) {
  const normalizedPath = filePath.replace(/\/+$/, "");
  const lastSlashIndex = normalizedPath.lastIndexOf("/");
  const directoryPath =
    lastSlashIndex > 0 ? normalizedPath.slice(0, lastSlashIndex) : normalizedPath;

  if (!homePath) {
    return directoryPath;
  }

  const normalizedHomePath = homePath.replace(/\/+$/, "");

  if (directoryPath === normalizedHomePath) {
    return "~";
  }

  if (directoryPath.startsWith(`${normalizedHomePath}/`)) {
    return `~/${directoryPath.slice(normalizedHomePath.length + 1)}`;
  }

  return directoryPath;
}

export function deriveDirectories(snapshot: DirectorySnapshot): DirectoryNode[] {
  const counts = new Map<string, number>();
  const normalizedRoots = snapshot.libraryRoots
    .map((root) => root.replace(/\/+$/, ""))
    .sort((a, b) => b.length - a.length);
  const findRootForPath = (filePath: string) =>
    normalizedRoots.find(
      (candidate) => filePath === candidate || filePath.startsWith(`${candidate}/`),
    );

  for (const book of snapshot.books) {
    const root = findRootForPath(book.filePath);

    if (!root) {
      continue;
    }

    counts.set(root, (counts.get(root) ?? 0) + 1);
    const relative = book.filePath.startsWith(`${root}/`)
      ? book.filePath.slice(root.length + 1)
      : "";
    const parts = relative.split("/").slice(0, -1);
    let current = root;

    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      counts.set(current, (counts.get(current) ?? 0) + 1);
    }
  }

  const paths = [...counts.keys()];

  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b, "ja"))
    .map(([path, count]) => {
      const root = findRootForPath(path);
      const isRoot = normalizedRoots.includes(path);
      const relativePath = root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : "";

      return {
        id: path,
        label: path.split("/").filter(Boolean).pop() ?? path,
        path,
        depth: isRoot ? 0 : relativePath.split("/").length - 1,
        count,
        parentPath: isRoot ? null : path.slice(0, path.lastIndexOf("/")),
        hasChildren: paths.some((candidate) => candidate.startsWith(`${path}/`)),
      };
    });
}

export function filterVisibleBooks<T extends SearchableBook>(
  books: T[],
  activeDirectory: string | null,
  activeTag: string | null,
  activeTagDirectOnly: boolean,
  searchQuery: string,
) {
  return books.filter((book) => {
    if (activeDirectory) {
      const directory = activeDirectory.replace(/\/+$/, "");
      const normalizedPath = book.filePath.replace(/\/+$/, "");
      const fileDirectory =
        normalizedPath.slice(0, Math.max(normalizedPath.lastIndexOf("/"), 0)) || normalizedPath;

      if (fileDirectory !== directory) {
        return false;
      }
    }

    if (activeTag) {
      const tags = book.tags ?? [];
      const matchesTag = activeTagDirectOnly
        ? tags.includes(activeTag)
        : tags.some((tag) => tag === activeTag || tag.startsWith(`${activeTag}/`));

      if (!matchesTag) {
        return false;
      }
    }

    if (!searchQuery) {
      return true;
    }

    const query = normalizeSearchText(searchQuery);
    const normalizedName = normalizeSearchText(book.fileName);
    const normalizedPath = normalizeSearchText(book.filePath);
    const normalizedLocation = normalizeSearchText(book.locationLabel ?? "");
    const normalizedAuthors = normalizeSearchText((book.authors ?? []).join(" "));

    return (
      normalizedName.includes(query) ||
      normalizedPath.includes(query) ||
      normalizedLocation.includes(query) ||
      normalizedAuthors.includes(query)
    );
  });
}

export function deriveTags(books: Array<{ tags?: string[] }>): TagNode[] {
  const counts = new Map<string, number>();
  const explicitTags = new Set<string>();

  for (const book of books) {
    for (const tag of book.tags ?? []) {
      explicitTags.add(tag);
      const parts = tag.split("/").filter(Boolean);

      for (let index = 0; index < parts.length; index += 1) {
        const current = parts.slice(0, index + 1).join("/");
        counts.set(current, (counts.get(current) ?? 0) + 1);
      }
    }
  }

  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b, "ja"))
    .map(([tag, count]) => ({
      id: tag,
      label: tag.split("/").filter(Boolean).pop() ?? tag,
      count,
      depth: tag.split("/").filter(Boolean).length - 1,
      explicit: explicitTags.has(tag),
      hasChildren: [...counts.keys()].some((candidate) => candidate.startsWith(`${tag}/`)),
    }));
}
