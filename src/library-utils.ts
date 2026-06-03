import { type LeafNode, evaluateAst, parseSearchQueryAstSafe } from "./search-query-ast.ts";

export type EmptyLibraryStateInput = {
  libraryRoots: string[];
  existingLibraryRoots: string[];
  missingLibraryRoots: string[];
  bookCount: number;
  hasFilter: boolean;
  libraryErrorMessage: string | null;
};

export type EmptyLibraryStateMessage = {
  message: string;
  detail: string | null;
};

/**
 * Decide which empty / error message to show in the library list given
 * the current snapshot, filter state, and any user-facing error.
 *
 * Branch order (first match wins):
 *  1. an active filter is in effect → "No matching books."
 *  2. a library error message has been recorded → show it verbatim
 *  3. no library roots configured → onboarding message
 *  4. configured roots all missing on disk → ask the user to update
 *  5. no books at all → "Your library is empty." with a hint
 *  6. otherwise → "No PDFs yet." (e.g. scanning in progress)
 */
export function describeEmptyLibraryState(input: EmptyLibraryStateInput): EmptyLibraryStateMessage {
  if (input.hasFilter) {
    return { message: "No matching books.", detail: null };
  }

  if (input.libraryErrorMessage) {
    return { message: input.libraryErrorMessage, detail: null };
  }

  if (input.libraryRoots.length === 0) {
    return {
      message: "No library folders selected yet.",
      detail: "Open Settings and add at least one library folder.",
    };
  }

  if (input.existingLibraryRoots.length === 0) {
    return {
      message: "The configured library folders do not exist.",
      detail:
        "Update Library roots in Settings and choose folders that are available on this machine.",
    };
  }

  if (input.bookCount === 0) {
    return {
      message: "Your library is empty.",
      detail:
        input.missingLibraryRoots.length > 0
          ? "Some configured folders are missing, and no PDFs were found in the folders that still exist."
          : "No PDFs were found in the configured library folders.",
    };
  }

  return { message: "No PDFs yet.", detail: null };
}

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
  indexedAt?: number;
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

/**
 * Build the author "byline" shown under a book title. Authors past `maxAuthors`
 * collapse into a trailing `他N名` so long translator lists do not fill the row.
 * Returns "" when there are no authors so the caller can skip the line entirely.
 */
export function formatAuthorByline(authors: string[], maxAuthors = 3): string {
  const cleaned = authors.map((author) => author.trim()).filter((author) => author.length > 0);
  if (cleaned.length === 0) {
    return "";
  }
  if (cleaned.length <= maxAuthors) {
    return cleaned.join(", ");
  }
  const shown = cleaned.slice(0, maxAuthors).join(", ");
  return `${shown} 他${cleaned.length - maxAuthors}名`;
}

/**
 * Extract a 4-digit publication year from a `YYYY-MM-DD` release date.
 * Returns null when the value is absent or not in the expected shape.
 */
export function formatReleaseYear(releaseDate: string | null | undefined): string | null {
  if (!releaseDate) {
    return null;
  }
  const match = /^(\d{4})-\d{2}-\d{2}$/.exec(releaseDate.trim());
  return match?.[1] ?? null;
}

/**
 * Join the muted metadata strip (publisher · year · location · size) with a
 * middot separator, dropping any empty/null parts so missing fields collapse
 * cleanly instead of leaving dangling separators.
 */
export function formatBookMetaLine(parts: Array<string | null | undefined>): string {
  return parts
    .map((part) => (part == null ? "" : part.trim()))
    .filter((part) => part.length > 0)
    .join(" · ");
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

// Parse a relative duration ("7d", "1w", "2m", "1y", or named "today" /
// "week" / "month" / "year") into seconds. Returns null when unrecognised.
//
// The named forms exist for legacy `read:` queries; new Gmail-style
// operators (newer_than / older_than / added_newer_than / ...) accept
// the same value shapes for consistency.
export function parseRelativeDurationSeconds(value: string): number | null {
  const v = value.trim().toLowerCase();
  const named: Record<string, number> = {
    today: 86400,
    week: 7 * 86400,
    month: 30 * 86400,
    year: 365 * 86400,
  };
  if (named[v] !== undefined) return named[v];
  const m = /^(\d+)(d|w|m|y)$/.exec(v);
  if (m && m[1] !== undefined) {
    const n = parseInt(m[1], 10);
    const unit = m[2];
    if (unit === "d") return n * 86400;
    if (unit === "w") return n * 7 * 86400;
    if (unit === "m") return n * 30 * 86400;
    if (unit === "y") return n * 365 * 86400;
  }
  return null;
}

// Parse "YYYY/MM/DD" or "YYYY-MM-DD" into a UNIX-second timestamp at
// local midnight. Returns null on malformed or out-of-range input
// (e.g. "2026-02-30"). Mixing separators is not allowed.
export function parseAbsoluteDateSeconds(value: string): number | null {
  const v = value.trim();
  const slash = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(v);
  const dash = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v);
  const m = slash ?? dash;
  if (!m) return null;
  const y = parseInt(m[1] as string, 10);
  const mo = parseInt(m[2] as string, 10);
  const d = parseInt(m[3] as string, 10);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const date = new Date(y, mo - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) {
    return null;
  }
  return Math.floor(date.getTime() / 1000);
}

