export type PdfAnnotationRecord = Record<string, unknown>;

export type PdfLinkResolver = {
  numPages: number;
  getDestination?: (destinationId: string) => Promise<unknown>;
  getPageIndex?: (pageRef: unknown) => Promise<number>;
};

export type ResolvedPdfLinkTarget =
  | {
      type: "external";
      url: string;
    }
  | {
      type: "internal";
      pageNumber: number;
    };

function parsePdfHashPageNumber(value: string) {
  const matchedPage = value.match(/(?:^|[#?&])page=(\d+)/i);
  if (!matchedPage || matchedPage[1] === undefined) {
    return null;
  }

  const pageNumber = Number.parseInt(matchedPage[1], 10);
  return Number.isFinite(pageNumber) && pageNumber >= 1 ? pageNumber : null;
}

function clampPageNumber(pageNumber: number, numPages: number) {
  return Math.min(Math.max(Math.trunc(pageNumber), 1), Math.max(numPages, 1));
}

async function resolveDestinationPageNumber(
  destination: unknown,
  resolver: PdfLinkResolver,
): Promise<number | null> {
  let explicitDestination: unknown = destination;

  if (typeof destination === "string") {
    if (!resolver.getDestination) {
      return null;
    }

    explicitDestination = await resolver.getDestination(destination);
  }

  if (!Array.isArray(explicitDestination) || explicitDestination.length === 0) {
    return null;
  }

  const [firstEntry] = explicitDestination;
  if (typeof firstEntry === "number" && Number.isFinite(firstEntry)) {
    return clampPageNumber(firstEntry + 1, resolver.numPages);
  }

  if (firstEntry && typeof firstEntry === "object" && resolver.getPageIndex) {
    const pageIndex = await resolver.getPageIndex(firstEntry);
    return clampPageNumber(pageIndex + 1, resolver.numPages);
  }

  return null;
}

function resolveNamedActionPageNumber(
  action: unknown,
  currentPageNumber: number,
  numPages: number,
) {
  if (typeof action !== "string") {
    return null;
  }

  switch (action) {
    case "NextPage":
      return clampPageNumber(currentPageNumber + 1, numPages);
    case "PrevPage":
      return clampPageNumber(currentPageNumber - 1, numPages);
    case "FirstPage":
      return 1;
    case "LastPage":
      return Math.max(numPages, 1);
    default:
      return null;
  }
}

export async function resolvePdfLinkTarget(
  annotation: PdfAnnotationRecord,
  currentPageNumber: number,
  resolver: PdfLinkResolver,
): Promise<ResolvedPdfLinkTarget | null> {
  const maybeUrl =
    typeof annotation.url === "string"
      ? annotation.url
      : typeof annotation.unsafeUrl === "string"
        ? annotation.unsafeUrl
        : null;

  if (maybeUrl) {
    const pageNumber = parsePdfHashPageNumber(maybeUrl);
    if (pageNumber !== null) {
      return {
        type: "internal",
        pageNumber: clampPageNumber(pageNumber, resolver.numPages),
      };
    }

    return { type: "external", url: maybeUrl };
  }

  const destinationPage = await resolveDestinationPageNumber(annotation.dest, resolver);
  if (destinationPage !== null) {
    return { type: "internal", pageNumber: destinationPage };
  }

  const actionPage = resolveNamedActionPageNumber(
    annotation.action,
    currentPageNumber,
    resolver.numPages,
  );
  if (actionPage !== null) {
    return { type: "internal", pageNumber: actionPage };
  }

  return null;
}
