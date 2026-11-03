// Sidebar: directory, tag, external-source and shelf sections, section
// reordering, and the shell controls around it.

import { invoke } from "@tauri-apps/api/core";
import { deriveDirectories, deriveTags, type DirectoryNode } from "../library-utils";
import {
  loadSidebarSectionOrder,
  reorderSidebarSection,
  saveSidebarSectionOrder,
  type SidebarSectionKey,
} from "../sidebar-section-order.ts";
import { openCustomSourceEditor } from "./custom-sources";
import { renderApp } from "./library";
import { refreshShelves } from "./library-data";
import { navigateToState } from "./navigation";
import { openShelfEditor } from "./shelf-editor";
import { appState, viewerState } from "./state";
import { openTagManager } from "./tag-editor";
import type { LibrarySnapshot } from "./types";

export function ensureExpandedPath(path: string | null) {
  if (!path) {
    return;
  }

  let currentPath = path;
  while (true) {
    const separator = currentPath.lastIndexOf("/");
    if (separator <= 0) {
      break;
    }

    currentPath = currentPath.slice(0, separator);
    viewerState.expandedDirectories.add(currentPath);
  }
}

function isNodeVisible(node: DirectoryNode) {
  if (node.depth === 0) {
    return true;
  }

  return node.parentPath ? viewerState.expandedDirectories.has(node.parentPath) : true;
}

function parentTagId(tagId: string) {
  const separator = tagId.lastIndexOf("/");
  return separator >= 0 ? tagId.slice(0, separator) : null;
}

export function ensureExpandedTag(tagId: string | null) {
  if (!tagId) {
    return;
  }

  let currentTag = tagId;
  while (true) {
    const parent = parentTagId(currentTag);
    if (!parent) {
      break;
    }

    viewerState.expandedTags.add(parent);
    currentTag = parent;
  }
}

function isTagVisible(tagId: string, depth: number) {
  if (depth === 0) {
    return true;
  }

  const parent = parentTagId(tagId);
  return parent ? viewerState.expandedTags.has(parent) : true;
}

export function renderSidebar(snapshot: LibrarySnapshot) {
  const navEl = document.querySelector<HTMLElement>("#sidebar-nav");
  if (!navEl) {
    return;
  }

  navEl.innerHTML = "";

  const sections: Record<SidebarSectionKey, HTMLElement> = {
    directories: createSidebarSection("directories"),
    tags: createSidebarSection("tags"),
    external: createSidebarSection("external"),
    shelves: createSidebarSection("shelves"),
  };

  populateDirectoriesSection(sections.directories, snapshot);
  populateTagsSection(sections.tags, snapshot);
  populateExternalSection(sections.external, snapshot);
  populateShelvesSection(sections.shelves, navEl);

  const order = loadSidebarSectionOrder(localStorage);
  for (const key of order) {
    const sectionEl = sections[key];
    if (!sectionEl.dataset.empty) {
      navEl.appendChild(sectionEl);
    }
  }
}

function createSidebarSection(key: SidebarSectionKey): HTMLElement {
  const sectionEl = document.createElement("section");
  sectionEl.className = "sidebar-section";
  sectionEl.dataset.section = key;
  return sectionEl;
}

