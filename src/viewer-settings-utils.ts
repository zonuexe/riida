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
