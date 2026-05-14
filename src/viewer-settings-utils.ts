import { normalizeAppTheme, type AppTheme } from "./app-config-utils";

export type ViewerSourceType = "pdf" | "epub";

export type ViewerSettings = {
  pageMode: "single" | "spread";
  bindingDirection: "left" | "right" | "auto";
  zoomMode: "fit-width" | "fit-height" | "original";
  alignMode: "left" | "center" | "right";
  verticalGapMode: "wide" | "compact" | "none";
  treatFirstPageAsCover: boolean;
  backgroundMode: "inherit-theme" | "default" | "snow-white" | "night-city" | "navy-blue";
  scrollMode: "continuous" | "paged";
  epubFontSize: number;
};

export type ViewerBackgroundMode = ViewerSettings["backgroundMode"];

export type ViewerColorPalette = {
  background: string;
  foreground: string;
  link: string;
};

export type ViewerSettingsScope = "global" | "file";

export type ViewerSettingsPayload = {
  global: ViewerSettings;
  file: ViewerSettings | null;
  effective: ViewerSettings;
  usesFileOverride: boolean;
};

export type ViewerSettingsStateShape = ViewerSettings & {
  globalDraft: ViewerSettings;
  fileDraft: ViewerSettings;
  scope: ViewerSettingsScope;
  hasFileOverride: boolean;
};

export function normalizeViewerSourceType(value: string | null | undefined): ViewerSourceType {
  return value === "epub" ? "epub" : "pdf";
}

export function resolveViewerThemeMode(
  backgroundMode: ViewerBackgroundMode,
  appTheme: AppTheme | string | null | undefined,
): Exclude<ViewerBackgroundMode, "inherit-theme"> {
  if (backgroundMode !== "inherit-theme") {
    return backgroundMode;
  }
  return normalizeAppTheme(appTheme ?? "default");
}

export function preferredExplicitViewerBackgroundMode(
  backgroundMode: ViewerBackgroundMode,
  appTheme: AppTheme | string | null | undefined,
): Exclude<ViewerBackgroundMode, "inherit-theme"> {
  return resolveViewerThemeMode(backgroundMode, appTheme);
}

export function viewerColorPaletteForMode(
  backgroundMode: ViewerBackgroundMode,
  appTheme: AppTheme | string | null | undefined,
): ViewerColorPalette {
  switch (resolveViewerThemeMode(backgroundMode, appTheme)) {
    case "snow-white":
      return {
        background: "#f5f5f7",
        foreground: "#222226",
        link: "#006ee6",
      };
    case "night-city":
      return {
        background: "#101114",
        foreground: "#f2f2f7",
        link: "#5db2ff",
      };
    case "navy-blue":
      return {
        background: "#18314f",
        foreground: "#e5edf7",
        link: "#9fc5ff",
      };
    default:
      return {
        background: "rgb(244 234 212)",
        foreground: "#2b2118",
        link: "#7d4e21",
      };
  }
}

export function viewerExtraVerticalGap(mode: ViewerSettings["verticalGapMode"]): number {
  switch (mode) {
    case "wide":
      return 40;
    case "compact":
      return 16;
    default:
      return 0;
  }
}

export function applyViewerSettingsPayloadToState(
  payload: ViewerSettingsPayload,
  preferredScope: ViewerSettingsScope = payload.usesFileOverride ? "file" : "global",
): ViewerSettingsStateShape {
  const nextScope = preferredScope === "file" ? "file" : "global";

  return {
    ...payload.effective,
    globalDraft: { ...payload.global },
    fileDraft: { ...(payload.file ?? payload.effective) },
    scope: nextScope,
    hasFileOverride: payload.usesFileOverride,
  };
}

export function switchViewerSettingsScopeInState(
  state: ViewerSettingsStateShape,
  requestedScope: ViewerSettingsScope,
): ViewerSettingsStateShape {
  if (requestedScope === "file" && !state.hasFileOverride) {
    return {
      ...state,
      scope: "file",
      fileDraft: {
        pageMode: state.pageMode,
        bindingDirection: state.bindingDirection,
        zoomMode: state.zoomMode,
        alignMode: state.alignMode,
        verticalGapMode: state.verticalGapMode,
        treatFirstPageAsCover: state.treatFirstPageAsCover,
        backgroundMode: state.backgroundMode,
        scrollMode: state.scrollMode,
        epubFontSize: state.epubFontSize,
      },
    };
  }

  return {
    ...state,
    scope: requestedScope,
  };
}
