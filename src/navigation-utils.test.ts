import { describe, expect, it } from "vitest";
import { buildNavigationUrl, navigationStateSignature } from "./navigation-utils";

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
});
