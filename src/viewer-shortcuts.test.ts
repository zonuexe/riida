import { describe, expect, it } from "vitest";
import {
  EPUB_FONT_SIZE_DEFAULT,
  EPUB_FONT_SIZE_MAX,
  EPUB_FONT_SIZE_MIN,
  VIEWER_ZOOM_MAX,
  VIEWER_ZOOM_MIN,
  clampEpubFontSize,
  clampViewerZoomScale,
  isViewerEndShortcut,
  isViewerHomeShortcut,
  isViewerNextPageShortcut,
  isViewerPrevPageShortcut,
  isViewerZoomInShortcut,
  isViewerZoomOutShortcut,
  isViewerZoomResetShortcut,
  nextEpubFontSizeDown,
  nextEpubFontSizeUp,
  nextViewerZoomIn,
  nextViewerZoomOut,
} from "./viewer-shortcuts";

const baseInput = {
  platform: "MacIntel",
  key: "",
  code: "",
  metaKey: false,
  altKey: false,
  ctrlKey: false,
  shiftKey: false,
};

describe("viewer page shortcuts", () => {
  it("treats unmodified Space as next page", () => {
    expect(isViewerNextPageShortcut({ ...baseInput, key: " ", code: "Space" })).toBe(true);
    expect(isViewerPrevPageShortcut({ ...baseInput, key: " ", code: "Space" })).toBe(false);
  });

  it("treats Shift+Space as previous page", () => {
    expect(
      isViewerPrevPageShortcut({ ...baseInput, key: " ", code: "Space", shiftKey: true }),
    ).toBe(true);
    expect(
      isViewerNextPageShortcut({ ...baseInput, key: " ", code: "Space", shiftKey: true }),
    ).toBe(false);
  });

  it("rejects Space combined with command/control", () => {
    expect(isViewerNextPageShortcut({ ...baseInput, key: " ", code: "Space", metaKey: true })).toBe(
      false,
    );
    expect(isViewerPrevPageShortcut({ ...baseInput, key: " ", code: "Space", ctrlKey: true })).toBe(
      false,
    );
  });
});

describe("viewer file boundary shortcuts", () => {
  it("matches plain Home / End", () => {
    expect(isViewerHomeShortcut({ ...baseInput, key: "Home", code: "Home" })).toBe(true);
    expect(isViewerEndShortcut({ ...baseInput, key: "End", code: "End" })).toBe(true);
  });

  it("rejects modified Home / End", () => {
    expect(isViewerHomeShortcut({ ...baseInput, key: "Home", code: "Home", shiftKey: true })).toBe(
      false,
    );
    expect(isViewerEndShortcut({ ...baseInput, key: "End", code: "End", metaKey: true })).toBe(
      false,
    );
  });
});

describe("viewer zoom shortcuts", () => {
  it("matches macOS Cmd+Shift+0 / + / -", () => {
    expect(
      isViewerZoomResetShortcut({
        ...baseInput,
        key: ")",
        code: "Digit0",
        metaKey: true,
        shiftKey: true,
      }),
    ).toBe(true);
    expect(
      isViewerZoomInShortcut({
        ...baseInput,
        key: "+",
        code: "Equal",
        metaKey: true,
        shiftKey: true,
      }),
    ).toBe(true);
    expect(
      isViewerZoomOutShortcut({
        ...baseInput,
        key: "_",
        code: "Minus",
        metaKey: true,
        shiftKey: true,
      }),
    ).toBe(true);
  });

  it("matches Windows/Linux Ctrl+Shift+0 / + / -", () => {
    expect(
      isViewerZoomResetShortcut({
        ...baseInput,
        platform: "Win32",
        key: "0",
        code: "Digit0",
        ctrlKey: true,
        shiftKey: true,
      }),
    ).toBe(true);
    expect(
      isViewerZoomInShortcut({
        ...baseInput,
        platform: "Linux x86_64",
        key: "=",
        code: "Equal",
        ctrlKey: true,
        shiftKey: true,
      }),
    ).toBe(true);
    expect(
      isViewerZoomOutShortcut({
        ...baseInput,
        platform: "Linux x86_64",
        key: "-",
        code: "Minus",
        ctrlKey: true,
        shiftKey: true,
      }),
    ).toBe(true);
  });

  it("requires both shift and the primary modifier", () => {
    expect(
      isViewerZoomResetShortcut({
        ...baseInput,
        key: "0",
        code: "Digit0",
        metaKey: true,
        shiftKey: false,
      }),
    ).toBe(false);
    expect(
      isViewerZoomInShortcut({
        ...baseInput,
        key: "+",
        code: "Equal",
        shiftKey: true,
      }),
    ).toBe(false);
  });

  it("rejects Cmd+Ctrl combination on macOS", () => {
    expect(
      isViewerZoomResetShortcut({
        ...baseInput,
        key: "0",
        code: "Digit0",
        metaKey: true,
        ctrlKey: true,
        shiftKey: true,
      }),
    ).toBe(false);
  });
});

describe("zoom scale arithmetic", () => {
  it("clamps zoom scale within bounds", () => {
    expect(clampViewerZoomScale(0.01)).toBe(VIEWER_ZOOM_MIN);
    expect(clampViewerZoomScale(99)).toBe(VIEWER_ZOOM_MAX);
    expect(clampViewerZoomScale(Number.NaN)).toBe(1);
  });

  it("steps in and out", () => {
    expect(nextViewerZoomIn(1)).toBeGreaterThan(1);
    expect(nextViewerZoomOut(1)).toBeLessThan(1);
  });

  it("does not exceed bounds when stepping repeatedly", () => {
    let scale = 1;
    for (let i = 0; i < 50; i += 1) scale = nextViewerZoomIn(scale);
    expect(scale).toBeLessThanOrEqual(VIEWER_ZOOM_MAX);
    let scaleDown = 1;
    for (let i = 0; i < 50; i += 1) scaleDown = nextViewerZoomOut(scaleDown);
    expect(scaleDown).toBeGreaterThanOrEqual(VIEWER_ZOOM_MIN);
  });
});

describe("EPUB font size arithmetic", () => {
  it("clamps font size within bounds", () => {
    expect(clampEpubFontSize(0)).toBe(EPUB_FONT_SIZE_MIN);
    expect(clampEpubFontSize(999)).toBe(EPUB_FONT_SIZE_MAX);
    expect(clampEpubFontSize(Number.NaN)).toBe(EPUB_FONT_SIZE_DEFAULT);
  });

  it("steps font size up and down", () => {
    expect(nextEpubFontSizeUp(100)).toBe(110);
    expect(nextEpubFontSizeDown(100)).toBe(90);
  });

  it("respects bounds when stepping", () => {
    let value = EPUB_FONT_SIZE_MAX;
    value = nextEpubFontSizeUp(value);
    expect(value).toBe(EPUB_FONT_SIZE_MAX);
    let down = EPUB_FONT_SIZE_MIN;
    down = nextEpubFontSizeDown(down);
    expect(down).toBe(EPUB_FONT_SIZE_MIN);
  });
});
