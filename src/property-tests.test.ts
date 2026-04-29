import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  clampReadingPositionOffsetRatio,
  parseCachedReadingPosition,
} from "./reading-position-utils.ts";
import { parseRequestedPageNumber } from "./page-jump-utils.ts";
import { planPagedKeyAction } from "./pdf-paged-nav-utils.ts";

describe("clampReadingPositionOffsetRatio", () => {
  it("always returns a value in [0, 1]", () => {
    fc.assert(
      fc.property(fc.double({ noNaN: true }), (value) => {
        const result = clampReadingPositionOffsetRatio(value);
        expect(result).toBeGreaterThanOrEqual(0);
        expect(result).toBeLessThanOrEqual(1);
      }),
    );
  });

  it("is idempotent", () => {
    fc.assert(
      fc.property(fc.double({ noNaN: true }), (value) => {
        const once = clampReadingPositionOffsetRatio(value);
        const twice = clampReadingPositionOffsetRatio(once);
        expect(twice).toBe(once);
      }),
    );
  });

  it("preserves values already in range", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1, noNaN: true }), (value) => {
        expect(clampReadingPositionOffsetRatio(value)).toBe(value);
      }),
    );
  });
});

describe("parseCachedReadingPosition", () => {
  it("never throws on arbitrary string input", () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        expect(() => parseCachedReadingPosition(raw)).not.toThrow();
      }),
    );
  });

  it("round-trips well-formed payloads with offset clamped", () => {
    const arb = fc.record({
      filePath: fc.string({ minLength: 1 }),
      pageNumber: fc.integer({ min: 1, max: 100000 }),
      pageOffsetRatio: fc.double({ noNaN: true }),
      cfi: fc.option(fc.string(), { nil: null }),
      updatedAt: fc.option(fc.integer(), { nil: null }),
    });
    fc.assert(
      fc.property(arb, (payload) => {
        const result = parseCachedReadingPosition(JSON.stringify(payload));
        expect(result).not.toBeNull();
        expect(result?.filePath).toBe(payload.filePath);
        expect(result?.pageNumber).toBe(payload.pageNumber);
        expect(result?.pageOffsetRatio).toBeGreaterThanOrEqual(0);
        expect(result?.pageOffsetRatio).toBeLessThanOrEqual(1);
      }),
    );
  });
});

describe("parseRequestedPageNumber", () => {
  it("accepts only positive integer strings", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), (n) => {
        expect(parseRequestedPageNumber(String(n))).toBe(n);
      }),
    );
  });

  it("ignores surrounding whitespace", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), (n) => {
        expect(parseRequestedPageNumber(`  ${n}  `)).toBe(n);
      }),
    );
  });

  it("rejects non-digit input", () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !/^\s*\d+\s*$/.test(s)),
        (raw) => {
          expect(parseRequestedPageNumber(raw)).toBeNull();
        },
      ),
    );
  });
});

describe("planPagedKeyAction", () => {
  const stateArb = fc.record({
    scrollTop: fc.integer({ min: 0, max: 10_000 }),
    scrollLeft: fc.integer({ min: 0, max: 10_000 }),
    clientHeight: fc.integer({ min: 100, max: 2000 }),
    clientWidth: fc.integer({ min: 100, max: 2000 }),
    pageOffsetTop: fc.integer({ min: 0, max: 10_000 }),
    pageOffsetLeft: fc.integer({ min: 0, max: 10_000 }),
    pageHeight: fc.integer({ min: 100, max: 5000 }),
    pageWidth: fc.integer({ min: 100, max: 5000 }),
  });

  it("PageUp/PageDown always produce jump-adjacent", () => {
    fc.assert(
      fc.property(
        stateArb,
        fc.constantFrom("left" as const, "right" as const),
        (state, binding) => {
          expect(planPagedKeyAction("PageDown", state, binding).kind).toBe("jump-adjacent");
          expect(planPagedKeyAction("PageUp", state, binding).kind).toBe("jump-adjacent");
        },
      ),
    );
  });

  it("returns finite scroll positions or unit-direction jumps", () => {
    fc.assert(
      fc.property(
        stateArb,
        fc.constantFrom(
          "ArrowUp" as const,
          "ArrowDown" as const,
          "ArrowLeft" as const,
          "ArrowRight" as const,
        ),
        fc.constantFrom("left" as const, "right" as const),
        (state, key, binding) => {
          const action = planPagedKeyAction(key, state, binding);
          return action.kind === "scroll"
            ? Number.isFinite(action.top) && Number.isFinite(action.left)
            : Math.abs(action.direction) === 1;
        },
      ),
    );
    expect(true).toBe(true);
  });

  it("ArrowDown scroll stays at or below max scroll position when page exceeds viewport", () => {
    const constrainedArb = stateArb.filter(
      (s) => s.pageHeight > s.clientHeight && s.pageOffsetTop >= s.scrollTop,
    );
    fc.assert(
      fc.property(
        constrainedArb,
        fc.constantFrom("left" as const, "right" as const),
        (state, binding) => {
          const action = planPagedKeyAction("ArrowDown", state, binding);
          if (action.kind !== "scroll") return true;
          const maxTop = state.pageOffsetTop + state.pageHeight - state.clientHeight;
          return action.top <= maxTop;
        },
      ),
    );
    expect(true).toBe(true);
  });
});