function attachSidebarSectionDnd(headerEl: HTMLElement, sectionEl: HTMLElement) {
  headerEl.draggable = true;
  headerEl.classList.add("sidebar-section-drag-handle");
  headerEl.addEventListener("dragstart", (event) => {
    sidebarSectionDragKey = (sectionEl.dataset.section as SidebarSectionKey | undefined) ?? null;
    sectionEl.classList.add("is-dragging");
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", sectionEl.dataset.section ?? "");
    }
  });
  headerEl.addEventListener("dragend", () => {
    sidebarSectionDragKey = null;
    sectionEl.classList.remove("is-dragging");
    document
      .querySelectorAll<HTMLElement>(".sidebar-section")
      .forEach((el) => el.classList.remove("is-drop-before", "is-drop-after"));
  });
  sectionEl.addEventListener("dragover", (event) => {
    if (!sidebarSectionDragKey) return;
    const targetKey = sectionEl.dataset.section as SidebarSectionKey | undefined;
    if (!targetKey || targetKey === sidebarSectionDragKey) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    const rect = sectionEl.getBoundingClientRect();
    const above = event.clientY < rect.top + rect.height / 2;
    sectionEl.classList.toggle("is-drop-before", above);
    sectionEl.classList.toggle("is-drop-after", !above);
  });
  sectionEl.addEventListener("dragleave", (event) => {
    // Only clear when actually leaving the section (not its children).
    const related = event.relatedTarget as Node | null;
    if (related && sectionEl.contains(related)) return;
    sectionEl.classList.remove("is-drop-before", "is-drop-after");
  });
  sectionEl.addEventListener("drop", (event) => {
    event.preventDefault();
    const sourceKey = sidebarSectionDragKey;
    sidebarSectionDragKey = null;
    const placement = sectionEl.classList.contains("is-drop-after") ? "after" : "before";
    sectionEl.classList.remove("is-drop-before", "is-drop-after");
    const targetKey = sectionEl.dataset.section as SidebarSectionKey | undefined;
    if (!sourceKey || !targetKey || sourceKey === targetKey) return;
    const current = loadSidebarSectionOrder(localStorage);
    const next = reorderSidebarSection(current, sourceKey, targetKey, placement);
    saveSidebarSectionOrder(localStorage, next);
    renderApp();
  });
}

function populateDirectoriesSection(sectionEl: HTMLElement, snapshot: LibrarySnapshot) {
  const directoryHeader = document.createElement("p");
  directoryHeader.className = "nav-section-title";
  directoryHeader.innerHTML =
    '<i class="fa-solid fa-folder" aria-hidden="true"></i><span>Directories</span>';
  sectionEl.appendChild(directoryHeader);
  attachSidebarSectionDnd(directoryHeader, sectionEl);

  let appended = 0;
  for (const node of deriveDirectories(snapshot)) {
    if (!isNodeVisible(node)) {
      continue;
    }

    const row = document.createElement("div");
    row.className = "nav-tree-row";
    row.style.setProperty("--depth", String(node.depth));

    const button = document.createElement("button");
    button.type = "button";
    button.className = "nav-link nav-tree-link";
    button.classList.toggle("is-active", viewerState.activeDirectory === node.path);

    const labelEl = document.createElement("span");
    labelEl.textContent = node.label;

    const countEl = document.createElement("small");
    countEl.textContent = String(node.count);

    button.appendChild(labelEl);
    button.appendChild(countEl);
    button.addEventListener("click", () => {
      void navigateToState(
        {
          bookFilePath: null,
          activeDirectory: node.path,
          activeTag: null,
          activeExternalSource: null,
          activeShelf: null,
          activeTagDirectOnly: false,
          searchQuery: "",
        },
        "push",
      );
      ensureExpandedPath(node.path);
    });

    if (node.hasChildren) {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "nav-toggle";
      toggle.textContent = viewerState.expandedDirectories.has(node.path) ? "▾" : "▸";
      toggle.setAttribute("aria-label", `Expand or collapse ${node.label}`);
      toggle.addEventListener("click", (event) => {
        event.stopPropagation();
        if (viewerState.expandedDirectories.has(node.path)) {
          viewerState.expandedDirectories.delete(node.path);
        } else {
          viewerState.expandedDirectories.add(node.path);
        }
        renderApp();
      });
      row.appendChild(toggle);
    } else {
      const spacer = document.createElement("span");
      spacer.className = "nav-toggle-spacer";
      spacer.setAttribute("aria-hidden", "true");
      row.appendChild(spacer);
    }

    row.appendChild(button);
    sectionEl.appendChild(row);
    appended += 1;
  }

  // Directories header is always rendered, even when empty.
  void appended;
}

