import { describe, expect, it } from "vitest";
import {
  canStartBuild,
  formatBytes,
  formatIndexStatusLabel,
  type FullTextHit,
  groupHitsByBook,
  jumpTargetForHit,
  locationLabel,
} from "./fulltext-ui";

function hit(overrides: Partial<FullTextHit>): FullTextHit {
  return {
    filePath: "a.pdf",
    title: "本",
    kind: "body",
    page: null,
    anchor: null,
    score: 1,
    snippetHtml: "…",
    ...overrides,
  };
}

describe("groupHitsByBook", () => {
  it("groups by file path preserving score order", () => {
    const groups = groupHitsByBook([
      hit({ filePath: "a.pdf", page: 3, score: 5 }),
      hit({ filePath: "b.pdf", page: 1, score: 4 }),
      hit({ filePath: "a.pdf", page: 9, score: 2 }),
    ]);
    expect(groups.map((g) => g.filePath)).toEqual(["a.pdf", "b.pdf"]);
    expect(groups[0]!.locations.map((l) => l.page)).toEqual([3, 9]);
    expect(groups[0]!.score).toBe(5);
  });

  it("caps locations per book", () => {
    const hits = [1, 2, 3, 4, 5].map((p) => hit({ filePath: "a.pdf", page: p, score: 6 - p }));
    const groups = groupHitsByBook(hits, 2);
    expect(groups[0]!.locations).toHaveLength(2);
    expect(groups[0]!.locations.map((l) => l.page)).toEqual([1, 2]);
  });

  it("tracks the best score even when a later hit is higher", () => {
    const groups = groupHitsByBook([
      hit({ filePath: "a.pdf", score: 2 }),
      hit({ filePath: "a.pdf", score: 7 }),
    ]);
    expect(groups[0]!.score).toBe(7);
  });

  it("returns empty for no hits", () => {
    expect(groupHitsByBook([])).toEqual([]);
  });
});

describe("jumpTargetForHit", () => {
  it("returns a page for a PDF body hit", () => {
    expect(jumpTargetForHit({ kind: "body", page: 42, anchor: null })).toEqual({ page: 42 });
  });

  it("returns a cfi/anchor for an EPUB body hit", () => {
    expect(jumpTargetForHit({ kind: "body", page: null, anchor: "ch1.xhtml" })).toEqual({
      cfi: "ch1.xhtml",
    });
  });

  it("returns null for metadata and note hits", () => {
    expect(jumpTargetForHit({ kind: "metadata", page: null, anchor: null })).toBeNull();
    expect(jumpTargetForHit({ kind: "note", page: null, anchor: null })).toBeNull();
  });

  it("returns null when a body hit has no usable location", () => {
    expect(jumpTargetForHit({ kind: "body", page: 0, anchor: "" })).toBeNull();
  });
});

describe("locationLabel", () => {
  it("labels by kind and page", () => {
    expect(locationLabel({ kind: "metadata", page: null })).toBe("書誌情報");
    expect(locationLabel({ kind: "note", page: null })).toBe("ノート");
    expect(locationLabel({ kind: "body", page: 42 })).toBe("p.42");
    expect(locationLabel({ kind: "body", page: null })).toBe("本文");
  });
});

describe("formatBytes", () => {
  it("formats sizes across units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5 MB");
    expect(formatBytes(3.5 * 1024 * 1024 * 1024)).toBe("3.5 GB");
  });

  it("handles non-positive input", () => {
    expect(formatBytes(-1)).toBe("0 B");
    expect(formatBytes(NaN)).toBe("0 B");
  });
});

describe("formatIndexStatusLabel", () => {
  const base = {
    total: 100,
    indexed: 0,
    deferred: 0,
    failed: 0,
    building: false,
    built: false,
    indexSizeBytes: 0,
  };

  it("shows building progress", () => {
    expect(formatIndexStatusLabel({ ...base, indexed: 30, building: true })).toContain("構築中");
  });

  it("shows unbuilt state", () => {
    expect(formatIndexStatusLabel(base)).toContain("未構築");
  });

  it("shows indexed counts, deferred online-only, failures, and size", () => {
    const label = formatIndexStatusLabel({
      ...base,
      total: 1200,
      indexed: 1000,
      deferred: 180,
      failed: 20,
      built: true,
      indexSizeBytes: 52_428_800,
    });
    expect(label).toContain("1,000");
    expect(label).toContain("1,200");
    expect(label).toContain("180"); // deferred online-only
    expect(label).toContain("20"); // failed
    expect(label).toContain("50 MB"); // index size
  });

  it("omits deferred/failed clauses when zero", () => {
    const label = formatIndexStatusLabel({
      ...base,
      total: 10,
      indexed: 10,
      built: true,
      indexSizeBytes: 1024,
    });
    expect(label).not.toContain("スキップ");
    expect(label).not.toContain("失敗");
  });
});

describe("canStartBuild", () => {
  it("is disabled only while building", () => {
    const base = {
      total: 1,
      indexed: 0,
      deferred: 0,
      failed: 0,
      built: false,
      indexSizeBytes: 0,
    };
    expect(canStartBuild({ ...base, building: false })).toBe(true);
    expect(canStartBuild({ ...base, building: true })).toBe(false);
  });
});
