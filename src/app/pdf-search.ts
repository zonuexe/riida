// In-document search for the PDF.js renderer: indexing page text, finding
// matches and stepping through them.

import {
  buildPdfSearchPageIndex,
  collectPdfTextLayerItems,
  findPdfSearchMatchesInPage,
  type PdfSearchMatch,
  type PdfSearchPageIndex,
  pickInitialMatchIndex,
  searchNormalize,
} from "../pdf-search-utils";
import {
  applyPdfSearchHighlights,
  closePdfSearch,
  findPageElement,
  pdfSearchState,
  syncPdfSearchUi,
} from "./pdf-search-highlights";
import { findPdfRenderGroupIndexForPage, schedulePdfRenderWindowUpdate } from "./pdf-viewer";
import { appState } from "./state";

async function ensurePdfSearchPageIndex(pageNumber: number): Promise<PdfSearchPageIndex | null> {
  const cached = pdfSearchState.pageIndices.get(pageNumber);
  if (cached) return cached;

  const session = appState.activePdfRenderSession;
  if (!session) return null;

  try {
    const page = await session.pdfDocument.getPage(pageNumber);
    const stream = page.streamTextContent() as ReadableStream<{ items: Array<{ str?: string }> }>;
    const reader = stream.getReader();
    // Only items that TextLayer renders as a text span may be indexed;
    // `itemIndex` is resolved against the page's spans in DOM order.
    const allItems: Array<{ str: string }> = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      allItems.push(...collectPdfTextLayerItems(value.items));
    }
    const index = buildPdfSearchPageIndex(allItems);
    pdfSearchState.pageIndices.set(pageNumber, index);
    return index;
  } catch (err) {
    console.error(`[pdf-search] ensurePdfSearchPageIndex(${pageNumber}) threw:`, err);
    return null;
  }
}

async function executePdfSearch(query: string) {
  const session = appState.activePdfRenderSession;
  const normalizedQuery = searchNormalize(query);
  console.log(
    `[pdf-search] executePdfSearch query="${query}" normalizedQuery="${normalizedQuery}" session=${session ? "ok" : "null"}`,
  );

  if (!session || !normalizedQuery) {
    pdfSearchState.matches = [];
    pdfSearchState.currentMatchIndex = -1;
    applyPdfSearchHighlights();
    syncPdfSearchUi();
    return;
  }

  const matches: PdfSearchMatch[] = [];
  const totalPages = session.pdfDocument.numPages;

  for (let p = 1; p <= totalPages; p++) {
    const index = await ensurePdfSearchPageIndex(p);
    if (!index) continue;

    if (pdfSearchState.query !== query) return;

    matches.push(...findPdfSearchMatchesInPage(index.normalizedText, normalizedQuery, p));
  }

  pdfSearchState.matches = matches;
  pdfSearchState.currentMatchIndex = pickInitialMatchIndex(
    matches,
    appState.activeReadingPosition?.pageNumber ?? 1,
  );

  applyPdfSearchHighlights();
  syncPdfSearchUi();

  if (pdfSearchState.currentMatchIndex >= 0) {
    scrollToPdfSearchMatch(pdfSearchState.currentMatchIndex);
  }
}

function scrollToPdfSearchMatch(index: number) {
  const match = pdfSearchState.matches[index];
  if (!match) return;

  const session = appState.activePdfRenderSession;
  if (!session) return;

  const groupIndex = findPdfRenderGroupIndexForPage(session, match.pageNumber);
  if (groupIndex >= 0) {
    schedulePdfRenderWindowUpdate(session, groupIndex);
  }

  const attemptScroll = (attempts: number) => {
    const pageEl = findPageElement(match.pageNumber);
    if (!pageEl || pageEl.dataset.rendered !== "true") {
      if (attempts < 8) {
        requestAnimationFrame(() => attemptScroll(attempts + 1));
      }
      return;
    }
    const stageEl = session.stageEl;
    const stageRect = stageEl.getBoundingClientRect();
    const pageRect = pageEl.getBoundingClientRect();
    const pageTopInStage = stageEl.scrollTop + (pageRect.top - stageRect.top);
    stageEl.scrollTo({ top: Math.max(pageTopInStage - 32, 0), behavior: "smooth" });
    applyPdfSearchHighlights();
  };

  requestAnimationFrame(() => attemptScroll(0));
}

function navigatePdfSearchForward() {
  if (pdfSearchState.matches.length === 0) return;
  pdfSearchState.currentMatchIndex =
    (pdfSearchState.currentMatchIndex + 1) % pdfSearchState.matches.length;
  applyPdfSearchHighlights();
  syncPdfSearchUi();
  scrollToPdfSearchMatch(pdfSearchState.currentMatchIndex);
}

function navigatePdfSearchBackward() {
  if (pdfSearchState.matches.length === 0) return;
  pdfSearchState.currentMatchIndex =
    (pdfSearchState.currentMatchIndex - 1 + pdfSearchState.matches.length) %
    pdfSearchState.matches.length;
  applyPdfSearchHighlights();
  syncPdfSearchUi();
  scrollToPdfSearchMatch(pdfSearchState.currentMatchIndex);
}

export function openPdfSearch() {
  const bar = document.querySelector<HTMLElement>("#pdf-search-bar");
  const input = document.querySelector<HTMLInputElement>("#pdf-search-input");
  if (!bar || !input) return;

  pdfSearchState.isOpen = true;
  bar.hidden = false;
  input.select();
  input.focus();
}

export function isPdfSearchShortcut(event: KeyboardEvent): boolean {
  const isMac = navigator.platform.startsWith("Mac");
  return (
    event.key === "f" && (isMac ? event.metaKey : event.ctrlKey) && !event.shiftKey && !event.altKey
  );
}

export function initPdfSearch() {
  const pdfSearchInputEl = document.querySelector<HTMLInputElement>("#pdf-search-input");
  const pdfSearchPrevEl = document.querySelector<HTMLButtonElement>("#pdf-search-prev");
  const pdfSearchNextEl = document.querySelector<HTMLButtonElement>("#pdf-search-next");
  const pdfSearchCloseEl = document.querySelector<HTMLButtonElement>("#pdf-search-close");

  pdfSearchInputEl?.addEventListener("input", () => {
    const query = pdfSearchInputEl.value;
    pdfSearchState.query = query;
    if (pdfSearchState.searchTimer !== null) {
      window.clearTimeout(pdfSearchState.searchTimer);
    }
    pdfSearchState.searchTimer = window.setTimeout(() => {
      void executePdfSearch(query);
    }, 200);
  });

  pdfSearchInputEl?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      if (event.shiftKey) {
        navigatePdfSearchBackward();
      } else {
        navigatePdfSearchForward();
      }
    }
  });

  pdfSearchPrevEl?.addEventListener("click", () => navigatePdfSearchBackward());
  pdfSearchNextEl?.addEventListener("click", () => navigatePdfSearchForward());
  pdfSearchCloseEl?.addEventListener("click", () => closePdfSearch());
}
