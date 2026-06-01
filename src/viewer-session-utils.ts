// Parsers for the standalone viewer window's sessionStorage state.
//
// A settings change reloads the viewer window, so its launch params and the
// settings-panel open/scope state are mirrored into sessionStorage to survive
// the reload. sessionStorage is shared and can hold stale or foreign data, so
// these parsers validate that the stored value is an object before reading
// fields, mirroring the valibot boundary schemas used for cached reading
// positions and metadata imports.

import * as v from "valibot";
import type { ViewerSettingsScope } from "./viewer-settings-utils";

export type ViewerLaunchParams = {
  filePath: string | null;
  source: string | null;
};

export type ViewerSettingsPanelSession = {
  open: boolean;
  scope: ViewerSettingsScope;
};

// Accept any object (extra keys ignored); individual fields are coerced
// leniently below so a malformed field degrades to a safe default rather than
// rejecting the whole record.
const SessionObjectSchema = v.looseObject({});

export function coerceLaunchString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseSessionObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = v.safeParse(SessionObjectSchema, parsed);
  return result.success ? (result.output as Record<string, unknown>) : null;
}

export function parsePersistedLaunchParams(raw: string | null): ViewerLaunchParams | null {
  const obj = parseSessionObject(raw);
  if (!obj) return null;
  return {
    filePath: coerceLaunchString(obj.filePath),
    source: coerceLaunchString(obj.source),
  };
}

export function parseSettingsPanelSession(raw: string | null): ViewerSettingsPanelSession {
  const obj = parseSessionObject(raw);
  if (!obj) return { open: false, scope: "global" };
  return {
    open: obj.open === true,
    scope: obj.scope === "file" ? "file" : "global",
  };
}
