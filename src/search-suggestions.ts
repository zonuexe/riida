import { normalizeSearchText } from "./library-utils";

const FIELD_NAMES = [
  "author:",
  "file:",
  "lang:",
  "path:",
  "publisher:",
  "read:",
  "source:",
  "tag:",
  "title:",
];

const READ_VALUE_SUGGESTIONS = ["today", "week", "month", "year", "never"];

export type SearchSuggestion =
  | { kind: "field"; completion: string }
  | { kind: "value"; field: string; completion: string };

type ValueSource = {
  publisher: string[];
  author: string[];
  lang: string[];
  tag: string[];
  source: string[];
};

export function buildValueSource(
  books: Array<{
    publisher?: string | null;
    authors?: string[];
    language?: string | null;
    tags?: string[];
    sourceType?: string;
  }>,
): ValueSource {
  const publishers = new Set<string>();
  const authors = new Set<string>();
  const langs = new Set<string>();
  const tags = new Set<string>();
  const sources = new Set<string>();

  for (const book of books) {
    if (book.publisher) publishers.add(book.publisher);
    for (const a of book.authors ?? []) authors.add(a);
    if (book.language) langs.add(book.language);
    for (const t of book.tags ?? []) tags.add(t);
    if (book.sourceType) sources.add(book.sourceType);
  }

  const sorted = (s: Set<string>) => [...s].sort((a, b) => a.localeCompare(b, "ja"));
  return {
    publisher: sorted(publishers),
    author: sorted(authors),
    lang: sorted(langs),
    tag: sorted(tags),
    source: sorted(sources),
  };
}

// Returns the token fragment the cursor is currently inside, and its start offset.
function activeFragment(value: string, cursorPos: number): { start: number; text: string } {
  let start = cursorPos;
  while (start > 0 && value[start - 1] !== " ") start--;
  return { start, text: value.slice(start, cursorPos) };
}

export function computeSuggestions(
  value: string,
  cursorPos: number,
  valueSource: ValueSource,
  limit = 8,
): SearchSuggestion[] {
  const { text: fragment } = activeFragment(value, cursorPos);

  // Strip leading negation for matching but remember it
  const bare = fragment.startsWith("-") ? fragment.slice(1) : fragment;

  const colonIdx = bare.indexOf(":");
  if (colonIdx > 0) {
    // field:valuePrefix — suggest known values
    const field = bare.slice(0, colonIdx).toLowerCase();
    const valuePrefix = bare.slice(colonIdx + 1);

    // read: uses a fixed set of keyword suggestions
    if (field === "read") {
      const q = valuePrefix.toLowerCase();
      return READ_VALUE_SUGGESTIONS.filter((v) => v.startsWith(q) && v !== q).map((v) => ({
        kind: "value" as const,
        field,
        completion: v,
      }));
    }

    const knownValues: string[] | undefined = valueSource[field as keyof ValueSource];
    if (!knownValues) return [];
    const q = normalizeSearchText(valuePrefix);
    return knownValues
      .map((v) => {
        const norm = normalizeSearchText(v);
        const idx = norm.indexOf(q);
        return { v, idx };
      })
      .filter(({ idx }) => idx >= 0)
      .sort((a, b) => a.idx - b.idx || a.v.localeCompare(b.v, "ja"))
      .slice(0, limit)
      .map(({ v }) => ({ kind: "value" as const, field, completion: v }));
  }

  // No colon — suggest field names by prefix
  if (!bare) return [];
  const q = bare.toLowerCase();
  return FIELD_NAMES.filter((f) => f.startsWith(q) && f !== q)
    .slice(0, limit)
    .map((f) => ({ kind: "field" as const, completion: f }));
}

// Applies a suggestion to the current input value, returns the new value and cursor pos.
export function applySuggestion(
  value: string,
  cursorPos: number,
  suggestion: SearchSuggestion,
): { value: string; cursor: number } {
  const { start, text: fragment } = activeFragment(value, cursorPos);
  const negated = fragment.startsWith("-");

  let replacement: string;
  if (suggestion.kind === "field") {
    replacement = (negated ? "-" : "") + suggestion.completion;
  } else {
    const colonIdx = fragment.indexOf(":");
    const fieldPart = colonIdx >= 0 ? fragment.slice(0, colonIdx + 1) : "";
    const needsQuotes = suggestion.completion.includes(" ");
    const quoted = needsQuotes ? `"${suggestion.completion}"` : suggestion.completion;
    replacement = fieldPart + quoted;
  }

  const newValue = value.slice(0, start) + replacement + value.slice(cursorPos);
  return { value: newValue, cursor: start + replacement.length };
}
