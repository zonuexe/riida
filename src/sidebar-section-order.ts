// Sidebar section ordering — pure helpers for reading/writing the
// user's preferred order of the four top-level navigation sections
// and for computing reorder transitions.

const SIDEBAR_SECTION_KEYS = ["directories", "tags", "external", "shelves"] as const;

export type SidebarSectionKey = (typeof SIDEBAR_SECTION_KEYS)[number];

export const DEFAULT_SIDEBAR_SECTION_ORDER: ReadonlyArray<SidebarSectionKey> = SIDEBAR_SECTION_KEYS;

const STORAGE_KEY = "riida.sidebarSectionOrder";

function isSectionKey(value: unknown): value is SidebarSectionKey {
  return (
    typeof value === "string" && (SIDEBAR_SECTION_KEYS as ReadonlyArray<string>).includes(value)
  );
}

/**
 * Normalise an arbitrary input array into a canonical full ordering:
 * keeps the order of any recognised keys and appends any missing
 * default keys at the end. Drops duplicates and unknown values.
 */
export function normalizeSidebarSectionOrder(
  raw: ReadonlyArray<unknown> | null | undefined,
): SidebarSectionKey[] {
  const seen = new Set<SidebarSectionKey>();
  const out: SidebarSectionKey[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (isSectionKey(item) && !seen.has(item)) {
        seen.add(item);
        out.push(item);
      }
    }
  }
  for (const key of DEFAULT_SIDEBAR_SECTION_ORDER) {
    if (!seen.has(key)) out.push(key);
  }
  return out;
}

export function loadSidebarSectionOrder(storage: Storage): SidebarSectionKey[] {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [...DEFAULT_SIDEBAR_SECTION_ORDER];
    const parsed = JSON.parse(raw) as unknown;
    return normalizeSidebarSectionOrder(parsed as ReadonlyArray<unknown>);
  } catch {
    return [...DEFAULT_SIDEBAR_SECTION_ORDER];
  }
}

export function saveSidebarSectionOrder(
  storage: Storage,
  order: ReadonlyArray<SidebarSectionKey>,
): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(normalizeSidebarSectionOrder(order)));
  } catch {
    // ignore quota / privacy errors
  }
}

/**
 * Move `sourceKey` to the position of `targetKey`, with `placement`
 * deciding whether the source ends up just before or after the
 * target in the resulting array. Returns a new array; does not
 * mutate the input.
 */
export function reorderSidebarSection(
  order: ReadonlyArray<SidebarSectionKey>,
  sourceKey: SidebarSectionKey,
  targetKey: SidebarSectionKey,
  placement: "before" | "after",
): SidebarSectionKey[] {
  if (sourceKey === targetKey) return [...order];
  const without = order.filter((key) => key !== sourceKey);
  const targetIndex = without.indexOf(targetKey);
  if (targetIndex < 0) return [...order];
  const insertAt = placement === "after" ? targetIndex + 1 : targetIndex;
  const next = [...without];
  next.splice(insertAt, 0, sourceKey);
  return next;
}
