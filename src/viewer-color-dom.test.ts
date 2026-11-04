// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { applyEpubColorsToDocument, applyPdfViewerBackground } from "./viewer-color-dom";
import { viewerColorPaletteForMode } from "./viewer-settings-utils";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("applyPdfViewerBackground", () => {
  it("paints the main pane with the preset's background", () => {
    document.body.innerHTML = `<section id="main-pane"></section>`;
    applyPdfViewerBackground("night-city", "default");
    const expected = document.createElement("div");
    expected.style.backgroundColor = viewerColorPaletteForMode("night-city", "default").background;
    expect(document.querySelector<HTMLElement>("#main-pane")?.style.backgroundColor).toBe(
      expected.style.backgroundColor,
    );
  });

  it("clears the override for inherit-theme", () => {
    document.body.innerHTML = `<section id="main-pane" style="background-color: red"></section>`;
    applyPdfViewerBackground("inherit-theme", "default");
    expect(document.querySelector<HTMLElement>("#main-pane")?.style.backgroundColor).toBe("");
  });

  it("does nothing without a main pane", () => {
    expect(() => applyPdfViewerBackground("night-city", "default")).not.toThrow();
  });
});

describe("applyEpubColorsToDocument", () => {
  it("forces background, text and link colours with !important", () => {
    const doc = document.implementation.createHTMLDocument("section");
    doc.body.innerHTML = `<p>text <a href="#x">link</a> <a>no href</a></p>`;
    const palette = viewerColorPaletteForMode("navy-blue", "default");

    applyEpubColorsToDocument(doc, palette);

    for (const el of [doc.documentElement, doc.body]) {
      expect(el.style.getPropertyPriority("background-color")).toBe("important");
      expect(el.style.getPropertyPriority("color")).toBe("important");
    }
    const [linked, unlinked] = doc.querySelectorAll<HTMLElement>("a");
    expect(linked?.style.getPropertyPriority("color")).toBe("important");
    expect(unlinked?.style.color).toBe("");
  });
});
