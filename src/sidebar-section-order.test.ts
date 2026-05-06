import { describe, expect, it } from "vitest";
import {
  DEFAULT_SIDEBAR_SECTION_ORDER,
  loadSidebarSectionOrder,
  normalizeSidebarSectionOrder,
  reorderSidebarSection,
  saveSidebarSectionOrder,
} from "./sidebar-section-order.ts";

function makeStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return {
    get length() {
      return data.size;
    },
    clear() {
      data.clear();
    },
    getItem(key) {
      return data.get(key) ?? null;
    },
    key(index) {
      return [...data.keys()][index] ?? null;
    },
    removeItem(key) {
      data.delete(key);
    },
    setItem(key, value) {
      data.set(key, String(value));
    },
  } satisfies Storage;
}

describe("normalizeSidebarSectionOrder", () => {
  it("returns the default order for null / undefined / empty input", () => {
    expect(normalizeSidebarSectionOrder(null)).toEqual([...DEFAULT_SIDEBAR_SECTION_ORDER]);
    expect(normalizeSidebarSectionOrder(undefined)).toEqual([...DEFAULT_SIDEBAR_SECTION_ORDER]);
    expect(normalizeSidebarSectionOrder([])).toEqual([...DEFAULT_SIDEBAR_SECTION_ORDER]);
  });

  it("preserves a fully specified order", () => {
    expect(normalizeSidebarSectionOrder(["shelves", "tags", "external", "directories"])).toEqual([
      "shelves",
      "tags",
      "external",
      "directories",
    ]);
  });

  it("appends missing defaults to a partial order", () => {
    expect(normalizeSidebarSectionOrder(["shelves"])).toEqual([
      "shelves",
      "directories",
      "tags",
      "external",
    ]);
  });

  it("drops unknown values and duplicates", () => {
    expect(normalizeSidebarSectionOrder(["shelves", "shelves", "bogus", 42, "tags"])).toEqual([
      "shelves",
      "tags",
      "directories",
      "external",
    ]);
  });
});

describe("loadSidebarSectionOrder / saveSidebarSectionOrder", () => {
  it("returns defaults when nothing is stored", () => {
    const storage = makeStorage();
    expect(loadSidebarSectionOrder(storage)).toEqual([...DEFAULT_SIDEBAR_SECTION_ORDER]);
  });

  it("round-trips through storage", () => {
    const storage = makeStorage();
    saveSidebarSectionOrder(storage, ["shelves", "tags", "directories", "external"]);
    expect(loadSidebarSectionOrder(storage)).toEqual([
      "shelves",
      "tags",
      "directories",
      "external",
    ]);
  });

  it("falls back to defaults on malformed JSON", () => {
    const storage = makeStorage({ "riida.sidebarSectionOrder": "not json" });
    expect(loadSidebarSectionOrder(storage)).toEqual([...DEFAULT_SIDEBAR_SECTION_ORDER]);
  });
});

describe("reorderSidebarSection", () => {
  const base = ["directories", "tags", "external", "shelves"] as const;

  it("moves a section before the target", () => {
    expect(reorderSidebarSection(base, "shelves", "directories", "before")).toEqual([
      "shelves",
      "directories",
      "tags",
      "external",
    ]);
  });

  it("moves a section after the target", () => {
    expect(reorderSidebarSection(base, "directories", "external", "after")).toEqual([
      "tags",
      "external",
      "directories",
      "shelves",
    ]);
  });

  it("is a no-op when source equals target", () => {
    expect(reorderSidebarSection(base, "tags", "tags", "before")).toEqual([...base]);
  });

  it("is a no-op when the target is not present", () => {
    expect(
      reorderSidebarSection(["directories", "tags"] as const, "shelves", "external", "before"),
    ).toEqual(["directories", "tags"]);
  });
});
