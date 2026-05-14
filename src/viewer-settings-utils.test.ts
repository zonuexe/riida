import { describe, expect, it } from "vitest";
import {
  applyViewerSettingsPayloadToState,
  normalizeViewerSourceType,
  preferredExplicitViewerBackgroundMode,
  resolveViewerThemeMode,
  switchViewerSettingsScopeInState,
  viewerColorPaletteForMode,
  viewerExtraVerticalGap,
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

describe("normalizeViewerSourceType", () => {
  it("returns 'epub' for the epub literal", () => {
    expect(normalizeViewerSourceType("epub")).toBe("epub");
  });

  it("defaults to 'pdf' for unknown, null, or undefined values", () => {
    expect(normalizeViewerSourceType("pdf")).toBe("pdf");
    expect(normalizeViewerSourceType("native")).toBe("pdf");
    expect(normalizeViewerSourceType(null)).toBe("pdf");
    expect(normalizeViewerSourceType(undefined)).toBe("pdf");
    expect(normalizeViewerSourceType("")).toBe("pdf");
  });
});

describe("resolveViewerThemeMode", () => {
  it("returns the explicit mode when not inherited", () => {
    expect(resolveViewerThemeMode("snow-white", "night-city")).toBe("snow-white");
    expect(resolveViewerThemeMode("night-city", "default")).toBe("night-city");
    expect(resolveViewerThemeMode("navy-blue", null)).toBe("navy-blue");
    expect(resolveViewerThemeMode("default", "snow-white")).toBe("default");
  });

  it("falls back to the supplied app theme when set to inherit", () => {
    expect(resolveViewerThemeMode("inherit-theme", "snow-white")).toBe("snow-white");
    expect(resolveViewerThemeMode("inherit-theme", "night-city")).toBe("night-city");
    expect(resolveViewerThemeMode("inherit-theme", "navy-blue")).toBe("navy-blue");
    expect(resolveViewerThemeMode("inherit-theme", "default")).toBe("default");
  });

  it("treats nullish or unknown app themes as 'default' when inheriting", () => {
    expect(resolveViewerThemeMode("inherit-theme", null)).toBe("default");
    expect(resolveViewerThemeMode("inherit-theme", undefined)).toBe("default");
    expect(resolveViewerThemeMode("inherit-theme", "nonsense")).toBe("default");
  });
});

describe("preferredExplicitViewerBackgroundMode", () => {
  it("is an alias of resolveViewerThemeMode for inherited values", () => {
    expect(preferredExplicitViewerBackgroundMode("inherit-theme", "night-city")).toBe(
      resolveViewerThemeMode("inherit-theme", "night-city"),
    );
    expect(preferredExplicitViewerBackgroundMode("snow-white", "default")).toBe("snow-white");
  });
});

describe("viewerColorPaletteForMode", () => {
  it("returns a palette per resolved theme", () => {
    expect(viewerColorPaletteForMode("snow-white", "default").background).toBe("#f5f5f7");
    expect(viewerColorPaletteForMode("night-city", "default").foreground).toBe("#f2f2f7");
    expect(viewerColorPaletteForMode("navy-blue", "default").link).toBe("#9fc5ff");
  });

  it("follows the supplied app theme when set to inherit", () => {
    expect(viewerColorPaletteForMode("inherit-theme", "night-city")).toEqual(
      viewerColorPaletteForMode("night-city", "default"),
    );
    expect(viewerColorPaletteForMode("inherit-theme", null)).toEqual(
      viewerColorPaletteForMode("default", "default"),
    );
  });
});

describe("viewerExtraVerticalGap", () => {
  it("maps gap modes to pixel offsets", () => {
    expect(viewerExtraVerticalGap("wide")).toBe(40);
    expect(viewerExtraVerticalGap("compact")).toBe(16);
    expect(viewerExtraVerticalGap("none")).toBe(0);
  });
});
