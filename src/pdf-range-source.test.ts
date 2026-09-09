import { describe, expect, it, vi } from "vitest";
import {
  createPdfRangeTransport,
  fetchByteRange,
  parseContentRangeTotal,
  PDF_RANGE_MAX_BYTES,
  probePdfRangeSource,
  rangeHeaderValue,
  type FetchLike,
  type PdfRangeTransportLike,
} from "./pdf-range-source";

function rangeResponse(body: Uint8Array, contentRange: string | null, status = 206): Response {
  return {
    status,
    headers: {
      get: (name: string) => (name.toLowerCase() === "content-range" ? contentRange : null),
    },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  } as unknown as Response;
}

/** Stand-in for PDF.js's `PDFDataRangeTransport`. */
class FakeTransport implements PdfRangeTransportLike {
  readonly received: Array<{ begin: number; chunk: Uint8Array }> = [];

  constructor(
    readonly length: number,
    readonly initialData: Uint8Array,
    readonly progressiveDone?: boolean,
  ) {}

  requestDataRange(_begin: number, _end: number): void {
    throw new Error("not wired");
  }

  abort(): void {}

  onDataRange(begin: number, chunk: Uint8Array): void {
    this.received.push({ begin, chunk });
  }
}

describe("parseContentRangeTotal", () => {
  it("reads the total from a served range", () => {
    expect(parseContentRangeTotal("bytes 0-65535/126422171")).toBe(126422171);
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseContentRangeTotal("  bytes 10-19/40 ")).toBe(40);
  });

  it("rejects a missing header", () => {
    expect(parseContentRangeTotal(null)).toBeNull();
    expect(parseContentRangeTotal(undefined)).toBeNull();
  });

  it("rejects the unsatisfied-range form, which serves no bytes", () => {
    expect(parseContentRangeTotal("bytes */126422171")).toBeNull();
  });

  it("rejects an unknown total", () => {
    expect(parseContentRangeTotal("bytes 0-9/*")).toBeNull();
  });

  it("rejects a zero total", () => {
    expect(parseContentRangeTotal("bytes 0-0/0")).toBeNull();
  });
});

describe("rangeHeaderValue", () => {
  it("converts PDF.js's half-open range to an inclusive one", () => {
    expect(rangeHeaderValue(0, 65536)).toBe("bytes=0-65535");
    expect(rangeHeaderValue(131072, 196608)).toBe("bytes=131072-196607");
  });

  it("never emits an end before the start", () => {
    expect(rangeHeaderValue(5, 5)).toBe("bytes=5-5");
  });
});

describe("probePdfRangeSource", () => {
  it("reports the document length and keeps the probed bytes", async () => {
    const body = new Uint8Array([1, 2, 3, 4]);
    const fetchImpl = vi.fn<FetchLike>(async () => rangeResponse(body, "bytes 0-3/4096"));

    const source = await probePdfRangeSource("asset://localhost/book.pdf", fetchImpl, 8);

    expect(source).toEqual({ length: 4096, initialChunk: body });
    expect(fetchImpl).toHaveBeenCalledWith("asset://localhost/book.pdf", {
      headers: { Range: "bytes=0-7" },
    });
  });

  it("probes one PDF.js chunk by default", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () =>
      rangeResponse(new Uint8Array(4), "bytes 0-3/4096"),
    );

    await probePdfRangeSource("u", fetchImpl);

    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toEqual({ Range: "bytes=0-65535" });
  });

  it("declines a source that ignores the range and returns the whole file", async () => {
    const fetchImpl: FetchLike = async () => rangeResponse(new Uint8Array([1]), null, 200);

    await expect(probePdfRangeSource("u", fetchImpl)).resolves.toBeNull();
  });

  it("declines a 206 without a usable Content-Range", async () => {
    const fetchImpl: FetchLike = async () => rangeResponse(new Uint8Array([1]), "bytes 0-0/*");

    await expect(probePdfRangeSource("u", fetchImpl)).resolves.toBeNull();
  });

  it("declines a 206 whose body is longer than the range asked for", async () => {
    const fetchImpl: FetchLike = async () =>
      rangeResponse(new Uint8Array([1, 2, 3, 4]), "bytes 0-3/4096");

    await expect(probePdfRangeSource("u", fetchImpl, 2)).resolves.toBeNull();
  });

  it("declines when the request itself fails", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("scheme not handled");
    };

    await expect(probePdfRangeSource("u", fetchImpl)).resolves.toBeNull();
  });

  it("declines when the body cannot be read", async () => {
    const fetchImpl: FetchLike = async () =>
      ({
        status: 206,
        headers: { get: () => "bytes 0-3/4096" },
        arrayBuffer: async () => {
          throw new Error("stream closed");
        },
      }) as unknown as Response;

    await expect(probePdfRangeSource("u", fetchImpl)).resolves.toBeNull();
  });
});

