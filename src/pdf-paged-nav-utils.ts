export type PagedNavKey =
  | "ArrowLeft"
  | "ArrowRight"
  | "ArrowUp"
  | "ArrowDown"
  | "PageUp"
  | "PageDown";

export type PagedNavBindingDirection = "left" | "right";

export type PagedNavState = {
  scrollTop: number;
  scrollLeft: number;
  clientHeight: number;
  clientWidth: number;
  pageOffsetTop: number;
  pageOffsetLeft: number;
  pageHeight: number;
  pageWidth: number;
};

export type PagedNavAction =
  | { kind: "jump-adjacent"; direction: 1 | -1 }
  | { kind: "scroll"; top: number; left: number };

const EDGE_THRESHOLD = 2;

export function planPagedKeyAction(
  key: PagedNavKey,
  state: PagedNavState,
  bindingDirection: PagedNavBindingDirection,
): PagedNavAction {
  const rtl = bindingDirection === "right";

  if (key === "PageDown") {
    return { kind: "jump-adjacent", direction: 1 };
  }
  if (key === "PageUp") {
    return { kind: "jump-adjacent", direction: -1 };
  }

  const pageTopInStage = state.pageOffsetTop - state.scrollTop;
  const pageBottomInStage = pageTopInStage + state.pageHeight;
  const pageLeftInStage = state.pageOffsetLeft - state.scrollLeft;
  const pageRightInStage = pageLeftInStage + state.pageWidth;

  if (key === "ArrowDown") {
    const step = Math.max(state.clientHeight * 0.9, 40);
    const bottomVisible = pageBottomInStage <= state.clientHeight + EDGE_THRESHOLD;
    if (bottomVisible) {
      return { kind: "jump-adjacent", direction: 1 };
    }
    const maxTop = state.pageOffsetTop + state.pageHeight - state.clientHeight;
    return {
      kind: "scroll",
      top: Math.min(state.scrollTop + step, maxTop),
      left: state.scrollLeft,
    };
  }

  if (key === "ArrowUp") {
    const step = Math.max(state.clientHeight * 0.9, 40);
    const topVisible = pageTopInStage >= -EDGE_THRESHOLD;
    if (topVisible) {
      return { kind: "jump-adjacent", direction: -1 };
    }
    const minTop = state.pageOffsetTop;
    return {
      kind: "scroll",
      top: Math.max(state.scrollTop - step, minTop),
      left: state.scrollLeft,
    };
  }

  // Horizontal keys — binding direction maps to next/prev for spread jumps.
  const horizontalDirection: 1 | -1 = key === "ArrowRight" ? (rtl ? -1 : 1) : rtl ? 1 : -1;
  const canScrollHorizontally = state.pageWidth > state.clientWidth + EDGE_THRESHOLD;
  const step = Math.max(state.clientWidth * 0.9, 40);

  if (key === "ArrowRight") {
    const rightVisible = pageRightInStage <= state.clientWidth + EDGE_THRESHOLD;
    if (!canScrollHorizontally || rightVisible) {
      return { kind: "jump-adjacent", direction: horizontalDirection };
    }
    const maxLeft = state.pageOffsetLeft + state.pageWidth - state.clientWidth;
    return {
      kind: "scroll",
      top: state.scrollTop,
      left: Math.min(state.scrollLeft + step, maxLeft),
    };
  }

  // ArrowLeft
  const leftVisible = pageLeftInStage >= -EDGE_THRESHOLD;
  if (!canScrollHorizontally || leftVisible) {
    return { kind: "jump-adjacent", direction: horizontalDirection };
  }
  const minLeft = state.pageOffsetLeft;
  return {
    kind: "scroll",
    top: state.scrollTop,
    left: Math.max(state.scrollLeft - step, minLeft),
  };
}