function populateTagsSection(sectionEl: HTMLElement, snapshot: LibrarySnapshot) {
  const tagsHeader = document.createElement("p");
  tagsHeader.className = "nav-section-title";
  tagsHeader.innerHTML = '<i class="fa-solid fa-tags" aria-hidden="true"></i><span>Tags</span>';
  sectionEl.appendChild(tagsHeader);
  attachSidebarSectionDnd(tagsHeader, sectionEl);

  for (const tag of deriveTags(snapshot.books)) {
    if (!isTagVisible(tag.id, tag.depth)) {
      continue;
    }

    const row = document.createElement("div");
    row.className = "nav-tree-row";
    row.style.setProperty("--depth", String(tag.depth));

    const labelEl = document.createElement("span");
    labelEl.textContent = tag.label;

    const countEl = document.createElement("small");
    countEl.textContent = String(tag.count);

    if (tag.hasChildren) {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "nav-toggle";
      toggle.textContent = viewerState.expandedTags.has(tag.id) ? "▾" : "▸";
      toggle.setAttribute("aria-label", `Expand or collapse ${tag.id}`);
      toggle.addEventListener("click", (event) => {
        event.stopPropagation();
        if (viewerState.expandedTags.has(tag.id)) {
          viewerState.expandedTags.delete(tag.id);
        } else {
          viewerState.expandedTags.add(tag.id);
        }
        renderApp();
      });
      row.appendChild(toggle);
    } else {
      const spacer = document.createElement("span");
      spacer.className = "nav-toggle-spacer";
      spacer.setAttribute("aria-hidden", "true");
      row.appendChild(spacer);
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = "nav-link nav-tree-link";
    button.classList.toggle("nav-placeholder", !tag.explicit);
    button.classList.toggle("is-active", viewerState.activeTag === tag.id);
    button.title = tag.id;
    button.appendChild(labelEl);
    button.appendChild(countEl);
    button.addEventListener("click", () => {
      void navigateToState(
        {
          bookFilePath: null,
          activeDirectory: null,
          activeTag: tag.id,
          activeExternalSource: null,
          activeShelf: null,
          activeTagDirectOnly: false,
          searchQuery: viewerState.searchQuery,
        },
        "push",
      );
      ensureExpandedTag(tag.id);
    });
    button.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      openTagManager(tag.id);
    });
    row.appendChild(button);

    sectionEl.appendChild(row);
  }
}

function populateExternalSection(sectionEl: HTMLElement, snapshot: LibrarySnapshot) {
  const enabledExternalSources = appState.lastAppConfig?.enabledExternalSources ?? [];
  const kindleEnabled = enabledExternalSources.includes("kindle");
  const externalBooks = snapshot.books.filter((book) => book.sourceType !== "pdf");
  const kindleCount = externalBooks.filter((book) => book.sourceType === "kindle").length;
  const customSources = snapshot.customSources ?? [];

  const externalHeader = document.createElement("p");
  externalHeader.className = "nav-section-title nav-section-title-with-action";
  const externalHeaderLabel = document.createElement("span");
  externalHeaderLabel.className = "nav-section-title-label";
  const externalHeaderIcon = document.createElement("i");
  externalHeaderIcon.className = "fa-solid fa-up-right-from-square";
  externalHeaderIcon.setAttribute("aria-hidden", "true");
  externalHeaderLabel.appendChild(externalHeaderIcon);
  const externalHeaderText = document.createElement("span");
  externalHeaderText.textContent = "EXTERNAL";
  externalHeaderLabel.appendChild(externalHeaderText);
  externalHeader.appendChild(externalHeaderLabel);
  const externalAddBtn = document.createElement("button");
  externalAddBtn.type = "button";
  externalAddBtn.className = "nav-section-action";
  externalAddBtn.setAttribute("aria-label", "Create a new external source");
  externalAddBtn.title = "Create a new external source";
  externalAddBtn.innerHTML = '<i class="fa-solid fa-plus" aria-hidden="true"></i>';
  externalAddBtn.addEventListener("click", () => {
    openCustomSourceEditor();
  });
  externalHeader.appendChild(externalAddBtn);
  sectionEl.appendChild(externalHeader);
  attachSidebarSectionDnd(externalHeader, sectionEl);

  if (kindleEnabled && kindleCount > 0) {
    const row = document.createElement("div");
    row.className = "nav-tree-row";
    row.style.setProperty("--depth", "0");
    const spacer = document.createElement("span");
    spacer.className = "nav-toggle-spacer";
    spacer.setAttribute("aria-hidden", "true");
    row.appendChild(spacer);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "nav-link nav-tree-link";
    button.classList.toggle("is-active", viewerState.activeExternalSource === "kindle");
    button.innerHTML =
      '<span><i class="fa-brands fa-amazon" aria-hidden="true"></i> Kindle</span><small>' +
      String(kindleCount) +
      "</small>";
    button.addEventListener("click", () => {
      void navigateToState(
        {
          bookFilePath: null,
          activeDirectory: null,
          activeTag: null,
          activeExternalSource: "kindle",
          activeShelf: null,
          activeTagDirectOnly: false,
          searchQuery: viewerState.searchQuery,
        },
        "push",
      );
    });
    row.appendChild(button);
    sectionEl.appendChild(row);
  }

  for (const source of customSources) {
    const count = externalBooks.filter((book) => book.sourceType === source.id).length;
    const row = document.createElement("div");
    row.className = "nav-tree-row";
    row.style.setProperty("--depth", "0");
    const spacer = document.createElement("span");
    spacer.className = "nav-toggle-spacer";
    spacer.setAttribute("aria-hidden", "true");
    row.appendChild(spacer);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "nav-link nav-tree-link";
    button.classList.toggle("is-active", viewerState.activeExternalSource === source.id);
    button.innerHTML =
      `<span><i class="${source.icon}" aria-hidden="true"></i> ${source.name}</span><small>` +
      String(count) +
      "</small>";
    button.addEventListener("click", () => {
      void navigateToState(
        {
          bookFilePath: null,
          activeDirectory: null,
          activeTag: null,
          activeExternalSource: source.id,
          activeShelf: null,
          activeTagDirectOnly: false,
          searchQuery: viewerState.searchQuery,
        },
        "push",
      );
    });
    button.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      openCustomSourceEditor(source);
    });
    row.appendChild(button);
    sectionEl.appendChild(row);
  }
}

