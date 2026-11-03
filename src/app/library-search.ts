// Sidebar library search field with query suggestions.

import {
  applySuggestion,
  buildValueSource,
  computeSuggestions,
  type SearchSuggestion,
} from "../search-suggestions";
import { navigateToState } from "./navigation";
import { openShelfEditor } from "./shelf-editor";
import { appState, viewerState } from "./state";

export function initLibrarySearch() {
  const searchInput = document.querySelector<HTMLInputElement>("#library-search");
  const searchSuggestionsEl = document.querySelector<HTMLElement>("#library-search-suggestions");
  const sidebarSearchSaveEl = document.querySelector<HTMLButtonElement>("#sidebar-search-save");
  const sidebarSearchClearEl = document.querySelector<HTMLButtonElement>("#sidebar-search-clear");

  let activeSuggestionIndex = -1;
  let currentSuggestions: SearchSuggestion[] = [];

  function renderSearchSuggestions() {
    if (!searchInput || !searchSuggestionsEl) return;
    const cursor = searchInput.selectionStart ?? searchInput.value.length;
    const valueSource = buildValueSource(appState.lastSnapshot?.books ?? []);
    currentSuggestions = computeSuggestions(searchInput.value, cursor, valueSource);
    activeSuggestionIndex = -1;

    searchSuggestionsEl.innerHTML = "";
    const hasSuggestions = currentSuggestions.length > 0;
    searchSuggestionsEl.hidden = !hasSuggestions;
    searchInput.setAttribute("aria-expanded", hasSuggestions ? "true" : "false");

    for (let i = 0; i < currentSuggestions.length; i++) {
      const s = currentSuggestions[i];
      if (!s) continue;
      const li = document.createElement("li");
      li.role = "option";
      li.setAttribute("aria-selected", "false");

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "library-search-suggestion";

      const label = document.createElement("span");
      label.className = "library-search-suggestion-label";

      if (s.kind === "field") {
        label.textContent = s.completion;
        const hint = document.createElement("span");
        hint.className = "library-search-suggestion-hint";
        hint.textContent = "field";
        btn.append(label, hint);
      } else {
        label.textContent = s.completion;
        const hint = document.createElement("span");
        hint.className = "library-search-suggestion-hint";
        hint.textContent = s.field;
        btn.append(label, hint);
      }

      btn.addEventListener("mousedown", (e) => {
        e.preventDefault(); // keep input focus
        applySearchSuggestion(i);
      });

      li.appendChild(btn);
      searchSuggestionsEl.appendChild(li);
    }
  }

  function applySearchSuggestion(index: number) {
    if (!searchInput || index < 0 || index >= currentSuggestions.length) return;
    const suggestion = currentSuggestions[index];
    if (!suggestion) return;
    const { value } = applySuggestion(
      searchInput.value,
      searchInput.selectionStart ?? searchInput.value.length,
      suggestion,
    );
    // Field completions end with ":" — don't add a space so the user can type the value directly.
    // Value completions end with the value itself — add a space to start the next token.
    const isFieldCompletion = suggestion.kind === "field";
    const finalValue = isFieldCompletion || value.endsWith(" ") ? value : `${value} `;
    searchInput.value = finalValue;
    searchInput.setSelectionRange(finalValue.length, finalValue.length);
    closeSearchSuggestions();
    void navigateToState(
      {
        bookFilePath: null,
        activeDirectory: null,
        activeTag: null,
        activeExternalSource: null,
        activeShelf: null,
        activeTagDirectOnly: false,
        searchQuery: searchInput.value,
      },
      "replace",
    );
    renderSearchSuggestions();
  }

  function setActiveSuggestion(index: number) {
    if (!searchSuggestionsEl) return;
    const items = searchSuggestionsEl.querySelectorAll<HTMLButtonElement>(
      ".library-search-suggestion",
    );
    items.forEach((btn, i) => {
      const selected = i === index;
      btn.setAttribute("aria-selected", selected ? "true" : "false");
      btn.parentElement?.setAttribute("aria-selected", selected ? "true" : "false");
    });
    activeSuggestionIndex = index;
  }

  function closeSearchSuggestions() {
    if (!searchSuggestionsEl || !searchInput) return;
    searchSuggestionsEl.hidden = true;
    searchInput.setAttribute("aria-expanded", "false");
    currentSuggestions = [];
    activeSuggestionIndex = -1;
  }

  let librarySearchTimer: number | null = null;

  searchInput?.addEventListener("input", () => {
    renderSearchSuggestions();
    if (librarySearchTimer !== null) window.clearTimeout(librarySearchTimer);
    librarySearchTimer = window.setTimeout(() => {
      librarySearchTimer = null;
      void navigateToState(
        {
          bookFilePath: null,
          activeDirectory: null,
          activeTag: null,
          activeExternalSource: null,
          activeShelf: null,
          activeTagDirectOnly: false,
          searchQuery: searchInput.value,
        },
        "replace",
      );
    }, 150);
  });

  searchInput?.addEventListener("keydown", (e) => {
    if (searchSuggestionsEl?.hidden) return;
    const count = currentSuggestions.length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveSuggestion((activeSuggestionIndex + 1) % count);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveSuggestion((activeSuggestionIndex - 1 + count) % count);
    } else if (e.key === "Enter" && activeSuggestionIndex >= 0) {
      e.preventDefault();
      applySearchSuggestion(activeSuggestionIndex);
    } else if (e.key === "Escape") {
      closeSearchSuggestions();
    }
  });

  searchInput?.addEventListener("blur", () => {
    // Delay so mousedown on suggestion fires first
    setTimeout(closeSearchSuggestions, 150);
  });

  searchInput?.addEventListener("focus", () => {
    if (searchInput.value) renderSearchSuggestions();
  });

  searchInput?.addEventListener("click", () => {
    renderSearchSuggestions();
  });
  sidebarSearchSaveEl?.addEventListener("click", () => {
    const presetQuery = viewerState.searchQuery.trim();
    if (presetQuery.length === 0) return;
    openShelfEditor(undefined, presetQuery);
  });
  sidebarSearchClearEl?.addEventListener("click", () => {
    if (librarySearchTimer !== null) {
      window.clearTimeout(librarySearchTimer);
      librarySearchTimer = null;
    }
    if (searchInput) {
      searchInput.value = "";
      closeSearchSuggestions();
      searchInput.focus();
    }
    void navigateToState(
      {
        bookFilePath: null,
        activeDirectory: null,
        activeTag: null,
        activeExternalSource: null,
        activeShelf: null,
        activeTagDirectOnly: false,
        searchQuery: "",
      },
      "replace",
    );
  });
}
