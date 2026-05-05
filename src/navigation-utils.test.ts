import { describe, expect, it } from "vitest";
import {
  buildNavigationUrl,
  navigationStateSignature,
  parsePdfPageQueryParam,
} from "./navigation-utils";

describe("navigationStateSignature", () => {
  it("ignores historyIndex when comparing navigation state meaning", () => {
    const first = navigationStateSignature({
      historyIndex: 0,
      bookFilePath: "/Books/book.pdf",
      activeDirectory: "/Books",
      activeTag: "tech",
      activeExternalSource: "kindle",
      activeTagDirectOnly: false,
      searchQuery: "rust",
    });
    const second = navigationStateSignature({
      historyIndex: 8,
      bookFilePath: "/Books/book.pdf",
      activeDirectory: "/Books",
      activeTag: "tech",
      activeExternalSource: "kindle",
      activeTagDirectOnly: false,
      searchQuery: "rust",
    });

    expect(first).toBe(second);
  });

  it("differentiates entries by pdfPage", () => {
    const base = {
      historyIndex: 0,
      bookFilePath: "/Books/book.pdf",
      activeDirectory: null,
      activeTag: null,
      activeExternalSource: null,
      activeTagDirectOnly: false,
      searchQuery: "",
    } as const;

    expect(navigationStateSignature({ ...base, pdfPage: 12 })).not.toBe(
      navigationStateSignature({ ...base, pdfPage: 34 }),
    );
  });
});

describe("buildNavigationUrl", () => {
  it("returns root for the empty navigation state", () => {
    expect(
      buildNavigationUrl({
        historyIndex: 0,
        bookFilePath: null,
        activeDirectory: null,
        activeTag: null,
        activeExternalSource: null,
        activeTagDirectOnly: false,
        searchQuery: "",
      }),
    ).toBe("/");
  });

  it("serializes search, directory, and book into query parameters", () => {
    expect(
      buildNavigationUrl({
        historyIndex: 3,
        bookFilePath: "/Books/Tech/Rust Book.pdf",
        activeDirectory: "/Books/Tech",
        activeTag: "tech",
        activeExternalSource: "kindle",
        activeTagDirectOnly: true,
        searchQuery: "rust patterns",
      }),
    ).toBe(
      "/?q=rust+patterns&dir=%2FBooks%2FTech&tag=tech&source=kindle&tagMode=direct&book=%2FBooks%2FTech%2FRust+Book.pdf",
    );
  });

  it("includes pdfPage when set to a positive integer", () => {
    expect(
      buildNavigationUrl({
        historyIndex: 0,
        bookFilePath: "/Books/book.pdf",
        pdfPage: 42,
        activeDirectory: null,
        activeTag: null,
        activeExternalSource: null,
        activeTagDirectOnly: false,
        searchQuery: "",
      }),
    ).toBe("/?book=%2FBooks%2Fbook.pdf&page=42");
  });

  it("omits pdfPage when zero, negative, or absent", () => {
    expect(
      buildNavigationUrl({
        historyIndex: 0,
        bookFilePath: "/Books/book.pdf",
        pdfPage: 0,
        activeDirectory: null,
        activeTag: null,
        activeExternalSource: null,
        activeTagDirectOnly: false,
        searchQuery: "",
      }),
    ).toBe("/?book=%2FBooks%2Fbook.pdf");

    expect(
      buildNavigationUrl({
        historyIndex: 0,
        bookFilePath: "/Books/book.pdf",
        activeDirectory: null,
        activeTag: null,
        activeExternalSource: null,
        activeTagDirectOnly: false,
        searchQuery: "",
      }),
    ).toBe("/?book=%2FBooks%2Fbook.pdf");
  });
});

describe("parsePdfPageQueryParam", () => {
  it("returns the parsed page number for valid integer strings", () => {
    expect(parsePdfPageQueryParam("1")).toBe(1);
    expect(parsePdfPageQueryParam("42")).toBe(42);
  });

  it("rejects non-positive, non-integer, and absent values", () => {
    expect(parsePdfPageQueryParam(null)).toBeNull();
    expect(parsePdfPageQueryParam("")).toBeNull();
    expect(parsePdfPageQueryParam("0")).toBeNull();
    expect(parsePdfPageQueryParam("-1")).toBeNull();
    expect(parsePdfPageQueryParam("3.14")).toBeNull();
    expect(parsePdfPageQueryParam("abc")).toBeNull();
  });
});
