import { describe, expect, it } from "vitest";
import { clampNoteWindowPosition, ensureNoteWindowPlacement } from "./note-window-utils";

describe("clampNoteWindowPosition", () => {
  it("keeps the note window inside the viewport", () => {
    expect(
      clampNoteWindowPosition(
        {
          x: -50,
          y: 900,
          width: 420,
          height: 300,
        },
        {
          width: 1200,
          height: 800,
        },
      ),
    ).toEqual({
      x: 12,
      y: 488,
      width: 420,
      height: 300,
    });
  });

  it("uses the fallback edge when the current position is null", () => {
    expect(
      clampNoteWindowPosition(
        {
          x: null,
          y: null,
          width: 420,
          height: 300,
        },
        {
          width: 1200,
          height: 800,
        },
      ),
    ).toEqual({
      x: 768,
      y: 488,
      width: 420,
      height: 300,
    });
  });
});

describe("ensureNoteWindowPlacement", () => {
  it("places an unpositioned note near the bottom-right corner", () => {
    expect(
      ensureNoteWindowPlacement(
        {
          x: null,
          y: null,
          width: 420,
          height: 300,
        },
        {
          width: 1200,
          height: 800,
        },
      ),
    ).toEqual({
      x: 756,
      y: 476,
      width: 420,
      height: 300,
    });
  });

  it("keeps an already positioned note in bounds", () => {
    expect(
      ensureNoteWindowPlacement(
        {
          x: 100,
          y: 120,
          width: 420,
          height: 300,
        },
        {
          width: 1200,
          height: 800,
        },
      ),
    ).toEqual({
      x: 100,
      y: 120,
      width: 420,
      height: 300,
    });
  });
});
