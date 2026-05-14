import { describe, expect, it } from "vitest";
import { __testables } from "./main-viewer";

const { readLaunchParams } = __testables;

describe("readLaunchParams (query string fallback)", () => {
  it("returns both filePath and source when present", () => {
    expect(readLaunchParams("?file=/Books/Rust.pdf&source=kindle")).toEqual({
      filePath: "/Books/Rust.pdf",
      source: "kindle",
    });
  });

  it("returns null for missing or empty parameters", () => {
    expect(readLaunchParams("")).toEqual({ filePath: null, source: null });
    expect(readLaunchParams("?file=")).toEqual({ filePath: null, source: null });
    expect(readLaunchParams("?source=kindle")).toEqual({ filePath: null, source: "kindle" });
    expect(readLaunchParams("?file=/Books/Rust.pdf")).toEqual({
      filePath: "/Books/Rust.pdf",
      source: null,
    });
  });

  it("decodes URL-encoded paths", () => {
    expect(readLaunchParams("?file=%2FBooks%2FUser%20Guide.pdf").filePath).toBe(
      "/Books/User Guide.pdf",
    );
  });
});

describe("readLaunchParams (injected globals)", () => {
  it("prefers the injected payload over the query string", () => {
    expect(
      readLaunchParams("?file=/wrong.pdf&source=ignored", {
        filePath: "/Books/Right.pdf",
        source: "kindle",
      }),
    ).toEqual({ filePath: "/Books/Right.pdf", source: "kindle" });
  });

  it("ignores non-string injected values", () => {
    expect(
      readLaunchParams("", {
        filePath: 42 as unknown as string,
        source: null as unknown as string,
      }),
    ).toEqual({ filePath: null, source: null });
  });

  it("treats empty injected strings as null", () => {
    expect(readLaunchParams("", { filePath: "", source: "" })).toEqual({
      filePath: null,
      source: null,
    });
  });
});
