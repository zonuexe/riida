import { describe, expect, it, vi } from "vitest";
import { resolvePdfLinkTarget } from "./pdf-link-utils";

describe("resolvePdfLinkTarget", () => {
  it("returns external urls unchanged", async () => {
    await expect(
      resolvePdfLinkTarget({ url: "https://example.com" }, 4, {
        numPages: 10,
      }),
    ).resolves.toEqual({
      type: "external",
      url: "https://example.com",
    });
  });

  it("treats hash page urls as internal links", async () => {
    await expect(
      resolvePdfLinkTarget({ unsafeUrl: "#page=7" }, 1, {
        numPages: 10,
      }),
    ).resolves.toEqual({
      type: "internal",
      pageNumber: 7,
    });
  });

  it("resolves named destinations through the pdf document", async () => {
    const getDestination = vi.fn<() => Promise<unknown[]>>(async () => [
      { num: 42, gen: 0 },
      { name: "XYZ" },
    ]);
    const getPageIndex = vi.fn<() => Promise<number>>(async () => 5);

    await expect(
      resolvePdfLinkTarget({ dest: "chapter-2" }, 1, {
        numPages: 10,
        getDestination,
        getPageIndex,
      }),
    ).resolves.toEqual({
      type: "internal",
      pageNumber: 6,
    });

    expect(getDestination).toHaveBeenCalledWith("chapter-2");
    expect(getPageIndex).toHaveBeenCalled();
  });

  it("supports explicit destination arrays with numeric page indices", async () => {
    await expect(
      resolvePdfLinkTarget({ dest: [2, { name: "XYZ" }] }, 1, {
        numPages: 10,
      }),
    ).resolves.toEqual({
      type: "internal",
      pageNumber: 3,
    });
  });

  it("maps named actions to internal page jumps", async () => {
    await expect(
      resolvePdfLinkTarget({ action: "NextPage" }, 4, {
        numPages: 10,
      }),
    ).resolves.toEqual({
      type: "internal",
      pageNumber: 5,
    });

    await expect(
      resolvePdfLinkTarget({ action: "LastPage" }, 4, {
        numPages: 10,
      }),
    ).resolves.toEqual({
      type: "internal",
      pageNumber: 10,
    });
  });

  it("returns null for annotations without a supported destination", async () => {
    await expect(
      resolvePdfLinkTarget({ subtype: "Link" }, 1, {
        numPages: 10,
      }),
    ).resolves.toBeNull();
  });
});
