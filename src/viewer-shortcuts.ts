export type ViewerShortcutInput = {
  platform: string;
  key: string;
  code: string;
  metaKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
};

function isMac(platform: string): boolean {
  return platform.toUpperCase().includes("MAC");
}

function hasPrimaryModifier(input: ViewerShortcutInput): boolean {
  if (isMac(input.platform)) {
    return input.metaKey && !input.ctrlKey;
  }
  return input.ctrlKey && !input.metaKey;
}

function isSpaceKey(input: ViewerShortcutInput): boolean {
  return input.code === "Space" || input.key === " " || input.key === "Spacebar";
}

export function isViewerNextPageShortcut(input: ViewerShortcutInput): boolean {
  return isSpaceKey(input) && !input.metaKey && !input.altKey && !input.ctrlKey && !input.shiftKey;
}

export function isViewerPrevPageShortcut(input: ViewerShortcutInput): boolean {
  return isSpaceKey(input) && input.shiftKey && !input.metaKey && !input.altKey && !input.ctrlKey;
}

export function isViewerHomeShortcut(input: ViewerShortcutInput): boolean {
  return (
    (input.key === "Home" || input.code === "Home") &&
    !input.metaKey &&
    !input.altKey &&
    !input.ctrlKey &&
    !input.shiftKey
  );
}

export function isViewerEndShortcut(input: ViewerShortcutInput): boolean {
  return (
    (input.key === "End" || input.code === "End") &&
    !input.metaKey &&
    !input.altKey &&
    !input.ctrlKey &&
    !input.shiftKey
  );
}

export function isViewerZoomResetShortcut(input: ViewerShortcutInput): boolean {
  return (
    hasPrimaryModifier(input) &&
    input.shiftKey &&
    !input.altKey &&
    (input.code === "Digit0" || input.key === "0" || input.key === ")")
  );
}

export function isViewerZoomInShortcut(input: ViewerShortcutInput): boolean {
  return (
    hasPrimaryModifier(input) &&
    input.shiftKey &&
    !input.altKey &&
    (input.code === "Equal" || input.key === "+" || input.key === "=")
  );
}

export function isViewerZoomOutShortcut(input: ViewerShortcutInput): boolean {
  return (
    hasPrimaryModifier(input) &&
    input.shiftKey &&
    !input.altKey &&
    (input.code === "Minus" || input.key === "-" || input.key === "_")
  );
}

export const VIEWER_ZOOM_MIN = 0.25;
export const VIEWER_ZOOM_MAX = 4;
const VIEWER_ZOOM_STEP = 1.1;

export function clampViewerZoomScale(scale: number): number {
  if (!Number.isFinite(scale)) {
    return 1;
  }
  return Math.min(VIEWER_ZOOM_MAX, Math.max(VIEWER_ZOOM_MIN, scale));
}

export function nextViewerZoomIn(scale: number): number {
  return clampViewerZoomScale(scale * VIEWER_ZOOM_STEP);
}

export function nextViewerZoomOut(scale: number): number {
  return clampViewerZoomScale(scale / VIEWER_ZOOM_STEP);
}

export const EPUB_FONT_SIZE_MIN = 50;
export const EPUB_FONT_SIZE_MAX = 200;
const EPUB_FONT_SIZE_STEP = 10;
export const EPUB_FONT_SIZE_DEFAULT = 100;

export function clampEpubFontSize(value: number): number {
  if (!Number.isFinite(value)) {
    return EPUB_FONT_SIZE_DEFAULT;
  }
  return Math.min(EPUB_FONT_SIZE_MAX, Math.max(EPUB_FONT_SIZE_MIN, Math.round(value)));
}

export function nextEpubFontSizeUp(value: number): number {
  return clampEpubFontSize(value + EPUB_FONT_SIZE_STEP);
}

export function nextEpubFontSizeDown(value: number): number {
  return clampEpubFontSize(value - EPUB_FONT_SIZE_STEP);
}

export type ViewerKeyboardNavInput = {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
  /**
   * Whether the event originated from an editable surface (contentEditable,
   * <input>, <textarea>, <select>). The caller resolves this from the DOM
   * target so this helper stays pure and testable.
   */
  isTextEntryTarget: boolean;
};

export type ViewerKeyboardNavAction = "next" | "prev" | "home" | "end";

/**
 * Classify a keydown into a paged-viewer navigation intent, shared by the PDF
 * spread navigation and the EPUB rendition navigation.
 *
 * Returns `null` when the event should be left alone: already handled, a system
 * modifier combo (Cmd/Ctrl/Alt), typing into a form field, or an unrelated key.
 * Shift is allowed because Shift+Space is the "previous page" binding.
 *
 * For right-bound books (typically Japanese tategaki) the reader advances toward
 * the left of the spread, so the horizontal arrow semantics flip.
 */
export function resolveViewerKeyboardNav(
  input: ViewerKeyboardNavInput,
  bindingDirection: "left" | "right",
): ViewerKeyboardNavAction | null {
  if (input.defaultPrevented) return null;
  if (input.metaKey || input.ctrlKey || input.altKey) return null;
  if (input.isTextEntryTarget) return null;

  if (input.key === "Home") return "home";
  if (input.key === "End") return "end";

  const horizontalNext = bindingDirection === "right" ? "ArrowLeft" : "ArrowRight";
  const horizontalPrev = bindingDirection === "right" ? "ArrowRight" : "ArrowLeft";

  const isNext =
    input.key === "PageDown" ||
    (input.key === " " && !input.shiftKey) ||
    input.key === "ArrowDown" ||
    input.key === horizontalNext;
  if (isNext) return "next";

  const isPrev =
    input.key === "PageUp" ||
    (input.key === " " && input.shiftKey) ||
    input.key === "ArrowUp" ||
    input.key === horizontalPrev;
  if (isPrev) return "prev";

  return null;
}
