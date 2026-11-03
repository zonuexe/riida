// UI language selection and static-markup translation (see src/i18n.ts for the
// catalogs).

import { isMessageKey, type MessageKey, resolveLocale, translate } from "../i18n";

export const uiLocale = resolveLocale(
  navigator.languages.length > 0 ? navigator.languages : [navigator.language],
);

export function t(key: MessageKey, params?: Record<string, string | number>) {
  return translate(uiLocale, key, params);
}

/** Replace the English copy of elements marked `data-i18n` in the markup. */
export function applyStaticTranslations() {
  document.documentElement.lang = uiLocale;
  for (const element of document.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const key = element.dataset.i18n;
    if (key && isMessageKey(key)) {
      element.textContent = t(key);
    }
  }
}
