// Full-text search results in the library view and the index controls in
// Settings.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { confirm } from "@tauri-apps/plugin-dialog";
import {
  canStartBuild,
  formatIndexStatusLabel,
  type FullTextHit,
  type FullTextIndexStatus,
  groupHitsByBook,
  jumpTargetForHit,
  locationLabel,
} from "../fulltext-ui";
import { navigateToState } from "./navigation";
import { appState, viewerState } from "./state";
import { openBookMetadataEditor } from "../main";

// Monotonic token so stale async full-text results from a superseded query are
// ignored when they resolve out of order.
let fulltextQueryToken = 0;

const FULLTEXT_INCLUDE_ONLINE_KEY = "riida.fulltext.includeOnlineOnly";

// Whether the full-text index has been built (opt-in). Kept in sync from the
// status command at startup, on build completion, and when settings open. Used
// to skip backend search calls entirely until the user has built the index.
let fulltextBuilt = false;

/** Open a book from a full-text hit, jumping to the matched location. */
function openFulltextHit(
  filePath: string,
  location: { kind: "metadata" | "note" | "body"; page: number | null; anchor: string | null },
) {
  // External books (Kindle) have no viewer; activate them the way the library
  // list does, by opening the metadata editor instead of navigating.
  const book = appState.lastSnapshot?.books.find((candidate) => candidate.filePath === filePath);
  if (book && !book.isOpenable) {
    void openBookMetadataEditor(book);
    return;
  }
  const target = jumpTargetForHit(location);
  appState.pendingViewerJump = target ? { filePath, page: target.page, cfi: target.cfi } : null;
  void navigateToState(
    {
      bookFilePath: filePath,
      pdfPage: target?.page ?? null,
      epubCfi: target?.cfi ?? null,
      activeDirectory: viewerState.activeDirectory,
      activeTag: viewerState.activeTag,
      activeExternalSource: viewerState.activeExternalSource,
      activeShelf: viewerState.activeShelf,
      activeTagDirectOnly: viewerState.activeTagDirectOnly,
      searchQuery: viewerState.searchQuery,
    },
    "push",
  );
}

/** Fetch and render in-content search hits for the current query. */
export async function renderFulltextResults(query: string) {
  const containerEl = document.querySelector<HTMLElement>("#fulltext-results");
  const listEl = document.querySelector<HTMLElement>("#fulltext-results-list");
  const countEl = document.querySelector<HTMLElement>("#fulltext-results-count");
  if (!containerEl || !listEl) {
    return;
  }

  const token = ++fulltextQueryToken;
  const trimmed = query.trim();
  if (!fulltextBuilt || trimmed.length === 0) {
    containerEl.hidden = true;
    listEl.replaceChildren();
    return;
  }

  let hits: FullTextHit[];
  try {
    hits = await invoke<FullTextHit[]>("search_fulltext", { query: trimmed, limit: 50 });
  } catch (error) {
    console.error("search_fulltext failed:", error);
    return;
  }
  if (token !== fulltextQueryToken) {
    return; // A newer query superseded this one.
  }
  if (!Array.isArray(hits)) {
    return;
  }

  const groups = groupHitsByBook(hits);
  if (groups.length === 0) {
    containerEl.hidden = true;
    listEl.replaceChildren();
    return;
  }

  listEl.replaceChildren();
  for (const group of groups) {
    const itemEl = document.createElement("article");
    itemEl.className = "fulltext-hit";

    const titleEl = document.createElement("button");
    titleEl.type = "button";
    titleEl.className = "fulltext-hit-title";
    titleEl.textContent = group.title || group.filePath;
    const primary = group.locations[0];
    titleEl.addEventListener("click", () => {
      if (primary) {
        openFulltextHit(group.filePath, primary);
      }
    });
    itemEl.appendChild(titleEl);

    const locsEl = document.createElement("div");
    locsEl.className = "fulltext-hit-locations";
    for (const loc of group.locations) {
      const locEl = document.createElement("button");
      locEl.type = "button";
      locEl.className = "fulltext-hit-snippet";

      const labelEl = document.createElement("span");
      labelEl.className = "fulltext-hit-loc-label";
      labelEl.textContent = locationLabel(loc);

      const snippetEl = document.createElement("span");
      snippetEl.className = "fulltext-hit-snippet-text";
      // tantivy's snippet HTML escapes the source text and only wraps matched
      // terms in <b>, so assigning it is safe (no raw user/content markup).
      snippetEl.innerHTML = loc.snippetHtml;

      locEl.append(labelEl, snippetEl);
      locEl.addEventListener("click", () => openFulltextHit(group.filePath, loc));
      locsEl.appendChild(locEl);
    }
    itemEl.appendChild(locsEl);
    listEl.appendChild(itemEl);
  }

  if (countEl) {
    countEl.textContent = `${groups.length} 冊`;
  }
  containerEl.hidden = false;
}

