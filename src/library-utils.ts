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
  title?: string | null;
  filePath: string;
  tags?: string[];
  locationLabel?: string | null;
  authors?: string[];
  sourceType?: string;
  publisher?: string | null;
  language?: string | null;
  lastReadAt?: number | null;
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

const KNOWN_FIELDS = new Set([
  "title",
  "author",
  "publisher",
  "tag",
  "lang",
  "file",
  "path",
  "source",
  "read",
]);

export type QueryToken =
  | { kind: "field"; field: string; value: string; negate: boolean }
  | { kind: "free"; value: string };

export function parseSearchQuery(raw: string): QueryToken[] {
  const tokens: QueryToken[] = [];
  // Tokenise respecting double-quoted phrases, e.g. author:"Robert C. Martin"
  const re = /(-?)(?:"([^"]*)"|((?:[^\s"\\]|\\.)+))/g;
  let match: RegExpExecArray | null;

  while ((match = re.exec(raw)) !== null) {
    const negate = match[1] === "-";
    const atom = match[2] ?? match[3]; // quoted or unquoted
    const colon = atom.indexOf(":");

    if (colon > 0) {
      const field = atom.slice(0, colon).toLowerCase();
      const value = atom.slice(colon + 1);
      if (KNOWN_FIELDS.has(field) && value.length > 0) {
        tokens.push({ kind: "field", field, value, negate });
        continue;
      }
    }

    if (atom.length > 0) {
      tokens.push({ kind: "free", value: negate ? `-${atom}` : atom });
    }
  }

  return tokens;
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

// Returns the threshold in seconds for a read: value, or null if unrecognised.
function parseReadThresholdSeconds(value: string): number | null | "never" {
  const v = value.trim().toLowerCase();
  if (v === "never") return "never";
  const named: Record<string, number> = {
    today: 86400,
    week: 7 * 86400,
    month: 30 * 86400,
    year: 365 * 86400,
  };
  if (named[v] !== undefined) return named[v];
  const m = /^(\d+)(d|w|m)$/.exec(v);
  if (m) {
    const n = parseInt(m[1], 10);
    const unit = m[2];
    if (unit === "d") return n * 86400;
    if (unit === "w") return n * 7 * 86400;
    if (unit === "m") return n * 30 * 86400;
  }
  return null;
}

function matchesFieldToken(book: SearchableBook, field: string, value: string): boolean {
  const q = normalizeSearchText(value);

  switch (field) {
    case "title":
      return normalizeSearchText(book.title ?? "").includes(q);
    case "author":
      return (book.authors ?? []).some((a) => normalizeSearchText(a).includes(q));
    case "publisher":
      return normalizeSearchText(book.publisher ?? "").includes(q);
    case "tag": {
      const tags = book.tags ?? [];
      return tags.some((tag) => {
        const normalizedTag = normalizeSearchText(tag);
        const normalizedQ = normalizeSearchText(q);
        return normalizedTag === normalizedQ || normalizedTag.startsWith(`${normalizedQ}/`);
      });
    }
    case "lang":
      return normalizeSearchText(book.language ?? "").includes(q);
    case "file":
      return normalizeSearchText(book.fileName).includes(q);
    case "path":
      return normalizeSearchText(book.filePath).includes(q);
    case "source":
      return normalizeSearchText(book.sourceType ?? "").includes(q);
    case "read": {
      const threshold = parseReadThresholdSeconds(value);
      if (threshold === null) return false;
      if (threshold === "never") return book.lastReadAt == null;
      const lastReadAt = book.lastReadAt;
      if (lastReadAt == null) return false;
      const nowSeconds = Date.now() / 1000;
      return nowSeconds - lastReadAt <= threshold;
    }
    default:
      return false;
  }
}

function matchesFreeToken(book: SearchableBook, value: string): boolean {
  const q = normalizeSearchText(value);
  return (
    normalizeSearchText(book.fileName).includes(q) ||
    normalizeSearchText(book.title ?? "").includes(q) ||
    normalizeSearchText(book.filePath).includes(q) ||
    normalizeSearchText(book.locationLabel ?? "").includes(q) ||
    normalizeSearchText((book.authors ?? []).join(" ")).includes(q) ||
    normalizeSearchText(book.publisher ?? "").includes(q)
  );
}

export function filterVisibleBooks<T extends SearchableBook>(
  books: T[],
  activeDirectory: string | null,
  activeTag: string | null,
  activeExternalSource: string | null,
  activeTagDirectOnly: boolean,
  searchQuery: string,
) {
  const tokens = parseSearchQuery(searchQuery);

  return books.filter((book) => {
    if (activeExternalSource && book.sourceType !== activeExternalSource) {
      return false;
    }

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

    for (const token of tokens) {
      if (token.kind === "field") {
        const matches = matchesFieldToken(book, token.field, token.value);
        if (token.negate ? matches : !matches) return false;
      } else {
        if (!matchesFreeToken(book, token.value)) return false;
      }
    }

    return true;
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
