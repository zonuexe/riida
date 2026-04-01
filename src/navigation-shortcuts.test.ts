import { describe, expect, it } from "vitest";
import { isNavigationBackShortcut, isNavigationForwardShortcut } from "./navigation-shortcuts";

describe("navigation shortcuts", () => {
  it("matches macOS back shortcuts", () => {
    expect(
      isNavigationBackShortcut({
        platform: "MacIntel",
        key: "[",
        metaKey: true,
        altKey: false,
        ctrlKey: false,
        shiftKey: false,
      }),
    ).toBe(true);

    expect(
      isNavigationBackShortcut({
        platform: "MacIntel",
        key: "ArrowLeft",
        metaKey: true,
        altKey: false,
        ctrlKey: false,
        shiftKey: false,
      }),
    ).toBe(true);
  });

  it("matches non-mac back shortcut", () => {
    expect(
      isNavigationBackShortcut({
        platform: "Linux x86_64",
        key: "ArrowLeft",
        metaKey: false,
        altKey: true,
        ctrlKey: false,
        shiftKey: false,
      }),
    ).toBe(true);
  });

  it("matches forward shortcuts", () => {
    expect(
      isNavigationForwardShortcut({
        platform: "MacIntel",
        key: "]",
        metaKey: true,
        altKey: false,
        ctrlKey: false,
        shiftKey: false,
      }),
    ).toBe(true);

    expect(
      isNavigationForwardShortcut({
        platform: "Windows",
        key: "ArrowRight",
        metaKey: false,
        altKey: true,
        ctrlKey: false,
        shiftKey: false,
      }),
    ).toBe(true);
  });

  it("rejects modified or unrelated shortcuts", () => {
    expect(
      isNavigationBackShortcut({
        platform: "MacIntel",
        key: "[",
        metaKey: true,
        altKey: true,
        ctrlKey: false,
        shiftKey: false,
      }),
    ).toBe(false);

    expect(
      isNavigationForwardShortcut({
        platform: "Windows",
        key: "ArrowLeft",
        metaKey: false,
        altKey: true,
        ctrlKey: false,
        shiftKey: false,
      }),
    ).toBe(false);
  });
});
