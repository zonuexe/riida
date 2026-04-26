import { describe, expect, it } from "vitest";
import {
  applyViewerSettingsPayloadToState,
  switchViewerSettingsScopeInState,
  type ViewerSettings,
} from "./viewer-settings-utils";

const defaultSettings: ViewerSettings = {
  pageMode: "spread",
  bindingDirection: "left",
  zoomMode: "fit-height",
  alignMode: "center",
  verticalGapMode: "compact",
  treatFirstPageAsCover: true,
  backgroundMode: "inherit-theme",
  scrollMode: "continuous",
  epubFontSize: 100,
};

describe("applyViewerSettingsPayloadToState", () => {
  it("defaults to file scope when a file override exists", () => {
    const fileOverride: ViewerSettings = {
      ...defaultSettings,
      bindingDirection: "right",
      backgroundMode: "night-city",
    };
    const state = applyViewerSettingsPayloadToState({
      global: defaultSettings,
      file: fileOverride,
      effective: fileOverride,
      usesFileOverride: true,
    });

    expect(state.scope).toBe("file");
    expect(state.bindingDirection).toBe("right");
    expect(state.backgroundMode).toBe("night-city");
    expect(state.globalDraft.bindingDirection).toBe("left");
    expect(state.globalDraft.backgroundMode).toBe("inherit-theme");
    expect(state.fileDraft.bindingDirection).toBe("right");
    expect(state.fileDraft.backgroundMode).toBe("night-city");
    expect(state.hasFileOverride).toBe(true);
  });

  it("uses global scope when no file override exists", () => {
    const state = applyViewerSettingsPayloadToState({
      global: defaultSettings,
      file: null,
      effective: defaultSettings,
      usesFileOverride: false,
    });

    expect(state.scope).toBe("global");
    expect(state.fileDraft).toEqual(defaultSettings);
    expect(state.hasFileOverride).toBe(false);
  });
});

describe("switchViewerSettingsScopeInState", () => {
  it("hydrates fileDraft from current effective settings when enabling file scope without override", () => {
    const state = switchViewerSettingsScopeInState(
      {
        ...defaultSettings,
        globalDraft: { ...defaultSettings },
        fileDraft: { ...defaultSettings, bindingDirection: "left" },
        scope: "global",
        hasFileOverride: false,
      },
      "file",
    );

    expect(state.scope).toBe("file");
    expect(state.fileDraft).toEqual(defaultSettings);
  });

  it("preserves existing fileDraft when a file override already exists", () => {
    const state = switchViewerSettingsScopeInState(
      {
        ...defaultSettings,
        globalDraft: { ...defaultSettings },
        fileDraft: { ...defaultSettings, bindingDirection: "right" },
        scope: "global",
        hasFileOverride: true,
      },
      "file",
    );

    expect(state.scope).toBe("file");
    expect(state.fileDraft.bindingDirection).toBe("right");
  });
});
