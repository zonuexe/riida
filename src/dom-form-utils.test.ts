import { describe, expect, it } from "vitest";
import { shouldSyncControlValue } from "./dom-form-utils";

describe("shouldSyncControlValue", () => {
  it("writes when the control is unfocused and the value differs", () => {
    expect(
      shouldSyncControlValue({ isFocused: false, currentValue: "old", nextValue: "new" }),
    ).toBe(true);
  });

  it("never writes while the control is focused, even if the value differs", () => {
    expect(shouldSyncControlValue({ isFocused: true, currentValue: "old", nextValue: "new" })).toBe(
      false,
    );
  });

  it("skips the write when the value already matches", () => {
    expect(
      shouldSyncControlValue({ isFocused: false, currentValue: "same", nextValue: "same" }),
    ).toBe(false);
  });

  it("treats an empty-string edit as a real change", () => {
    expect(shouldSyncControlValue({ isFocused: false, currentValue: "x", nextValue: "" })).toBe(
      true,
    );
  });
});