function populateShelvesSection(sectionEl: HTMLElement, navEl: HTMLElement) {
  const shelvesHeader = document.createElement("p");
  shelvesHeader.className = "nav-section-title nav-section-title-with-action";
  const shelvesHeaderLabel = document.createElement("span");
  shelvesHeaderLabel.className = "nav-section-title-label";
  const shelvesHeaderIcon = document.createElement("i");
  shelvesHeaderIcon.className = "fa-solid fa-bookmark";
  shelvesHeaderIcon.setAttribute("aria-hidden", "true");
  shelvesHeaderLabel.appendChild(shelvesHeaderIcon);
  const shelvesHeaderText = document.createElement("span");
  shelvesHeaderText.textContent = "SHELVES";
  shelvesHeaderLabel.appendChild(shelvesHeaderText);
  shelvesHeader.appendChild(shelvesHeaderLabel);
  const shelvesAddBtn = document.createElement("button");
  shelvesAddBtn.type = "button";
  shelvesAddBtn.className = "nav-section-action";
  shelvesAddBtn.setAttribute("aria-label", "Create a new shelf");
  shelvesAddBtn.title = "Create a new shelf";
  shelvesAddBtn.innerHTML = '<i class="fa-solid fa-plus" aria-hidden="true"></i>';
  shelvesAddBtn.addEventListener("click", () => {
    openShelfEditor(undefined, viewerState.searchQuery);
  });
  shelvesHeader.appendChild(shelvesAddBtn);
  sectionEl.appendChild(shelvesHeader);
  attachSidebarSectionDnd(shelvesHeader, sectionEl);

  for (const shelf of viewerState.shelves) {
    const row = document.createElement("div");
    row.className = "nav-tree-row shelf-row";
    row.style.setProperty("--depth", "0");
    row.draggable = true;
    row.dataset.shelfId = shelf.id;
    row.addEventListener("dragstart", (event) => {
      shelfDragId = shelf.id;
      row.classList.add("is-dragging");
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", shelf.id);
      }
    });
    row.addEventListener("dragend", () => {
      shelfDragId = null;
      row.classList.remove("is-dragging");
      navEl.querySelectorAll(".shelf-row").forEach((el) => el.classList.remove("is-drop-target"));
    });
    row.addEventListener("dragover", (event) => {
      if (!shelfDragId || shelfDragId === shelf.id) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      row.classList.add("is-drop-target");
    });
    row.addEventListener("dragleave", () => {
      row.classList.remove("is-drop-target");
    });
    row.addEventListener("drop", (event) => {
      event.preventDefault();
      row.classList.remove("is-drop-target");
      const sourceId = shelfDragId;
      shelfDragId = null;
      if (!sourceId || sourceId === shelf.id) return;
      void reorderShelvesByDrop(sourceId, shelf.id);
    });
    const spacer = document.createElement("span");
    spacer.className = "nav-toggle-spacer";
    spacer.setAttribute("aria-hidden", "true");
    row.appendChild(spacer);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "nav-link nav-tree-link";
    button.classList.toggle("is-active", viewerState.activeShelf === shelf.id);
    const iconClass = shelf.icon ?? "fa-solid fa-bookmark";
    const labelEl = document.createElement("span");
    const iconEl = document.createElement("i");
    iconEl.className = iconClass;
    iconEl.setAttribute("aria-hidden", "true");
    labelEl.appendChild(iconEl);
    labelEl.append(` ${shelf.name}`);
    button.appendChild(labelEl);
    button.addEventListener("click", () => {
      void navigateToState(
        {
          bookFilePath: null,
          activeDirectory: null,
          activeTag: null,
          activeExternalSource: null,
          activeShelf: shelf.id,
          activeTagDirectOnly: false,
          searchQuery: "",
        },
        "push",
      );
    });
    button.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      openShelfEditor(shelf);
    });
    row.appendChild(button);
    sectionEl.appendChild(row);
  }
}

