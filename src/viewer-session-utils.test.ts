import { describe, expect, it } from "vitest";
import {
  coerceLaunchString,
  parsePersistedLaunchParams,
  parseSettingsPanelSession,
} from "./viewer-session-utils";

describe("coerceLaunchString", () => {
  it("keeps non-empty strings and rejects everything else", () => {
    expect(coerceLaunchString("kindle:1")).toBe("kindle:1");
    expect(coerceLaunchString("")).toBeNull();
    expect(coerceLaunchString(null)).toBeNull();
    expect(coerceLaunchString(undefined)).toBeNull();
    expect(coerceLaunchString(42)).toBeNull();
  });
});

describe("parsePersistedLaunchParams", () => {
  it("reads filePath and source from a valid object", () => {
    expect(parsePersistedLaunchParams('{"filePath":"/a.pdf","source":"kindle"}')).toEqual({
      filePath: "/a.pdf",
      source: "kindle",
    });
  });

  it("coerces missing or non-string fields to null", () => {
    expect(parsePersistedLaunchParams('{"filePath":"/a.pdf"}')).toEqual({
      filePath: "/a.pdf",
      source: null,
    });
    expect(parsePersistedLaunchParams('{"filePath":123,"source":""}')).toEqual({
      filePath: null,
      source: null,
    });
  });

  it("returns null for absent, corrupt, or non-object input", () => {
    expect(parsePersistedLaunchParams(null)).toBeNull();
    expect(parsePersistedLaunchParams("")).toBeNull();
    expect(parsePersistedLaunchParams("not json")).toBeNull();
    expect(parsePersistedLaunchParams('"a string"')).toBeNull();
    expect(parsePersistedLaunchParams("42")).toBeNull();
    expect(parsePersistedLaunchParams("null")).toBeNull();
  });
});

describe("parseSettingsPanelSession", () => {
  it("reads the open flag and scope from a valid object", () => {
    expect(parseSettingsPanelSession('{"open":true,"scope":"file"}')).toEqual({
      open: true,
      scope: "file",
    });
  });

  it("treats anything other than exact matches as the safe default", () => {
    expect(parseSettingsPanelSession('{"open":"yes","scope":"weird"}')).toEqual({
      open: false,
      scope: "global",
    });
    expect(parseSettingsPanelSession("{}")).toEqual({ open: false, scope: "global" });
  });

  it("falls back to the default for absent, corrupt, or non-object input", () => {
    expect(parseSettingsPanelSession(null)).toEqual({ open: false, scope: "global" });
    expect(parseSettingsPanelSession("not json")).toEqual({ open: false, scope: "global" });
    expect(parseSettingsPanelSession("42")).toEqual({ open: false, scope: "global" });
  });
});
