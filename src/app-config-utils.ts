type PdfRenderer = "native" | "pdfjs";

export type AppConfigDraft = {
  libraryRoots: string[];
  excludedPatterns: string[];
  pdfRenderer: PdfRenderer;
  enabledExternalSources: string[];
};

export function parseExcludedPatternsInput(value: string) {
  return value
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function addLibraryRoot(libraryRoots: string[], selectedRoot: string) {
  return [...new Set([...libraryRoots, selectedRoot])];
}

export function buildAppConfigDraft(
  libraryRoots: string[],
  excludedPatternsInput: string,
  pdfRenderer: string | null | undefined,
  enabledExternalSources: string[],
): AppConfigDraft {
  return {
    libraryRoots: [...libraryRoots],
    excludedPatterns: parseExcludedPatternsInput(excludedPatternsInput),
    pdfRenderer: pdfRenderer === "pdfjs" ? "pdfjs" : "native",
    enabledExternalSources: [...enabledExternalSources],
  };
}