type TimeFieldSpec = {
  timestamp: "lastReadAt" | "indexedAt";
  // "newer_than" / "older_than" take a relative duration.
  // "after" / "before" take an absolute date.
  kind: "newer_than" | "older_than" | "after" | "before";
};

// Gmail-style time operators. Bare forms target last_read_at; `added_*`
// variants target indexed_at. `newer` / `older` are Gmail's absolute-date
// aliases for `after` / `before`.
const TIME_FIELDS: Record<string, TimeFieldSpec> = {
  newer_than: { timestamp: "lastReadAt", kind: "newer_than" },
  older_than: { timestamp: "lastReadAt", kind: "older_than" },
  after: { timestamp: "lastReadAt", kind: "after" },
  before: { timestamp: "lastReadAt", kind: "before" },
  newer: { timestamp: "lastReadAt", kind: "after" },
  older: { timestamp: "lastReadAt", kind: "before" },
  added_newer_than: { timestamp: "indexedAt", kind: "newer_than" },
  added_older_than: { timestamp: "indexedAt", kind: "older_than" },
  added_after: { timestamp: "indexedAt", kind: "after" },
  added_before: { timestamp: "indexedAt", kind: "before" },
  added_newer: { timestamp: "indexedAt", kind: "after" },
  added_older: { timestamp: "indexedAt", kind: "before" },
};

function bookTimestamp(book: SearchableBook, key: TimeFieldSpec["timestamp"]): number | null {
  if (key === "lastReadAt") return book.lastReadAt ?? null;
  return book.indexedAt ?? null;
}

function matchTimeField(
  book: SearchableBook,
  spec: TimeFieldSpec,
  value: string,
  nowSeconds: number,
): boolean {
  const ts = bookTimestamp(book, spec.timestamp);
  if (ts == null) return false;
  if (spec.kind === "newer_than" || spec.kind === "older_than") {
    const duration = parseRelativeDurationSeconds(value);
    if (duration === null) return false;
    const threshold = nowSeconds - duration;
    return spec.kind === "newer_than" ? ts >= threshold : ts < threshold;
  }
  const cutoff = parseAbsoluteDateSeconds(value);
  if (cutoff === null) return false;
  return spec.kind === "after" ? ts >= cutoff : ts < cutoff;
}

function matchesFieldToken(book: SearchableBook, field: string, value: string): boolean {
  const q = normalizeSearchText(value);

  switch (field) {
    case "title": {
      // Fall back to the file name when no metadata title is set, so
      // unmetadata'd books can still be matched by what the user sees
      // as the title in the library list.
      const titleText = book.title && book.title.length > 0 ? book.title : book.fileName;
      return normalizeSearchText(titleText).includes(q);
    }
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
      // `read:never` matches books that have never been opened. Other
      // values behave as a shorthand for `newer_than:<duration>` against
      // last_read_at.
      const v = value.trim().toLowerCase();
      if (v === "never") return book.lastReadAt == null;
      const duration = parseRelativeDurationSeconds(value);
      if (duration === null) return false;
      const lastReadAt = book.lastReadAt;
      if (lastReadAt == null) return false;
      const nowSeconds = Date.now() / 1000;
      return nowSeconds - lastReadAt <= duration;
    }
    default: {
      const spec = TIME_FIELDS[field];
      if (spec) return matchTimeField(book, spec, value, Date.now() / 1000);
      return false;
    }
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

function matchesLeaf(leaf: LeafNode, book: SearchableBook): boolean {
  if (leaf.kind === "field") {
    return matchesFieldToken(book, leaf.field, leaf.value);
  }
  return matchesFreeToken(book, leaf.value);
}

export function filterVisibleBooks<T extends SearchableBook>(
  books: T[],
  activeDirectory: string | null,
  activeTag: string | null,
  activeExternalSource: string | null,
  activeTagDirectOnly: boolean,
  searchQuery: string,
) {
  const ast = parseSearchQueryAstSafe(searchQuery);

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

    if (!evaluateAst(ast, book, matchesLeaf)) return false;

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

/**
 * Distinct non-empty publishers across the supplied books, sorted by
 * Japanese collation. Useful for inline suggestion lists.
 */
export function derivePublishers(books: Array<{ publisher?: string | null }>): string[] {
  return collectDistinctTrimmed(books, (book) => book.publisher);
}

/**
 * Distinct non-empty languages across the supplied books, sorted by
 * Japanese collation.
 */
export function deriveLanguages(books: Array<{ language?: string | null }>): string[] {
  return collectDistinctTrimmed(books, (book) => book.language);
}

/**
 * Distinct non-empty source types across the supplied books, sorted
 * by Japanese collation.
 */
export function deriveSources(books: Array<{ sourceType?: string | null }>): string[] {
  return collectDistinctTrimmed(books, (book) => book.sourceType);
}

function collectDistinctTrimmed<B>(
  books: B[],
  pick: (book: B) => string | null | undefined,
): string[] {
  const set = new Set<string>();
  for (const book of books) {
    const value = pick(book)?.trim();
    if (value && value.length > 0) {
      set.add(value);
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b, "ja"));
}
