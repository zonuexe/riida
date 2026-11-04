export type NoteWindowLike = {
  x: number | null;
  y: number | null;
  width: number;
  height: number;
};

type ViewportSize = {
  width: number;
  height: number;
};

export function preserveNoteWindowBottomRightOffset(
  noteWindow: NoteWindowLike,
  previousViewport: ViewportSize,
  nextViewport: ViewportSize,
) {
  if (noteWindow.x === null || noteWindow.y === null) {
    return noteWindow;
  }

  const rightOffset = previousViewport.width - (noteWindow.x + noteWindow.width);
  const bottomOffset = previousViewport.height - (noteWindow.y + noteWindow.height);

  return {
    ...noteWindow,
    x: nextViewport.width - noteWindow.width - rightOffset,
    y: nextViewport.height - noteWindow.height - bottomOffset,
  };
}

export function clampNoteWindowPosition(noteWindow: NoteWindowLike, viewport: ViewportSize) {
  const maxLeft = Math.max(12, viewport.width - noteWindow.width - 12);
  const maxTop = Math.max(12, viewport.height - noteWindow.height - 12);

  return {
    ...noteWindow,
    x: Math.min(Math.max(noteWindow.x ?? maxLeft, 12), maxLeft),
    y: Math.min(Math.max(noteWindow.y ?? maxTop, 12), maxTop),
  };
}

export function ensureNoteWindowPlacement(noteWindow: NoteWindowLike, viewport: ViewportSize) {
  const positioned =
    noteWindow.x === null || noteWindow.y === null
      ? {
          ...noteWindow,
          x: Math.max(12, viewport.width - noteWindow.width - 24),
          y: Math.max(12, viewport.height - noteWindow.height - 24),
        }
      : noteWindow;

  return clampNoteWindowPosition(positioned, viewport);
}

export const NOTE_WINDOW_MIN_WIDTH = 280;
export const NOTE_WINDOW_MIN_HEIGHT = 220;

/** A drag or resize of the note window, anchored where the pointer went down. */
export type NoteWindowInteraction = {
  mode: "drag" | "resize" | null;
  edge: string | null;
  startX: number;
  startY: number;
  startLeft: number;
  startTop: number;
  startWidth: number;
  startHeight: number;
};

export function idleNoteWindowInteraction(): NoteWindowInteraction {
  return {
    mode: null,
    edge: null,
    startX: 0,
    startY: 0,
    startLeft: 0,
    startTop: 0,
    startWidth: 0,
    startHeight: 0,
  };
}

/**
 * Start a drag (`edge` null) or a resize from `edge` (any of "n", "e", "s",
 * "w", e.g. "se") with the pointer at (`pointerX`, `pointerY`).
 */
export function beginNoteWindowInteraction(
  noteWindow: NoteWindowLike,
  edge: string | null,
  pointerX: number,
  pointerY: number,
): NoteWindowInteraction {
  return {
    mode: edge === null ? "drag" : "resize",
    edge,
    startX: pointerX,
    startY: pointerY,
    startLeft: noteWindow.x ?? 0,
    startTop: noteWindow.y ?? 0,
    startWidth: noteWindow.width,
    startHeight: noteWindow.height,
  };
}

/**
 * The note window's next frame for the pointer at (`pointerX`, `pointerY`),
 * before clamping into the viewport. A drag moves the window; a resize also
 * changes its size, keeps it at least the minimum size and at most the
 * viewport less a margin, and pins the opposite edge when shrinking from the
 * north or west edge stops at the minimum. Null when no interaction is active.
 */
export function noteWindowFrameForPointer(
  interaction: NoteWindowInteraction,
  pointerX: number,
  pointerY: number,
  viewport: ViewportSize,
): Partial<NoteWindowLike> | null {
  if (!interaction.mode) {
    return null;
  }

  const dx = pointerX - interaction.startX;
  const dy = pointerY - interaction.startY;

  if (interaction.mode === "drag") {
    return { x: interaction.startLeft + dx, y: interaction.startTop + dy };
  }

  const edge = interaction.edge ?? "";
  let nextLeft = interaction.startLeft;
  let nextTop = interaction.startTop;
  let nextWidth = interaction.startWidth;
  let nextHeight = interaction.startHeight;

  if (edge.includes("e")) {
    nextWidth = Math.max(NOTE_WINDOW_MIN_WIDTH, interaction.startWidth + dx);
  }

  if (edge.includes("s")) {
    nextHeight = Math.max(NOTE_WINDOW_MIN_HEIGHT, interaction.startHeight + dy);
  }

  if (edge.includes("w")) {
    nextWidth = Math.max(NOTE_WINDOW_MIN_WIDTH, interaction.startWidth - dx);
    nextLeft = interaction.startLeft + dx;
    if (nextWidth === NOTE_WINDOW_MIN_WIDTH) {
      nextLeft = interaction.startLeft + (interaction.startWidth - NOTE_WINDOW_MIN_WIDTH);
    }
  }

  if (edge.includes("n")) {
    nextHeight = Math.max(NOTE_WINDOW_MIN_HEIGHT, interaction.startHeight - dy);
    nextTop = interaction.startTop + dy;
    if (nextHeight === NOTE_WINDOW_MIN_HEIGHT) {
      nextTop = interaction.startTop + (interaction.startHeight - NOTE_WINDOW_MIN_HEIGHT);
    }
  }

  return {
    width: Math.min(nextWidth, viewport.width - 24),
    height: Math.min(nextHeight, viewport.height - 24),
    x: nextLeft,
    y: nextTop,
  };
}
