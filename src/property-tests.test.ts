import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  addLibraryRoot,
  normalizeAppTheme,
  parseExcludedPatternsInput,
} from "./app-config-utils.ts";
import {
  buildNavigationUrl,
  navigationStateSignature,
  type NavigationStateLike,
} from "./navigation-utils.ts";
import { clampNoteWindowPosition, ensureNoteWindowPlacement } from "./note-window-utils.ts";
import { parseRequestedPageNumber } from "./page-jump-utils.ts";
import { planPagedKeyAction } from "./pdf-paged-nav-utils.ts";
import {
  clampReadingPositionOffsetRatio,
  parseCachedReadingPosition,
} from "./reading-position-utils.ts";
import { validateTagValue } from "./tag-utils.ts";

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
      pageOffsetRatio: fc.double({ noNaN: true, noDefaultInfinity: true }),
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

describe("validateTagValue", () => {
  it("accepts non-empty trimmed values without slash anomalies", () => {
    fc.assert(
      fc.property(
        fc
          .string({ minLength: 1 })
          .filter(
            (s) =>
              s.trim().length > 0 &&
              s.trim() !== "/" &&
              !s.trim().startsWith("/") &&
              !s.trim().endsWith("/") &&
              !s.trim().includes("//"),
          ),
        (raw) => {
          const result = validateTagValue(raw);
          return result.ok && result.value === raw.trim();
        },
      ),
    );
    expect(true).toBe(true);
  });

  it("rejects empty/whitespace-only values", () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => s.trim().length === 0),
        (raw) => validateTagValue(raw).ok === false,
      ),
    );
    expect(true).toBe(true);
  });

  it("rejects strings with leading/trailing slash or double slashes", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("/", "/foo", "foo/", "foo//bar", "//"),
        (raw) => validateTagValue(raw).ok === false,
      ),
    );
    expect(true).toBe(true);
  });
});

describe("normalizeAppTheme", () => {
  const validThemes = ["default", "snow-white", "night-city", "navy-blue"] as const;

  it("returns one of the valid theme names for any input", () => {
    fc.assert(
      fc.property(fc.option(fc.string(), { nil: null }), (value) => {
        const result = normalizeAppTheme(value);
        return validThemes.includes(result);
      }),
    );
    expect(true).toBe(true);
  });

  it("preserves valid theme names verbatim", () => {
    fc.assert(
      fc.property(fc.constantFrom(...validThemes), (value) => normalizeAppTheme(value) === value),
    );
    expect(true).toBe(true);
  });
});

describe("parseExcludedPatternsInput", () => {
  it("never returns empty or whitespace-only entries", () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const entries = parseExcludedPatternsInput(raw);
        return entries.every((entry) => entry.length > 0 && entry.trim() === entry);
      }),
    );
    expect(true).toBe(true);
  });
});

describe("addLibraryRoot", () => {
  it("contains the new root", () => {
    fc.assert(
      fc.property(fc.array(fc.string()), fc.string(), (existing, candidate) =>
        addLibraryRoot(existing, candidate).includes(candidate),
      ),
    );
    expect(true).toBe(true);
  });

  it("preserves all existing roots", () => {
    fc.assert(
      fc.property(fc.array(fc.string()), fc.string(), (existing, candidate) => {
        const result = addLibraryRoot(existing, candidate);
        return existing.every((root) => result.includes(root));
      }),
    );
    expect(true).toBe(true);
  });

  it("contains no duplicates", () => {
    fc.assert(
      fc.property(fc.array(fc.string()), fc.string(), (existing, candidate) => {
        const result = addLibraryRoot(existing, candidate);
        return new Set(result).size === result.length;
      }),
    );
    expect(true).toBe(true);
  });
});

describe("clampNoteWindowPosition", () => {
  const noteArb = fc.record({
    x: fc.option(fc.integer({ min: -1000, max: 5000 }), { nil: null }),
    y: fc.option(fc.integer({ min: -1000, max: 5000 }), { nil: null }),
    width: fc.integer({ min: 100, max: 1200 }),
    height: fc.integer({ min: 100, max: 1200 }),
  });
  const viewportArb = fc.record({
    width: fc.integer({ min: 200, max: 4000 }),
    height: fc.integer({ min: 200, max: 4000 }),
  });

  it("places window at or above the 12px gutter", () => {
    fc.assert(
      fc.property(noteArb, viewportArb, (note, viewport) => {
        const placed = clampNoteWindowPosition(note, viewport);
        return placed.x >= 12 && placed.y >= 12;
      }),
    );
    expect(true).toBe(true);
  });

  it("ensureNoteWindowPlacement returns finite coordinates", () => {
    fc.assert(
      fc.property(noteArb, viewportArb, (note, viewport) => {
        const placed = ensureNoteWindowPlacement(note, viewport);
        return Number.isFinite(placed.x) && Number.isFinite(placed.y);
      }),
    );
    expect(true).toBe(true);
  });
});

describe("navigation utils", () => {
  const stateArb: fc.Arbitrary<NavigationStateLike> = fc.record({
    historyIndex: fc.integer({ min: 0, max: 100 }),
    bookFilePath: fc.option(fc.string(), { nil: null }),
    epubCfi: fc.option(fc.string(), { nil: null }),
    activeDirectory: fc.option(fc.string(), { nil: null }),
    activeTag: fc.option(fc.string(), { nil: null }),
    activeExternalSource: fc.option(fc.string(), { nil: null }),
    activeShelf: fc.option(fc.string(), { nil: null }),
    activeTagDirectOnly: fc.boolean(),
    searchQuery: fc.string(),
  });

  it("navigationStateSignature is deterministic", () => {
    fc.assert(
      fc.property(stateArb, (state) => {
        return navigationStateSignature(state) === navigationStateSignature(state);
      }),
    );
    expect(true).toBe(true);
  });

  it("navigationStateSignature ignores historyIndex", () => {
    fc.assert(
      fc.property(stateArb, fc.integer({ min: 0, max: 100 }), (state, otherIndex) => {
        return (
          navigationStateSignature(state) ===
          navigationStateSignature({ ...state, historyIndex: otherIndex })
        );
      }),
    );
    expect(true).toBe(true);
  });

  it("buildNavigationUrl round-trips non-empty fields through URLSearchParams", () => {
    fc.assert(
      fc.property(stateArb, (state) => {
        const url = buildNavigationUrl(state);
        if (url === "/") return true;
        const params = new URLSearchParams(url.slice(2));
        if (state.searchQuery && params.get("q") !== state.searchQuery) return false;
        if (state.activeDirectory && params.get("dir") !== state.activeDirectory) return false;
        if (state.activeTag && params.get("tag") !== state.activeTag) return false;
        if (state.bookFilePath && params.get("book") !== state.bookFilePath) return false;
        return true;
      }),
    );
    expect(true).toBe(true);
  });
});
