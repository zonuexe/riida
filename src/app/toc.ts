// Table-of-contents panel for PDF outlines and EPUB navigation.

import { appState } from "./state";
import type { PdfOutlineNode } from "./types";
import { currentViewerSettingsSourceType } from "./viewer-settings";
import { navigateViewerToPage } from "./viewer";

export function buildEpubToc() {
  const listEl = document.querySelector<HTMLElement>("#epub-toc-list");
  if (!listEl || !appState.activeEpubBook) return;
  listEl.innerHTML = "";

  type NavItem = { label: string; href: string; subitems?: NavItem[] };
  const toc: NavItem[] =
    (appState.activeEpubBook.navigation as unknown as { toc: NavItem[] }).toc ?? [];

  function appendItems(items: NavItem[], depth: number) {
    for (const item of items) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "epub-toc-item";
      btn.dataset.depth = String(depth);
      btn.textContent = item.label.trim();
      btn.addEventListener("click", () => {
        appState.tocPanelOpen = false;
        syncTocUi();
        if (appState.activeEpubRendition) {
          void appState.activeEpubRendition.display(item.href);
        }
      });
      listEl!.appendChild(btn);
      if (item.subitems && item.subitems.length > 0) {
        appendItems(item.subitems, depth + 1);
      }
    }
  }

  appendItems(toc, 0);
}

export function buildPdfToc() {
  const listEl = document.querySelector<HTMLElement>("#epub-toc-list");
  if (!listEl) return;
  listEl.innerHTML = "";

  const outline = appState.activePdfOutline;
  if (!outline || outline.length === 0) return;

  const session = appState.activePdfRenderSession;

  function appendItems(items: PdfOutlineNode[], depth: number) {
    for (const item of items) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "epub-toc-item";
      btn.dataset.depth = String(depth);
      btn.textContent = item.title;
      btn.addEventListener("click", () => {
        appState.tocPanelOpen = false;
        syncTocUi();
        if (!session || item.dest === null) return;
        const resolver = session.pdfDocument;
        void (async () => {
          let explicitDest: unknown = item.dest;
          if (typeof item.dest === "string" && resolver.getDestination) {
            explicitDest = await resolver.getDestination(item.dest);
          }
          if (!Array.isArray(explicitDest) || explicitDest.length === 0) return;
          const [firstEntry] = explicitDest;
          let pageNumber: number | null = null;
          if (typeof firstEntry === "number" && Number.isFinite(firstEntry)) {
            pageNumber = Math.min(Math.max(Math.trunc(firstEntry) + 1, 1), resolver.numPages);
          } else if (firstEntry && typeof firstEntry === "object" && resolver.getPageIndex) {
            const idx = await resolver.getPageIndex(firstEntry);
            pageNumber = Math.min(Math.max(Math.trunc(idx) + 1, 1), resolver.numPages);
          }
          if (pageNumber !== null) {
            navigateViewerToPage(pageNumber);
          }
        })();
      });
      listEl!.appendChild(btn);
      if (item.items.length > 0) {
        appendItems(item.items, depth + 1);
      }
    }
  }

  appendItems(outline, 0);
}

export function syncTocUi() {
  const toggleEl = document.querySelector<HTMLButtonElement>("#epub-toc-toggle");
  const panelEl = document.querySelector<HTMLElement>("#epub-toc-panel");
  const sourceType = currentViewerSettingsSourceType();
  const isEpub = sourceType === "epub";
  const isPdf =
    sourceType === "pdf" &&
    appState.lastSnapshot?.pdfRenderer === "pdfjs" &&
    appState.activePdfOutline !== null &&
    appState.activePdfOutline.length > 0;
  const hasToc = isEpub || isPdf;
  if (toggleEl) {
    toggleEl.hidden = !hasToc;
    toggleEl.setAttribute("aria-expanded", String(appState.tocPanelOpen));
  }
  if (panelEl) {
    panelEl.hidden = !hasToc || !appState.tocPanelOpen;
  }
}

export function initTocToggle() {
  document.querySelector<HTMLButtonElement>("#epub-toc-toggle")?.addEventListener("click", () => {
    appState.tocPanelOpen = !appState.tocPanelOpen;
    syncTocUi();
  });
}
