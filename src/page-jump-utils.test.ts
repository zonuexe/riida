import { describe, expect, it } from "vitest";
import { parseRequestedPageNumber } from "./page-jump-utils";

describe("parseRequestedPageNumber", () => {
  it("accepts positive integers", () => {
    expect(parseRequestedPageNumber("12")).toBe(12);
    expect(parseRequestedPageNumber(" 7 ")).toBe(7);
  });

  it("rejects zero and non-numeric input", () => {
    expect(parseRequestedPageNumber("0")).toBeNull();
    expect(parseRequestedPageNumber("-3")).toBeNull();
    expect(parseRequestedPageNumber("1.5")).toBeNull();
    expect(parseRequestedPageNumber("abc")).toBeNull();
    expect(parseRequestedPageNumber("")).toBeNull();
  });
});
