// Range-loaded PDF sources.
//
// Left to itself, PDF.js downloads a whole PDF before it can show page one:
// Tauri's asset protocol only advertises `Accept-Ranges` on responses to
// requests that already carried a `Range` header, so PDF.js's own range
// probing concludes the source does not support ranges and falls back to a
// full read. The worker then keeps the entire file resident — plus a second
// copy while it concatenates the streamed chunks — which for a scanned book
// is hundreds of megabytes that reading twenty pages never touches.
//
// The protocol does serve ranges, though; it just does not say so up front.
// So we ask for one ourselves and, if a 206 comes back, drive PDF.js through
// `PDFDataRangeTransport`, which asks for the byte ranges it actually needs.
// When the probe fails — an unexpected protocol, an older Tauri, a source
// that genuinely cannot seek — the caller keeps the plain full-read path, so
// this is an optimisation and never a new way for a document to fail to open.
//
// Nothing here imports PDF.js: the transport is reached through the structural
// type below and the base class is passed in, so all of it is testable.

/** The slice of PDF.js's `PDFDataRangeTransport` this module drives. */
export type PdfRangeTransportLike = {
  /** Called by PDF.js when it needs `[begin, end)`; answers via `onDataRange`. */
  requestDataRange: (begin: number, end: number) => void;
  /** Called by PDF.js when it abandons the document. */
  abort: () => void;
  /** Hands a fetched range back to PDF.js. */
  onDataRange: (begin: number, chunk: Uint8Array) => void;
};

/** Constructor shape of PDF.js's `PDFDataRangeTransport`. */
export type PdfRangeTransportConstructor<T extends PdfRangeTransportLike = PdfRangeTransportLike> =
  new (
    length: number,
    initialData: Uint8Array,
    progressiveDone?: boolean,
    contentDispositionFilename?: string,
  ) => T;

export type PdfRangeSource = {
  /** Total size of the document in bytes, from the probe's `Content-Range`. */
  length: number;
  /** The bytes the probe already fetched, handed to PDF.js as its first chunk. */
  initialChunk: Uint8Array;
};

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Bytes fetched by the probe. One PDF.js chunk (64 KB) is enough to cover the
 * header and, in a linearized file, the first-page cross-reference, while
 * staying small enough that the probe costs nothing when it fails.
 */
const PDF_RANGE_PROBE_BYTES = 65536;

/**
 * Largest range asked for in one request.
 *
 * PDF.js merges the contiguous chunks it is missing into a single request, so
 * one call can ask for several megabytes — a full-page scan image, say. Tauri's
 * asset protocol truncates any single range to 1,024,000 bytes and reports the
 * shortened extent in `Content-Range`, and PDF.js treats the first chunk it
 * receives as the whole answer, so a truncated response would leave the range
 * permanently unsatisfied and stall the page. Requesting no more than the cap,
 * and looping on whatever each response actually returns, keeps that from
 * depending on the exact limit.
 */
export const PDF_RANGE_MAX_BYTES = 1024000;

/**
 * Total length from a `Content-Range: bytes <first>-<last>/<total>` header.
 * Returns `null` for a missing header, for the unsatisfied-range form (which
 * names the total but no served range), or for an unknown total.
 */
export function parseContentRangeTotal(header: string | null | undefined): number | null {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/.exec((header ?? "").trim());
  if (!match) {
    return null;
  }
  const total = Number(match[3]);
  return Number.isSafeInteger(total) && total > 0 ? total : null;
}

/** The `Range` header value for PDF.js's half-open `[begin, end)` request. */
export function rangeHeaderValue(begin: number, end: number): string {
  return `bytes=${begin}-${Math.max(end - 1, begin)}`;
}

/**
 * Ask `url` for its first bytes and report whether it serves ranges.
 *
 * A `206` with a parseable `Content-Range` means the source can seek, and the
 * body doubles as PDF.js's initial chunk. Anything else — a `200` with the
 * whole file, an error, a short read — returns `null`, and the caller loads
 * the document the ordinary way.
 */
