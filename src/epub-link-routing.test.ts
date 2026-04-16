import { describe, expect, it } from "vitest";
import { resolveEpubLinkAction } from "./epub-link-routing";

describe("resolveEpubLinkAction", () => {
  it("routes external links through the system opener", () => {
    expect(resolveEpubLinkAction("https://example.com/docs", "Text/chapter-1.xhtml")).toEqual({
      kind: "external",
      target: "https://example.com/docs",
    });
    expect(resolveEpubLinkAction("mailto:reader@example.com", "Text/chapter-1.xhtml")).toEqual({
      kind: "external",
      target: "mailto:reader@example.com",
    });
  });

  it("keeps same-section anchors on the current spine item", () => {
    expect(resolveEpubLinkAction("#footnote-3", "Text/chapter-1.xhtml")).toEqual({
      kind: "display",
      target: "Text/chapter-1.xhtml#footnote-3",
    });
  });

  it("resolves relative spine links against the current section", () => {
    expect(
      resolveEpubLinkAction("../appendix/notes.xhtml#ref-2", "Text/chapters/chapter-1.xhtml"),
    ).toEqual({
      kind: "display",
      target: "Text/appendix/notes.xhtml#ref-2",
    });
  });

  it("drops javascript pseudo-links", () => {
    expect(resolveEpubLinkAction("javascript:void(0)", "Text/chapter-1.xhtml")).toBeNull();
  });
});