/** Refresh the settings panel's full-text status line and controls. */
export async function refreshFulltextStatus() {
  const statusEl = document.querySelector<HTMLElement>("#fulltext-status");
  const buildEl = document.querySelector<HTMLButtonElement>("#fulltext-build");
  const clearEl = document.querySelector<HTMLButtonElement>("#fulltext-clear");
  const includeOnlineEl = document.querySelector<HTMLInputElement>("#fulltext-include-online-only");
  if (includeOnlineEl) {
    includeOnlineEl.checked = localStorage.getItem(FULLTEXT_INCLUDE_ONLINE_KEY) === "1";
  }
  let status: FullTextIndexStatus | null;
  try {
    status = await invoke<FullTextIndexStatus | null>("fulltext_index_status");
  } catch (error) {
    console.error("fulltext_index_status failed:", error);
    return;
  }
  if (!status) {
    return;
  }
  fulltextBuilt = status.built;
  if (statusEl) {
    statusEl.textContent = formatIndexStatusLabel(status);
  }
  if (buildEl) {
    buildEl.disabled = !canStartBuild(status);
    buildEl.innerHTML = status.built
      ? '<i class="fa-solid fa-rotate" aria-hidden="true"></i> Rebuild index'
      : '<i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i> Build index';
  }
  if (clearEl) {
    clearEl.hidden = !status.built;
    clearEl.disabled = status.building;
  }
}

export function initFulltextSettings() {
  const fulltextBuildEl = document.querySelector<HTMLButtonElement>("#fulltext-build");
  const fulltextIncludeOnlineEl = document.querySelector<HTMLInputElement>(
    "#fulltext-include-online-only",
  );
  const fulltextClearEl = document.querySelector<HTMLButtonElement>("#fulltext-clear");
  fulltextIncludeOnlineEl?.addEventListener("change", () => {
    localStorage.setItem(FULLTEXT_INCLUDE_ONLINE_KEY, fulltextIncludeOnlineEl.checked ? "1" : "0");
  });
  fulltextBuildEl?.addEventListener("click", async () => {
    fulltextBuildEl.disabled = true;
    try {
      await invoke("fulltext_build_index", {
        includeOnlineOnly: fulltextIncludeOnlineEl?.checked ?? false,
      });
    } catch (error) {
      console.error("fulltext_build_index failed:", error);
    }
    await refreshFulltextStatus();
  });
  fulltextClearEl?.addEventListener("click", async () => {
    const confirmed = await confirm(
      "全文検索の索引を削除します。ディスクは解放されますが、再度検索するには作り直しが必要です。",
      { title: "索引をクリア", kind: "warning" },
    );
    if (!confirmed) {
      return;
    }
    fulltextClearEl.disabled = true;
    try {
      await invoke("fulltext_clear_index");
      fulltextBuilt = false;
      void renderFulltextResults(viewerState.searchQuery);
    } catch (error) {
      console.error("fulltext_clear_index failed:", error);
    }
    fulltextClearEl.disabled = false;
    await refreshFulltextStatus();
  });
}

export async function registerFulltextEvents() {
  await listen<{ done: number; total: number; filePath: string }>("fulltext-progress", (event) => {
    const statusEl = document.querySelector<HTMLElement>("#fulltext-status");
    if (statusEl) {
      const { done, total } = event.payload;
      statusEl.textContent = `索引を構築中… ${done.toLocaleString()} / ${total.toLocaleString()} 冊`;
    }
  });

  await listen<number>("fulltext-complete", () => {
    fulltextBuilt = true;
    void refreshFulltextStatus();
    // Surface in-content results now that the index exists.
    void renderFulltextResults(viewerState.searchQuery);
  });

  await listen<string>("fulltext-error", (event) => {
    console.error("fulltext build error:", event.payload);
    void refreshFulltextStatus();
  });

  // Learn whether a prior session already built the index (so search calls and
  // the results group are enabled) without triggering any indexing.
  void refreshFulltextStatus();
}