export async function probePdfRangeSource(
  url: string,
  fetchImpl: FetchLike,
  probeBytes: number = PDF_RANGE_PROBE_BYTES,
): Promise<PdfRangeSource | null> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Range: rangeHeaderValue(0, probeBytes) },
    });
  } catch {
    return null;
  }
  if (response.status !== 206) {
    return null;
  }
  const length = parseContentRangeTotal(response.headers.get("content-range"));
  if (length === null) {
    return null;
  }
  let initialChunk: Uint8Array;
  try {
    initialChunk = new Uint8Array(await response.arrayBuffer());
  } catch {
    return null;
  }
  // A source that answers 206 but returns the whole file is not seeking; using
  // it as a range transport would defeat the point.
  if (initialChunk.length > probeBytes) {
    return null;
  }
  return { length, initialChunk };
}

/**
 * Read `[begin, end)` of `url`, in as many requests as the source needs.
 *
 * Each response advances the cursor by however many bytes it actually carried,
 * so a source that serves less than was asked for is followed rather than
 * trusted, and the assembled result is exactly the requested extent.
 */
export async function fetchByteRange(
  url: string,
  begin: number,
  end: number,
  fetchImpl: FetchLike,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const total = Math.max(end - begin, 0);
  const buffer = new Uint8Array(total);
  let filled = 0;
  while (filled < total) {
    const from = begin + filled;
    const to = Math.min(end, from + PDF_RANGE_MAX_BYTES);
    const response = await fetchImpl(url, {
      headers: { Range: rangeHeaderValue(from, to) },
      signal,
    });
    const part = new Uint8Array(await response.arrayBuffer());
    if (response.status === 200) {
      // The range was ignored and the whole file came back, so the body starts
      // at 0 rather than at `from`; take the slice that was asked for.
      return part.slice(begin, end);
    }
    if (part.length === 0) {
      throw new Error(`empty response for bytes ${from}-${to - 1}`);
    }
    // A source that ignored the range and sent more than was asked for would
    // otherwise overflow the buffer.
    buffer.set(part.subarray(0, total - filled), filled);
    filled += part.length;
  }
  return buffer;
}

/**
 * A `PDFDataRangeTransport` that answers PDF.js's range requests from `url`.
 *
 * `progressiveDone` is set because the probe's chunk is all the sequential
 * data there will be: everything after it arrives as a range. Requests are
 * tracked so `abort()` — PDF.js closing the document — cancels the ones still
 * in flight instead of leaving them to resolve into a dead transport.
 */
export function createPdfRangeTransport<T extends PdfRangeTransportLike>(
  Transport: PdfRangeTransportConstructor<T>,
  url: string,
  source: PdfRangeSource,
  fetchImpl: FetchLike,
): T {
  const transport = new Transport(source.length, source.initialChunk, true);
  const pending = new Set<AbortController>();
  let aborted = false;

  transport.requestDataRange = (begin: number, end: number): void => {
    if (aborted) {
      return;
    }
    const controller = new AbortController();
    pending.add(controller);
    void (async () => {
      try {
        const chunk = await fetchByteRange(url, begin, end, fetchImpl, controller.signal);
        if (!aborted) {
          transport.onDataRange(begin, chunk);
        }
      } catch (error) {
        // PDF.js has no way to be told a range failed; it waits on the reader
        // for this range, so the document stalls rather than showing a wrong
        // page. Report it so the cause is visible in the console.
        if (!aborted) {
          console.warn(`[riida] PDF range ${begin}-${end} failed:`, error);
        }
      } finally {
        pending.delete(controller);
      }
    })();
  };

  transport.abort = (): void => {
    aborted = true;
    for (const controller of pending) {
      controller.abort();
    }
    pending.clear();
  };

  return transport;
}
