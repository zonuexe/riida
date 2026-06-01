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
