import { describe, expect, it } from "vitest";
import {
  type TextContentSampleLike,
  detectBindingFromTextContent,
  detectBindingFromViewerPreferences,
  detectPdfBinding,
} from "./pdf-binding-detect";

describe("detectBindingFromViewerPreferences", () => {
  it("returns right for explicit R2L direction", () => {
    expect(detectBindingFromViewerPreferences({ Direction: "R2L" })).toBe("right");
  });

  it("returns left for explicit L2R direction", () => {
    expect(detectBindingFromViewerPreferences({ Direction: "L2R" })).toBe("left");
  });

  it("returns null when no direction key is present", () => {
    expect(detectBindingFromViewerPreferences({})).toBeNull();
    expect(detectBindingFromViewerPreferences({ PageLayout: "SinglePage" })).toBeNull();
  });

  it("returns null for unrecognized direction values", () => {
    expect(detectBindingFromViewerPreferences({ Direction: "TopToBottom" })).toBeNull();
    expect(detectBindingFromViewerPreferences({ Direction: 42 })).toBeNull();
  });

  it("returns null for null or undefined", () => {
    expect(detectBindingFromViewerPreferences(null)).toBeNull();
    expect(detectBindingFromViewerPreferences(undefined)).toBeNull();
  });
});

describe("detectBindingFromTextContent", () => {
  function makeSample(
    items: ReadonlyArray<{ str: string; fontName: string } | { type: string }>,
    styles: Record<string, { vertical: boolean }>,
  ): TextContentSampleLike {
    return { items, styles };
  }

  it("returns right when most sampled characters are vertical", () => {
    const sample = makeSample(
      [
        { str: "あいうえおかきくけこさしすせそたちつてとなにぬねの", fontName: "v" },
        { str: "はひふへほまみむめもやゆよらりるれろわをんがぎぐげご", fontName: "v" },
      ],
      { v: { vertical: true } },
    );
    expect(detectBindingFromTextContent([sample])).toBe("right");
  });

  it("returns null when text is dominantly horizontal", () => {
    const sample = makeSample(
      [
        {
          str: "the quick brown fox jumps over the lazy dog. pack my box with five dozen liquor jugs.",
          fontName: "h",
        },
      ],
      { h: { vertical: false } },
    );
    expect(detectBindingFromTextContent([sample])).toBeNull();
  });

  it("returns null when sampled text is too short to be confident", () => {
    const sample = makeSample([{ str: "短い", fontName: "v" }], { v: { vertical: true } });
    expect(detectBindingFromTextContent([sample])).toBeNull();
  });

  it("ignores marked-content entries that lack a string", () => {
    const sample = makeSample(
      [
        { type: "beginMarkedContent" },
        {
          str: "縦書きの本文がとても長く続いていく場面で挿入されたマーク済みコンテンツ要素を無視しても判定が成立することを確認する",
          fontName: "v",
        },
        { type: "endMarkedContent" },
      ],
      { v: { vertical: true } },
    );
    expect(detectBindingFromTextContent([sample])).toBe("right");
  });

  it("aggregates across multiple sampled pages", () => {
    const verticalSample = makeSample(
      [
        {
          str: "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめも",
          fontName: "v",
        },
      ],
      { v: { vertical: true } },
    );
    const horizontalSample = makeSample([{ str: "captioned image", fontName: "h" }], {
      h: { vertical: false },
    });
    expect(detectBindingFromTextContent([verticalSample, horizontalSample])).toBe("right");
  });

  it("falls back to horizontal when vertical content is a minority", () => {
    const sample = makeSample(
      [
        { str: "縦短い", fontName: "v" },
        {
          str: "this paragraph is a long horizontal block that easily dominates the sampled text.",
          fontName: "h",
        },
      ],
      { v: { vertical: true }, h: { vertical: false } },
    );
    expect(detectBindingFromTextContent([sample])).toBeNull();
  });

  it("returns right when items stack vertically even with a horizontal CMap", () => {
    // Simulates a Japanese tategaki PDF where each glyph is positioned
    // individually with /Identity-H. style.vertical is false but the
    // transforms accumulate Δy >> Δx.
    const items: ReadonlyArray<{ str: string; fontName: string; transform: number[] }> = Array.from(
      { length: 40 },
      (_, index) => ({
        str: "あ",
        fontName: "h",
        transform: [10, 0, 0, 10, 200, 800 - index * 18],
      }),
    );
    const sample: TextContentSampleLike = {
      items,
      styles: { h: { vertical: false } },
    };
    expect(detectBindingFromTextContent([sample])).toBe("right");
  });

  it("does not flag horizontal items as right-bound via geometry", () => {
    const items: ReadonlyArray<{ str: string; fontName: string; transform: number[] }> = Array.from(
      { length: 40 },
      (_, index) => ({
        str: "a",
        fontName: "h",
        transform: [10, 0, 0, 10, 50 + index * 12, 700],
      }),
    );
    const sample: TextContentSampleLike = {
      items,
      styles: { h: { vertical: false } },
    };
    expect(detectBindingFromTextContent([sample])).toBeNull();
  });

  it("does not trigger geometry path when too few items are sampled", () => {
    const items: ReadonlyArray<{ str: string; fontName: string; transform: number[] }> = [
      { str: "x", fontName: "h", transform: [10, 0, 0, 10, 100, 800] },
      { str: "y", fontName: "h", transform: [10, 0, 0, 10, 100, 700] },
    ];
    const sample: TextContentSampleLike = {
      items,
      styles: { h: { vertical: false } },
    };
    expect(detectBindingFromTextContent([sample])).toBeNull();
  });
});

describe("detectPdfBinding", () => {
  it("prefers explicit viewer preferences over text-content heuristic", () => {
    const sample: TextContentSampleLike = {
      items: [{ str: "あいうえおかきくけこさしすせそたちつてとなにぬねの", fontName: "v" }],
      styles: { v: { vertical: true } },
    };
    expect(detectPdfBinding({ Direction: "L2R" }, [sample])).toBe("left");
  });

  it("falls back to text-content heuristic when prefs are absent", () => {
    const sample: TextContentSampleLike = {
      items: [
        {
          str: "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをんがぎぐげござじずぜぞ",
          fontName: "v",
        },
      ],
      styles: { v: { vertical: true } },
    };
    expect(detectPdfBinding(null, [sample])).toBe("right");
  });

  it("returns null when neither signal is present", () => {
    expect(detectPdfBinding(null, [])).toBeNull();
  });
});