describe("fetchByteRange", () => {
  it("asks for the whole range when it fits in one request", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () =>
      rangeResponse(new Uint8Array(100).fill(3), "bytes 0-99/4096"),
    );

    const bytes = await fetchByteRange("u", 0, 100, fetchImpl);

    expect(bytes).toHaveLength(100);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toEqual({ Range: "bytes=0-99" });
  });

  it("splits a range larger than the per-request cap", async () => {
    const asked: string[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      asked.push(headers.Range ?? "");
      return rangeResponse(new Uint8Array(PDF_RANGE_MAX_BYTES).fill(1), null);
    };

    const bytes = await fetchByteRange("u", 0, PDF_RANGE_MAX_BYTES + 10, fetchImpl);

    expect(bytes).toHaveLength(PDF_RANGE_MAX_BYTES + 10);
    expect(asked).toEqual([
      `bytes=0-${PDF_RANGE_MAX_BYTES - 1}`,
      `bytes=${PDF_RANGE_MAX_BYTES}-${PDF_RANGE_MAX_BYTES + 9}`,
    ]);
  });

  it("follows a response that carried fewer bytes than were asked for", async () => {
    const asked: string[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      asked.push(headers.Range ?? "");
      // Every response is truncated to 10 bytes, whatever was requested.
      return rangeResponse(new Uint8Array(10).fill(2), null);
    };

    const bytes = await fetchByteRange("u", 100, 125, fetchImpl);

    expect(Array.from(bytes)).toEqual(Array.from(new Uint8Array(25).fill(2)));
    expect(asked).toEqual(["bytes=100-124", "bytes=110-124", "bytes=120-124"]);
  });

  it("keeps a response that overshot from overflowing the range", async () => {
    const fetchImpl: FetchLike = async () => rangeResponse(new Uint8Array(50).fill(4), null);

    const bytes = await fetchByteRange("u", 0, 8, fetchImpl);

    expect(Array.from(bytes)).toEqual(Array.from(new Uint8Array(8).fill(4)));
  });

  it("takes its slice out of a whole-file response that ignored the range", async () => {
    const whole = Uint8Array.from({ length: 20 }, (_, index) => index);
    const fetchImpl: FetchLike = async () => rangeResponse(whole, null, 200);

    const bytes = await fetchByteRange("u", 4, 8, fetchImpl);

    expect(Array.from(bytes)).toEqual([4, 5, 6, 7]);
  });

  it("gives up rather than loop forever on an empty response", async () => {
    const fetchImpl: FetchLike = async () => rangeResponse(new Uint8Array(0), null);

    await expect(fetchByteRange("u", 0, 8, fetchImpl)).rejects.toThrow("empty response");
  });

  it("makes no request for an empty range", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => rangeResponse(new Uint8Array(1), null));

    await expect(fetchByteRange("u", 7, 7, fetchImpl)).resolves.toHaveLength(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("createPdfRangeTransport", () => {
  const source = { length: 4096, initialChunk: new Uint8Array([9, 9]) };

  it("hands PDF.js the probed head and declares the sequential read finished", () => {
    const transport = createPdfRangeTransport(FakeTransport, "u", source, async () => {
      throw new Error("unused");
    });

    expect(transport.length).toBe(4096);
    expect(transport.initialData).toBe(source.initialChunk);
    expect(transport.progressiveDone).toBe(true);
  });

  it("answers a range request with the fetched bytes", async () => {
    const body = new Uint8Array(64).fill(7);
    const fetchImpl = vi.fn<FetchLike>(async () => rangeResponse(body, "bytes 64-127/4096"));
    const transport = createPdfRangeTransport(FakeTransport, "u", source, fetchImpl);

    transport.requestDataRange(64, 128);
    await vi.waitFor(() => expect(transport.received).toHaveLength(1));

    expect(transport.received[0]?.begin).toBe(64);
    expect(Array.from(transport.received[0]?.chunk ?? [])).toEqual(Array.from(body));
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toEqual({ Range: "bytes=64-127" });
  });

  it("reports a failed range instead of handing PDF.js wrong bytes", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const transport = createPdfRangeTransport(FakeTransport, "u", source, async () => {
      throw new Error("read error");
    });

    transport.requestDataRange(0, 64);
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());

    expect(transport.received).toHaveLength(0);
    warn.mockRestore();
  });

  it("cancels in-flight requests on abort and ignores what they return", async () => {
    let signal: AbortSignal | undefined;
    const transport = createPdfRangeTransport(FakeTransport, "u", source, async (_url, init) => {
      signal = init?.signal ?? undefined;
      return rangeResponse(new Uint8Array(64).fill(1), "bytes 0-63/4096");
    });

    transport.requestDataRange(0, 64);
    transport.abort();
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));

    expect(transport.received).toHaveLength(0);
  });

  it("stops issuing requests once aborted", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () =>
      rangeResponse(new Uint8Array(64).fill(1), "bytes 0-63/4096"),
    );
    const transport = createPdfRangeTransport(FakeTransport, "u", source, fetchImpl);

    transport.abort();
    transport.requestDataRange(0, 64);

    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