let shelfDragId: string | null = null;
let sidebarSectionDragKey: SidebarSectionKey | null = null;

async function reorderShelvesByDrop(sourceId: string, targetId: string) {
  const ids = viewerState.shelves.map((s) => s.id);
  const sourceIndex = ids.indexOf(sourceId);
  const targetIndex = ids.indexOf(targetId);
  if (sourceIndex < 0 || targetIndex < 0) return;
  ids.splice(sourceIndex, 1);
  const insertAt = targetIndex < sourceIndex ? targetIndex : targetIndex;
  ids.splice(insertAt, 0, sourceId);
  // Optimistic local reorder for instant feedback.
  const byId = new Map(viewerState.shelves.map((s) => [s.id, s]));
  viewerState.shelves = ids.map((id) => byId.get(id)!).filter(Boolean);
  renderApp();
  try {
    await invoke("reorder_shelves", { ids });
  } catch (error) {
    console.error("failed to reorder shelves", error);
    await refreshShelves();
    renderApp();
  }
}

export function initShellControls() {
  const sidebarToggleEl = document.querySelector<HTMLButtonElement>("#sidebar-toggle");
  const sidebarHomeOpenEl = document.querySelector<HTMLButtonElement>("#sidebar-home-open");
  const mainPaneScrollEl = document.querySelector<HTMLElement>("#main-pane");
  if (mainPaneScrollEl) {
    let scrollIdleTimer: number | null = null;
    mainPaneScrollEl.addEventListener(
      "scroll",
      () => {
        document.documentElement.classList.add("is-scrolling");
        if (scrollIdleTimer !== null) {
          window.clearTimeout(scrollIdleTimer);
        }
        scrollIdleTimer = window.setTimeout(() => {
          document.documentElement.classList.remove("is-scrolling");
          scrollIdleTimer = null;
        }, 160);
      },
      { passive: true },
    );
  }

  sidebarToggleEl?.addEventListener("click", () => {
    viewerState.sidebarCollapsed = !viewerState.sidebarCollapsed;
    renderApp();
  });

  sidebarHomeOpenEl?.addEventListener("click", () => {
    viewerState.isLibraryWelcomeRequested = false;
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
      "push",
    );
  });
}

export function initSidebarControls() {
  const tagDirectOnlyEl = document.querySelector<HTMLInputElement>("#tag-direct-only");

  tagDirectOnlyEl?.addEventListener("change", () => {
    void navigateToState(
      {
        bookFilePath: null,
        activeDirectory: null,
        activeTag: viewerState.activeTag,
        activeExternalSource: viewerState.activeExternalSource,
        activeShelf: viewerState.activeShelf,
        activeTagDirectOnly: tagDirectOnlyEl.checked,
        searchQuery: viewerState.searchQuery,
      },
      "replace",
    );
  });
}
