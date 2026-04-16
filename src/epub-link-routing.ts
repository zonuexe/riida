export type EpubLinkAction =
  | { kind: "external"; target: string }
  | { kind: "display"; target: string };

const EXTERNAL_PROTOCOL_PATTERN = /^(https?:|mailto:|tel:)/i;

function stripFragment(value: string) {
  const fragmentIndex = value.indexOf("#");
  return fragmentIndex >= 0 ? value.slice(0, fragmentIndex) : value;
}

export function resolveEpubLinkAction(
  href: string,
  currentSectionHref: string | null,
): EpubLinkAction | null {
  const trimmedHref = href.trim();
  if (!trimmedHref || /^javascript:/i.test(trimmedHref)) {
    return null;
  }

  if (EXTERNAL_PROTOCOL_PATTERN.test(trimmedHref)) {
    return { kind: "external", target: trimmedHref };
  }

  const baseSectionHref = stripFragment(currentSectionHref ?? "");
  if (trimmedHref.startsWith("#")) {
    if (!baseSectionHref) {
      return null;
    }
    return {
      kind: "display",
      target: `${baseSectionHref}${trimmedHref}`,
    };
  }

  try {
    const baseUrl = new URL(baseSectionHref || "/", "https://riida.invalid/");
    const resolvedUrl = new URL(trimmedHref, baseUrl);
    const normalizedTarget = `${resolvedUrl.pathname.replace(/^\/+/, "")}${resolvedUrl.search}${resolvedUrl.hash}`;
    return normalizedTarget ? { kind: "display", target: normalizedTarget } : null;
  } catch {
    return { kind: "display", target: trimmedHref };
  }
}
