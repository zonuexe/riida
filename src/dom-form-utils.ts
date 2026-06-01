/**
 * Decide whether a state-synced form control should have its value overwritten.
 *
 * Two guards keep the sync from fighting the user:
 * - while the control is focused, never overwrite what is being typed;
 * - when the value already matches, skip the write so the caret position and
 *   `input` events are left untouched.
 */
export function shouldSyncControlValue(params: {
  isFocused: boolean;
  currentValue: string;
  nextValue: string;
}): boolean {
  return !params.isFocused && params.currentValue !== params.nextValue;
}

export type StatusTone = "neutral" | "success" | "error";

/**
 * Map a status tone to the `data-tone` attribute value, or `null` when the
 * attribute should be removed. "neutral" carries no styling, so it is dropped
 * rather than written, keeping the default (untoned) appearance.
 */
export function statusToneAttribute(tone: StatusTone): string | null {
  return tone === "neutral" ? null : tone;
}
