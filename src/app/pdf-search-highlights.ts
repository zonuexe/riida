// PDF search state and its marks over the rendered text layer. The renderer
// re-applies the marks as spreads paint and closes the search when it opens a
// document; running a search lives in pdf-search.ts above the renderer.

import type { PdfSearchMatch, PdfSearchPageIndex } from "../pdf-search-utils";
import { appState } from "./state";
export const pdfSearchState: {
  isOpen: boolean;
  query: string;
  pageIndices: Map<number, PdfSearchPageIndex>;
  matches: PdfSearchMatch[];
  currentMatchIndex: number;
  searchTimer: number | null;
} = {
  isOpen: false,
  query: "",
  pageIndices: new Map(),
  matches: [],
  currentMatchIndex: -1,
  searchTimer: null,
};

export function findPageElement(pageNumber: number): HTMLElement | null {
  const session = appState.activePdfRenderSession;
  if (!session) return null;

  for (const plan of session.plans) {
    const el = plan.pageSlots.get(pageNumber);
    if (el) return el;
  }
  return null;
}

function getPdfSearchMatchRange(match: PdfSearchMatch): Range | null {
  const index = pdfSearchState.pageIndices.get(match.pageNumber);
  if (!index) return null;

  const { normChars } = index;
  if (match.normalizedStart >= normChars.length || match.normalizedEnd > normChars.length)
    return null;

  const startChar = normChars[match.normalizedStart];
  const endChar = normChars[match.normalizedEnd - 1];
  if (!startChar || !endChar) return null;

  const pageEl = findPageElement(match.pageNumber);
  if (!pageEl) return null;

  const textLayerEl = pageEl.querySelector(".textLayer");
  if (!textLayerEl) return null;

  // Text spans in DOM order. `span.markedContent` wrappers (emitted when
  // marked content is included) are containers, not text items.
  const spans = Array.from(textLayerEl.querySelectorAll<HTMLElement>("span:not(.markedContent)"));
  const startSpan = spans[startChar.itemIndex];
  const endSpan = spans[endChar.itemIndex];
  if (!startSpan?.firstChild || !endSpan?.firstChild) return null;

  try {
    const range = new Range();
    range.setStart(startSpan.firstChild, startChar.origOffset);
    range.setEnd(endSpan.firstChild, endChar.origOffsetEnd);
    return range;
  } catch {
    return null;
  }
}

function clearPdfSearchMarkEls() {
  for (const el of document.querySelectorAll(".pdf-search-mark")) {
    el.remove();
  }
}

export function applyPdfSearchHighlights() {
  clearPdfSearchMarkEls();

  if (!pdfSearchState.isOpen || !pdfSearchState.query || pdfSearchState.matches.length === 0) {
    return;
  }

  for (let i = 0; i < pdfSearchState.matches.length; i++) {
    const match = pdfSearchState.matches[i];
    if (!match) continue;
    const range = getPdfSearchMatchRange(match);
    if (!range) continue;

    const pageEl = findPageElement(match.pageNumber);
    if (!pageEl) continue;

    const pageRect = pageEl.getBoundingClientRect();
    const isCurrent = i === pdfSearchState.currentMatchIndex;

    for (const rect of range.getClientRects()) {
      const mark = document.createElement("div");
      mark.className = isCurrent ? "pdf-search-mark pdf-search-mark--current" : "pdf-search-mark";
      mark.style.left = `${rect.left - pageRect.left}px`;
      mark.style.top = `${rect.top - pageRect.top}px`;
      mark.style.width = `${rect.width}px`;
      mark.style.height = `${rect.height}px`;
      pageEl.appendChild(mark);
    }
  }
}

export function syncPdfSearchUi() {
  const countEl = document.querySelector<HTMLElement>("#pdf-search-count");
  if (!countEl) return;

  const { matches, currentMatchIndex } = pdfSearchState;
  if (matches.length === 0) {
    countEl.textContent = pdfSearchState.query ? "No matches" : "";
  } else {
    countEl.textContent = `${currentMatchIndex + 1} / ${matches.length}`;
  }
}

export function closePdfSearch() {
  const bar = document.querySelector<HTMLElement>("#pdf-search-bar");
  if (!bar) return;

  if (pdfSearchState.searchTimer !== null) {
    window.clearTimeout(pdfSearchState.searchTimer);
    pdfSearchState.searchTimer = null;
  }

  pdfSearchState.isOpen = false;
  pdfSearchState.query = "";
  pdfSearchState.matches = [];
  pdfSearchState.currentMatchIndex = -1;
  pdfSearchState.pageIndices.clear();
  bar.hidden = true;

  applyPdfSearchHighlights();
  syncPdfSearchUi();
}
