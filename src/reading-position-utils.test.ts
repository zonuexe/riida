import { describe, expect, it } from "vitest";
import {
  clampReadingPositionOffsetRatio,
  parseCachedReadingPosition,
  readingPositionStorageKey,
} from "./reading-position-utils";

describe("readingPositionStorageKey", () => {
  it("namespaces the file path", () => {
    expect(readingPositionStorageKey("/Books/Rust.pdf")).toBe(
      "riida:reading-position:/Books/Rust.pdf",
    );
  });
});

describe("clampReadingPositionOffsetRatio", () => {
  it("clamps values into the 0..1 range", () => {
    expect(clampReadingPositionOffsetRatio(-0.5)).toBe(0);
    expect(clampReadingPositionOffsetRatio(0.25)).toBe(0.25);
    expect(clampReadingPositionOffsetRatio(1.5)).toBe(1);
  });
});

describe("parseCachedReadingPosition", () => {
  it("returns null for empty or invalid JSON", () => {
    expect(parseCachedReadingPosition(null)).toBeNull();
    expect(parseCachedReadingPosition("not json")).toBeNull();
  });

  it("returns null for incomplete payloads", () => {
    expect(parseCachedReadingPosition(JSON.stringify({ filePath: "/Books/Rust.pdf" }))).toBeNull();
  });

  it("parses a valid payload and clamps the offset ratio", () => {
    expect(
      parseCachedReadingPosition(
        JSON.stringify({
          filePath: "/Books/Rust.pdf",
          pageNumber: 12,
          pageOffsetRatio: 1.4,
          updatedAt: 123,
        }),
      ),
    ).toEqual({
      filePath: "/Books/Rust.pdf",
      pageNumber: 12,
      pageOffsetRatio: 1,
      updatedAt: 123,
    });
  });
});
