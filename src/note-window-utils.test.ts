import { describe, expect, it } from "vitest";
import {
  beginNoteWindowInteraction,
  clampNoteWindowPosition,
  ensureNoteWindowPlacement,
  idleNoteWindowInteraction,
  NOTE_WINDOW_MIN_HEIGHT,
  NOTE_WINDOW_MIN_WIDTH,
  noteWindowFrameForPointer,
  preserveNoteWindowBottomRightOffset,
} from "./note-window-utils";

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

describe("preserveNoteWindowBottomRightOffset", () => {
  it("keeps the same right and bottom distance after viewport growth", () => {
    expect(
      preserveNoteWindowBottomRightOffset(
        {
          x: 756,
          y: 476,
          width: 420,
          height: 300,
        },
        {
          width: 1200,
          height: 800,
        },
        {
          width: 1600,
          height: 1000,
        },
      ),
    ).toEqual({
      x: 1156,
      y: 676,
      width: 420,
      height: 300,
    });
  });

  it("leaves unpositioned notes unchanged", () => {
    expect(
      preserveNoteWindowBottomRightOffset(
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
        {
          width: 1600,
          height: 1000,
        },
      ),
    ).toEqual({
      x: null,
      y: null,
      width: 420,
      height: 300,
    });
  });
});

describe("noteWindowFrameForPointer", () => {
  const noteWindow = { x: 500, y: 300, width: 420, height: 320 };
  const viewport = { width: 1200, height: 800 };

  it("returns null while no interaction is active", () => {
    expect(noteWindowFrameForPointer(idleNoteWindowInteraction(), 10, 10, viewport)).toBeNull();
  });

  it("moves the window by the pointer delta when dragging", () => {
    const drag = beginNoteWindowInteraction(noteWindow, null, 100, 100);
    expect(drag.mode).toBe("drag");
    expect(noteWindowFrameForPointer(drag, 130, 80, viewport)).toEqual({ x: 530, y: 280 });
  });

  it("anchors an unplaced window at the origin", () => {
    const drag = beginNoteWindowInteraction({ ...noteWindow, x: null, y: null }, null, 0, 0);
    expect(noteWindowFrameForPointer(drag, 5, 7, viewport)).toEqual({ x: 5, y: 7 });
  });

  it("grows from the south-east edge without moving the window", () => {
    const resize = beginNoteWindowInteraction(noteWindow, "se", 100, 100);
    expect(resize.mode).toBe("resize");
    expect(noteWindowFrameForPointer(resize, 150, 140, viewport)).toEqual({
      x: 500,
      y: 300,
      width: 470,
      height: 360,
    });
  });

  it("moves the north-west corner with the pointer", () => {
    const resize = beginNoteWindowInteraction(noteWindow, "nw", 100, 100);
    expect(noteWindowFrameForPointer(resize, 80, 60, viewport)).toEqual({
      x: 480,
      y: 260,
      width: 440,
      height: 360,
    });
  });

  it("pins the far edge once shrinking from the north-west reaches the minimum", () => {
    const resize = beginNoteWindowInteraction(noteWindow, "nw", 100, 100);
    expect(noteWindowFrameForPointer(resize, 900, 900, viewport)).toEqual({
      x: 500 + (420 - NOTE_WINDOW_MIN_WIDTH),
      y: 300 + (320 - NOTE_WINDOW_MIN_HEIGHT),
      width: NOTE_WINDOW_MIN_WIDTH,
      height: NOTE_WINDOW_MIN_HEIGHT,
    });
  });

  it("keeps the minimum size when shrinking from the south-east", () => {
    const resize = beginNoteWindowInteraction(noteWindow, "se", 100, 100);
    expect(noteWindowFrameForPointer(resize, -500, -500, viewport)).toMatchObject({
      width: NOTE_WINDOW_MIN_WIDTH,
      height: NOTE_WINDOW_MIN_HEIGHT,
    });
  });

  it("caps the size at the viewport less a margin", () => {
    const resize = beginNoteWindowInteraction(noteWindow, "se", 100, 100);
    expect(noteWindowFrameForPointer(resize, 5000, 5000, viewport)).toMatchObject({
      width: viewport.width - 24,
      height: viewport.height - 24,
    });
  });

  it("leaves the size alone for an unknown edge", () => {
    const resize = { ...beginNoteWindowInteraction(noteWindow, "x", 0, 0), edge: null };
    expect(noteWindowFrameForPointer(resize, 50, 50, viewport)).toEqual({
      x: 500,
      y: 300,
      width: 420,
      height: 320,
    });
  });
});
