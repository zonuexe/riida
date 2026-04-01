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

export function clampNoteWindowPosition(
  noteWindow: NoteWindowLike,
  viewport: ViewportSize,
) {
  const maxLeft = Math.max(12, viewport.width - noteWindow.width - 12);
  const maxTop = Math.max(12, viewport.height - noteWindow.height - 12);

  return {
    ...noteWindow,
    x: Math.min(Math.max(noteWindow.x ?? maxLeft, 12), maxLeft),
    y: Math.min(Math.max(noteWindow.y ?? maxTop, 12), maxTop),
  };
}

export function ensureNoteWindowPlacement(
  noteWindow: NoteWindowLike,
  viewport: ViewportSize,
) {
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
