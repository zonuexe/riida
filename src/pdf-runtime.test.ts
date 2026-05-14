import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TauriBinaryDataFactory } from "./pdf-runtime";

describe("TauriBinaryDataFactory", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn<typeof fetch>() as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("fetches the resource at baseUrl + filename for the requested kind", async () => {
    const buffer = new Uint8Array([1, 2, 3]).buffer;
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => buffer,
    } as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const factory = new TauriBinaryDataFactory({
      cMapUrl: "asset://cmaps/",
      standardFontDataUrl: "asset://fonts/",
      wasmUrl: "asset://wasm/",
    });
    const result = await factory.fetch({ kind: "cMapUrl", filename: "Adobe-Japan1-UCS2.bcmap" });

    expect(fetchMock).toHaveBeenCalledWith("asset://cmaps/Adobe-Japan1-UCS2.bcmap");
    expect(Array.from(result)).toEqual([1, 2, 3]);
  });

  it("throws when the kind's base URL is not configured", async () => {
    const factory = new TauriBinaryDataFactory({});
    await expect(
      factory.fetch({ kind: "standardFontDataUrl", filename: "FoxitSerif.pfb" }),
    ).rejects.toThrow(/standardFontDataUrl/);
  });

  it("wraps fetch network errors with the resolved URL", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const factory = new TauriBinaryDataFactory({ wasmUrl: "asset://wasm/" });
    await expect(factory.fetch({ kind: "wasmUrl", filename: "openjpeg.wasm" })).rejects.toThrow(
      /asset:\/\/wasm\/openjpeg.wasm/,
    );
  });

  it("surfaces non-OK HTTP responses", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue({
      ok: false,
      status: 404,
      arrayBuffer: async () => new ArrayBuffer(0),
    } as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const factory = new TauriBinaryDataFactory({ cMapUrl: "asset://cmaps/" });
    await expect(factory.fetch({ kind: "cMapUrl", filename: "missing.bcmap" })).rejects.toThrow(
      /HTTP 404/,
    );
  });
});
