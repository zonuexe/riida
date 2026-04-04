export type BookMetadataDraft = {
  title: string;
  authorsText: string;
  description: string;
  publisher: string;
  releaseDate: string;
  language: string;
  url: string;
  asin: string;
  coverUrl: string;
};

export type BookMetadataImportPatch = {
  title?: string | null;
  authors?: string[] | null;
  description?: string | null;
  publisher?: string | null;
  releaseDate?: string | null;
  language?: string | null;
  url?: string | null;
  asin?: string | null;
  coverUrl?: string | null;
};

type NullableStringImportKey = Exclude<keyof BookMetadataImportPatch, "authors">;

export const BOOK_METADATA_IMPORT_EXAMPLE = `{
  "title": "型システムのしくみ",
  "authors": ["山田 太郎", "Jane Smith"],
  "description": "型とプログラミング言語の基礎を解説する入門書です。",
  "publisher": "技術評論社",
  "releaseDate": "2026-04-04",
  "language": "ja",
  "url": "https://example.com/books/type-systems",
  "asin": "B012345678",
  "coverUrl": "https://m.media-amazon.com/images/I/example.jpg"
}`;

export function normalizeMetadataAuthorsText(value: string): string[] {
  const seen = new Set<string>();
  const authors: string[] = [];

  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    authors.push(trimmed);
  }

  return authors;
}

export function joinMetadataAuthors(authors: string[]): string {
  return authors.join("\n");
}

function isLeapYear(year: number) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function isValidMetadataReleaseDate(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return true;
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!match) {
    return false;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (month < 1 || month > 12 || day < 1) {
    return false;
  }

  const maxDay =
    month === 2 ? (isLeapYear(year) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;

  return day <= maxDay;
}

export function validateBookMetadataDraft(
  draft: BookMetadataDraft,
): { ok: true } | { ok: false; message: string } {
  if (!isValidMetadataReleaseDate(draft.releaseDate)) {
    return {
      ok: false,
      message: "Release date must use YYYY-MM-DD.",
    };
  }

  return { ok: true };
}

export function isBookMetadataDraftEmpty(draft: BookMetadataDraft): boolean {
  return (
    draft.title.trim() === "" &&
    normalizeMetadataAuthorsText(draft.authorsText).length === 0 &&
    draft.description.trim() === "" &&
    draft.publisher.trim() === "" &&
    draft.releaseDate.trim() === "" &&
    draft.language.trim() === "" &&
    draft.url.trim() === "" &&
    draft.asin.trim() === "" &&
    draft.coverUrl.trim() === ""
  );
}

export function parseBookMetadataImport(
  value: string,
): { ok: true; patch: BookMetadataImportPatch } | { ok: false; message: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return {
      ok: false,
      message: "Metadata JSON must be valid JSON.",
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      message: "Metadata JSON must be an object.",
    };
  }

  const record = parsed as Record<string, unknown>;
  const patch: BookMetadataImportPatch = {};

  const assignNullableString = (key: NullableStringImportKey) => {
    if (!(key in record)) {
      return;
    }
    const value = record[key];
    if (value !== null && typeof value !== "string") {
      throw new Error(`"${key}" must be a string or null.`);
    }
    patch[key] = value as string | null;
  };

  try {
    assignNullableString("title");
    assignNullableString("description");
    assignNullableString("publisher");
    assignNullableString("releaseDate");
    assignNullableString("language");
    assignNullableString("url");
    assignNullableString("asin");
    assignNullableString("coverUrl");

    if ("authors" in record) {
      const authors = record.authors;
      if (authors === null) {
        patch.authors = null;
      } else if (Array.isArray(authors) && authors.every((author) => typeof author === "string")) {
        patch.authors = authors;
      } else {
        throw new Error('"authors" must be an array of strings or null.');
      }
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Metadata JSON is invalid.",
    };
  }

  return { ok: true, patch };
}

export function applyBookMetadataImport(
  draft: BookMetadataDraft,
  patch: BookMetadataImportPatch,
): BookMetadataDraft {
  return {
    title: patch.title === undefined ? draft.title : (patch.title ?? ""),
    authorsText:
      patch.authors === undefined
        ? draft.authorsText
        : patch.authors === null
          ? ""
          : joinMetadataAuthors(normalizeMetadataAuthorsText(patch.authors.join("\n"))),
    description: patch.description === undefined ? draft.description : (patch.description ?? ""),
    publisher: patch.publisher === undefined ? draft.publisher : (patch.publisher ?? ""),
    releaseDate: patch.releaseDate === undefined ? draft.releaseDate : (patch.releaseDate ?? ""),
    language: patch.language === undefined ? draft.language : (patch.language ?? ""),
    url: patch.url === undefined ? draft.url : (patch.url ?? ""),
    asin: patch.asin === undefined ? draft.asin : (patch.asin ?? ""),
    coverUrl: patch.coverUrl === undefined ? draft.coverUrl : (patch.coverUrl ?? ""),
  };
}
