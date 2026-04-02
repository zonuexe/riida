export type TagValidationResult = { ok: true; value: string } | { ok: false; message: string };

export function validateTagValue(value: string): TagValidationResult {
  const candidate = value.trim();

  if (!candidate) {
    return { ok: false, message: "Tags cannot be empty." };
  }

  if (
    candidate === "/" ||
    candidate.startsWith("/") ||
    candidate.endsWith("/") ||
    candidate.includes("//")
  ) {
    return {
      ok: false,
      message: "Tags cannot start or end with '/', be just '/', or contain '//'.",
    };
  }

  return { ok: true, value: candidate };
}
