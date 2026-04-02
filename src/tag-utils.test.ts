import { describe, expect, it } from "vitest";
import { validateTagValue } from "./tag-utils";

describe("validateTagValue", () => {
  it("accepts non-empty plain and hierarchical tags", () => {
    expect(validateTagValue("tech")).toEqual({ ok: true, value: "tech" });
    expect(validateTagValue(" language/lean ")).toEqual({
      ok: true,
      value: "language/lean",
    });
  });

  it("rejects empty tag values", () => {
    expect(validateTagValue("")).toEqual({
      ok: false,
      message: "Tags cannot be empty.",
    });
    expect(validateTagValue("   ")).toEqual({
      ok: false,
      message: "Tags cannot be empty.",
    });
  });

  it("rejects invalid slash placement", () => {
    const expected = {
      ok: false as const,
      message: "Tags cannot start or end with '/', be just '/', or contain '//'.",
    };

    expect(validateTagValue("/")).toEqual(expected);
    expect(validateTagValue("/foo")).toEqual(expected);
    expect(validateTagValue("foo/")).toEqual(expected);
    expect(validateTagValue("foo//bar")).toEqual(expected);
  });
});
