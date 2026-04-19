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

  it("ArrowDown clamps scroll to not exceed page bottom", () => {
    const nearBottom: PagedNavState = { ...baseState, scrollTop: 500, clientHeight: 600 };
    expect(planPagedKeyAction("ArrowDown", nearBottom, "left")).toEqual({
      kind: "scroll",
      top: nearBottom.pageHeight - nearBottom.clientHeight,
      left: 0,
    });
  });
});
