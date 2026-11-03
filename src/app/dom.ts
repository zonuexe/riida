// Small DOM helpers shared by the feature modules.

import { shouldSyncControlValue, type StatusTone, statusToneAttribute } from "../dom-form-utils";

export function finishStartupPhase() {
  document.body.dataset.startup = "ready";
}

// Write a state value into a form control without disrupting the user: skip
// while the control is focused, and skip when the value already matches.
export function syncControlValue(
  element: HTMLInputElement | HTMLTextAreaElement | null,
  value: string,
): void {
  if (!element) {
    return;
  }
  if (
    shouldSyncControlValue({
      isFocused: document.activeElement === element,
      currentValue: element.value,
      nextValue: value,
    })
  ) {
    element.value = value;
  }
}

// Render a status line: hide it when empty, and reflect the tone through the
// `data-tone` attribute (removed for the neutral default).
export function applyStatusMessage(
  statusEl: HTMLElement,
  message: string,
  tone: StatusTone = "neutral",
): void {
  statusEl.hidden = message.length === 0;
  statusEl.textContent = message;
  const toneAttr = statusToneAttribute(tone);
  if (toneAttr === null) {
    delete statusEl.dataset.tone;
  } else {
    statusEl.dataset.tone = toneAttr;
  }
}

export function isEditableTarget(target: EventTarget | null) {
  const element = target instanceof HTMLElement ? target : null;

  if (!element) {
    return false;
  }

  return Boolean(
    element.closest('input, textarea, select, [contenteditable="true"], .ProseMirror, .milkdown'),
  );
}
