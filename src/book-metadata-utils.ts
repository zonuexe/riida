export type BookMetadataDraft = {
  title: string;
  authorsText: string;
  description: string;
  publisher: string;
  releaseDate: string;
  language: string;
  url: string;
  asin: string;
};

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
