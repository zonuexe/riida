type PdfRenderer = "native" | "pdfjs";
export type AppTheme = "default" | "snow-white" | "night-city" | "navy-blue";

export type AppConfigDraft = {
  libraryRoots: string[];
  excludedPatterns: string[];
  pdfRenderer: PdfRenderer;
  theme: AppTheme;
  enabledExternalSources: string[];
};

export function normalizeAppTheme(value: string | null | undefined): AppTheme {
  switch (value) {
    case "snow-white":
    case "night-city":
    case "navy-blue":
      return value;
    default:
      return "default";
  }
}

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
  theme: string | null | undefined,
  enabledExternalSources: string[],
): AppConfigDraft {
  return {
    libraryRoots: [...libraryRoots],
    excludedPatterns: parseExcludedPatternsInput(excludedPatternsInput),
    pdfRenderer: pdfRenderer === "pdfjs" ? "pdfjs" : "native",
    theme: normalizeAppTheme(theme),
    enabledExternalSources: [...enabledExternalSources],
  };
}
