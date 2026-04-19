import { describe, expect, it } from "vitest";
import { planPagedKeyAction, type PagedNavState } from "./pdf-paged-nav-utils";

const baseState: PagedNavState = {
  scrollTop: 0,
  scrollLeft: 0,
  clientHeight: 600,
  clientWidth: 800,
  pageOffsetTop: 0,
  pageOffsetLeft: 0,
  pageHeight: 1200,
  pageWidth: 800,
};

describe("planPagedKeyAction", () => {
  it("PageDown always jumps to next spread", () => {
    expect(planPagedKeyAction("PageDown", baseState, "left")).toEqual({
      kind: "jump-adjacent",
      direction: 1,
    });
  });

  it("PageUp always jumps to previous spread", () => {
    expect(planPagedKeyAction("PageUp", baseState, "left")).toEqual({
      kind: "jump-adjacent",
      direction: -1,
    });
  });

  it("ArrowDown scrolls within page when bottom edge is below viewport", () => {
    const action = planPagedKeyAction("ArrowDown", baseState, "left");
    expect(action).toEqual({
      kind: "scroll",
      top: Math.min(baseState.clientHeight * 0.9, baseState.pageHeight - baseState.clientHeight),
      left: 0,
    });
  });

  it("ArrowDown jumps to next spread when bottom edge is visible", () => {
    const scrolled: PagedNavState = { ...baseState, scrollTop: 600 };
    expect(planPagedKeyAction("ArrowDown", scrolled, "left")).toEqual({
      kind: "jump-adjacent",
      direction: 1,
    });
  });

  it("ArrowUp scrolls within page when top edge is above viewport", () => {
    const scrolled: PagedNavState = { ...baseState, scrollTop: 600 };
    const action = planPagedKeyAction("ArrowUp", scrolled, "left");
    expect(action).toEqual({
      kind: "scroll",
      top: Math.max(scrolled.scrollTop - scrolled.clientHeight * 0.9, scrolled.pageOffsetTop),
      left: 0,
    });
  });

  it("ArrowUp jumps to previous spread when top edge is visible", () => {
    expect(planPagedKeyAction("ArrowUp", baseState, "left")).toEqual({
      kind: "jump-adjacent",
      direction: -1,
    });
  });

  it("ArrowRight jumps to next spread (left binding) when page fits viewport width", () => {
    expect(planPagedKeyAction("ArrowRight", baseState, "left")).toEqual({
      kind: "jump-adjacent",
      direction: 1,
    });
  });

  it("ArrowLeft jumps to previous spread (left binding) when page fits viewport width", () => {
    expect(planPagedKeyAction("ArrowLeft", baseState, "left")).toEqual({
      kind: "jump-adjacent",
      direction: -1,
    });
  });

  it("ArrowRight jumps to previous spread under right binding (RTL)", () => {
    expect(planPagedKeyAction("ArrowRight", baseState, "right")).toEqual({
      kind: "jump-adjacent",
      direction: -1,
    });
  });

  it("ArrowLeft jumps to next spread under right binding (RTL)", () => {
    expect(planPagedKeyAction("ArrowLeft", baseState, "right")).toEqual({
      kind: "jump-adjacent",
      direction: 1,
    });
  });

  it("ArrowRight scrolls within page when page overflows and right edge is not visible", () => {
    const wide: PagedNavState = { ...baseState, pageWidth: 1600 };
    expect(planPagedKeyAction("ArrowRight", wide, "left")).toEqual({
      kind: "scroll",
      top: 0,
      left: Math.min(wide.clientWidth * 0.9, wide.pageWidth - wide.clientWidth),
    });
  });

  it("ArrowRight jumps adjacent when overflowing page has right edge already visible", () => {
    const wide: PagedNavState = {
      ...baseState,
      pageWidth: 1600,
      scrollLeft: 800,
    };
    expect(planPagedKeyAction("ArrowRight", wide, "left")).toEqual({
      kind: "jump-adjacent",
      direction: 1,
    });
  });

  it("ArrowDown uses 40px minimum step when 0.9 * clientHeight is smaller", () => {
    const tiny: PagedNavState = { ...baseState, clientHeight: 20, pageHeight: 400 };
    expect(planPagedKeyAction("ArrowDown", tiny, "left")).toEqual({
      kind: "scroll",
      top: 40,
      left: 0,
    });
  });

  it("ArrowRight uses 40px minimum step when 0.9 * clientWidth is smaller", () => {
    const tiny: PagedNavState = {
      ...baseState,
      clientWidth: 30,
      pageWidth: 400,
    };
    expect(planPagedKeyAction("ArrowRight", tiny, "left")).toEqual({
      kind: "scroll",
      top: 0,
      left: 40,
    });
  });

  it("ArrowDown treats bottom edge as visible within the edge threshold", () => {
    // pageBottomInStage = 1200 - scrollTop = 598; clientHeight = 600; within threshold.
    const atEdge: PagedNavState = { ...baseState, scrollTop: 602 };
    expect(planPagedKeyAction("ArrowDown", atEdge, "left")).toEqual({
      kind: "jump-adjacent",
      direction: 1,
    });
  });

  it("ArrowDown still scrolls when bottom edge is just past the threshold", () => {
    // pageBottomInStage = 1200 - 597 = 603 > clientHeight + 2 (602). Not visible yet.
    const justBefore: PagedNavState = { ...baseState, scrollTop: 597 };
    const action = planPagedKeyAction("ArrowDown", justBefore, "left");
    expect(action.kind).toBe("scroll");
  });

  it("ArrowUp treats top edge as visible within the edge threshold", () => {
    // pageTopInStage = 0 - 2 = -2, within -threshold.
    const atEdge: PagedNavState = { ...baseState, scrollTop: 2 };
    expect(planPagedKeyAction("ArrowUp", atEdge, "left")).toEqual({
      kind: "jump-adjacent",
      direction: -1,
    });
  });

  it("ArrowUp still scrolls when top edge is just past the threshold", () => {
    const justBefore: PagedNavState = { ...baseState, scrollTop: 3 };
    const action = planPagedKeyAction("ArrowUp", justBefore, "left");
    expect(action.kind).toBe("scroll");
  });

  it("treats page of exactly viewport width as non-overflowing (no horizontal scrolling)", () => {
    const exact: PagedNavState = { ...baseState, pageWidth: 800, clientWidth: 800 };
    expect(planPagedKeyAction("ArrowRight", exact, "left")).toEqual({
      kind: "jump-adjacent",
      direction: 1,
    });
  });

  it("ArrowDown clamps scroll to not exceed page bottom", () => {
    const nearBottom: PagedNavState = { ...baseState, scrollTop: 500, clientHeight: 600 };
    expect(planPagedKeyAction("ArrowDown", nearBottom, "left")).toEqual({
      kind: "scroll",
      top: nearBottom.pageHeight - nearBottom.clientHeight,
      left: 0,
    });
  });
});
