// PDF.js renderer: document lifecycle, render window, links, zoom and paged
// navigation.

import { invoke } from "@tauri-apps/api/core";
import { loadPdfJsRuntime, TauriBinaryDataFactory } from "../pdf-runtime";
import { convertPdfRectToViewport } from "../pdf-rect-utils";
import { type PdfAnnotationRecord, resolvePdfLinkTarget } from "../pdf-link-utils";
import { detectPdfBindingDirection } from "../pdf-binding-detect";
import { type PageSampleSurface, PdfPageAnalyzer, resolvePdfTrimBoxes } from "../pdf-page-sample";
import { applyPdfPageOverlayTransform, pageContentTransform } from "../pdf-page-transform";
import { createPdfRangeTransport, probePdfRangeSource } from "../pdf-range-source";
import { cropRectForPage, type TrimBoxes, trimmedPageSize } from "../pdf-trim";
import { buildPageGroups, getVisualPageOrder } from "../viewer-layout-utils";
import { buildPdfRenderWindowPlan } from "../pdf-render-window-utils";
import { planPagedKeyAction } from "../pdf-paged-nav-utils";
import { applyEpubViewerColors } from "./epub-viewer";
import { navigateBack } from "./navigation";
import { applyPdfSearchHighlights, closePdfSearch, pdfSearchState } from "./pdf-search-highlights";
import {
  restoreReadingPositionAttempt,
  scheduleReadingPositionRestore,
  scheduleReadingPositionSave,
} from "./reading-position";
import { appState, viewerSettings, viewerState } from "./state";
import { buildPdfToc, syncTocUi } from "./toc";
import type { PdfRenderPlan, PdfRenderSession } from "./types";
import { applyPdfViewerBackground, applyViewerVerticalGapMode } from "./viewer-settings";
import { navigateViewerToPage, renderCurrentPage } from "./viewer";
import { currentViewerStage } from "./dom";

// Scan analysis for deskew and margin trimming (viewer settings "deskewMode"
// and "trimMode"). One scratch canvas serves every page; `willReadFrequently`
// keeps the pixel read-back on the CPU path, and the analyzer memoises each
// page's measurements per document.
const pdfPageAnalyzer = new PdfPageAnalyzer((): PageSampleSurface | null => {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  return context ? { canvas, context } : null;
});

let pdfRenderToken = 0;

// The open document's PDF.js loading task. Destroying it is the only way to
// give back the worker, the file bytes it holds and every decoded page image;
// without it each book opened in a session stays resident for the session's
// lifetime, which on scanned books is hundreds of megabytes apiece.
let activePdfLoadingTask: { destroy: () => Promise<void> } | null = null;

export let pdfZoomScale = 1;

// How far around the reading position spreads are painted, and how far a
// painted one stays. Both cost memory — a spread of a 300dpi book scan is
// about 17MB of canvas plus 32MB of decoded image — so the window is kept
// narrow. The render radius is one spread of prefetch, which is what paged
// reading consumes. The keep radius is deliberately the larger of the two:
// spreads between the two radii stay painted without being maintained, so
// stepping back through the book is instant rather than a repaint.
const PDF_RENDER_RADIUS = 1;
const PDF_KEEP_RADIUS = 2;

function promptPdfPassword(isRetry: boolean): Promise<string | null> {
  return new Promise((resolve) => {
    const modalEl = document.querySelector<HTMLElement>("#pdf-password-modal");
    const inputEl = document.querySelector<HTMLInputElement>("#pdf-password-input");
    const submitEl = document.querySelector<HTMLButtonElement>("#pdf-password-submit");
    const cancelEl = document.querySelector<HTMLButtonElement>("#pdf-password-cancel");
    const statusEl = document.querySelector<HTMLElement>("#pdf-password-status");
    if (!modalEl || !inputEl || !submitEl || !cancelEl || !statusEl) {
      resolve(null);
      return;
    }

    inputEl.value = "";
    modalEl.hidden = false;
    if (isRetry) {
      statusEl.textContent = "Incorrect password. Try again.";
      statusEl.dataset.tone = "error";
      statusEl.hidden = false;
    } else {
      statusEl.hidden = true;
      delete statusEl.dataset.tone;
    }
    inputEl.focus();

    function cleanup() {
      modalEl!.hidden = true;
      submitEl!.removeEventListener("click", onSubmit);
      cancelEl!.removeEventListener("click", onCancel);
      inputEl!.removeEventListener("keydown", onKeydown);
    }

    function onSubmit() {
      const pw = inputEl!.value;
      cleanup();
      resolve(pw.length > 0 ? pw : null);
    }

    function onCancel() {
      cleanup();
      resolve(null);
    }

    function onKeydown(event: KeyboardEvent) {
      if (event.key === "Enter" && !event.isComposing && event.keyCode !== 229) {
        onSubmit();
      } else if (event.key === "Escape") {
        onCancel();
      }
    }

    submitEl.addEventListener("click", onSubmit);
    cancelEl.addEventListener("click", onCancel);
    inputEl.addEventListener("keydown", onKeydown);
  });
}

export function findPdfRenderGroupIndexForPage(session: PdfRenderSession, pageNumber: number) {
  return session.plans.findIndex((plan) => plan.pageSlots.has(pageNumber));
}

export function resetPdfZoomScaleForBook() {
  pdfZoomScale = 1;
}

export function setPdfZoomScale(nextScale: number) {
  if (nextScale === pdfZoomScale) {
    return;
  }
  pdfZoomScale = nextScale;
  if (
    appState.lastSnapshot?.pdfRenderer === "pdfjs" &&
    viewerState.currentBook?.sourceType === "pdf"
  ) {
    void renderCurrentPage();
  }
}

async function renderPdfJsLinks(
  container: HTMLElement,
  viewport: { transform: number[] },
  annotations: PdfAnnotationRecord[],
  session: PdfRenderSession,
  currentPageNumber: number,
) {
  for (const annotation of annotations) {
    if (annotation.subtype !== "Link" || !Array.isArray(annotation.rect)) {
      continue;
    }

    const rect = convertPdfRectToViewport(annotation.rect, viewport.transform);
    const x1 = rect[0] ?? 0;
    const y1 = rect[1] ?? 0;
    const x2 = rect[2] ?? 0;
    const y2 = rect[3] ?? 0;
    const left = Math.min(x1, x2);
    const top = Math.min(y1, y2);
    const width = Math.abs(x2 - x1);
    const height = Math.abs(y2 - y1);

    if (width < 2 || height < 2) {
      continue;
    }

    const sectionEl = document.createElement("section");
    sectionEl.className = "linkAnnotation";
    sectionEl.style.left = `${left}px`;
    sectionEl.style.top = `${top}px`;
    sectionEl.style.width = `${width}px`;
    sectionEl.style.height = `${height}px`;

    const linkEl = document.createElement("a");
    const target = await resolvePdfLinkTarget(annotation, currentPageNumber, session.pdfDocument);

    if (target?.type === "external") {
      linkEl.href = target.url;
      linkEl.target = "_blank";
      linkEl.rel = "noreferrer noopener";
      linkEl.title = target.url;
    } else if (target?.type === "internal") {
      linkEl.href = `#page=${target.pageNumber}`;
      linkEl.title = `Go to page ${target.pageNumber}`;
      linkEl.addEventListener("click", (event) => {
        event.preventDefault();
        navigateViewerToPage(target.pageNumber);
      });
    } else {
      linkEl.href = "#";
      linkEl.addEventListener("click", (event) => {
        event.preventDefault();
      });
    }

    sectionEl.appendChild(linkEl);
    container.appendChild(sectionEl);
  }
}

/**
 * Close whatever PDF is open and hand its memory back.
 *
 * PDF.js keeps everything a document needs alive until its loading task is
 * destroyed: the dedicated worker, the document's bytes, the fonts and every
 * page's decoded images. Leaving that to the garbage collector means a session
 * that opens several scanned books never gives any of them back.
 *
 * Bumping the render token first stops any in-flight render from touching the
 * document while it is being torn down.
 */
export function releaseActivePdfDocument() {
  pdfRenderToken += 1;
  appState.activePdfRenderSession = null;
  const task = activePdfLoadingTask;
  activePdfLoadingTask = null;
  // destroy() rejects pending page requests; those rejections belong to work
  // the bumped token has already abandoned.
  void task?.destroy().catch(() => {});
}

/**
 * Drop a spread out of the render window, giving back both halves of its
 * memory: the canvas backing stores and PDF.js's decoded page images.
 *
 * Detaching a canvas from the DOM is not enough — WebKit keeps its ImageBuffer
 * until the element is collected, which on a scanned book means hundreds of
 * megabytes waiting on the GC. Resizing to 0x0 frees it at once.
 */
function releasePdfRenderPlan(plan: PdfRenderPlan) {
  // Not gated on `dataset.rendered`: a page whose render threw part-way has a
  // canvas in the DOM without ever having been marked rendered, and clearing a
  // slot that holds nothing costs nothing.
  for (const pageEl of plan.pageSlots.values()) {
    for (const canvas of pageEl.querySelectorAll("canvas")) {
      canvas.width = 0;
      canvas.height = 0;
    }
    pageEl.innerHTML = "";
    pageEl.dataset.rendered = "false";
  }

  for (const page of plan.renderedPages.values()) {
    // Returns false while a render task is still running on the page; the
    // window update never releases a group it is painting, so that only
    // happens if a render was left in flight, and the page then keeps its
    // images until the document is closed.
    page.cleanup();
  }
  plan.renderedPages.clear();
}

function currentVisiblePdfGroupIndex(session: PdfRenderSession) {
  const anchor = session.stageEl.scrollTop + session.stageEl.clientHeight * 0.35;
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const plan of session.plans) {
    const distance = Math.abs(plan.spreadEl.offsetTop - anchor);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = plan.groupIndex;
    }
  }

  return bestIndex;
}

async function renderPdfRenderPlan(session: PdfRenderSession, plan: PdfRenderPlan) {
  const { TextLayer } = await loadPdfJsRuntime();

  for (const pageNumber of plan.visualOrder) {
    if (session.token !== pdfRenderToken) {
      return;
    }

    const pageEl = plan.pageSlots.get(pageNumber);
    if (!pageEl || pageEl.dataset.rendered === "true") {
      continue;
    }

    const page = await session.pdfDocument.getPage(pageNumber);
    // Recorded before rendering so a page abandoned part-way through — a
    // missing 2d context, a render that threw — is still released with the
    // group rather than keeping its decoded images for the whole session.
    plan.renderedPages.set(pageNumber, page);
    const viewport = page.getViewport({ scale: plan.baseScale });
    // Measure the scan's tilt before the real render so the canvas is level
    // from its first paint; the analyzer caches per page, so re-renders after
    // a zoom or resize skip the sampling pass.
    const deskewAngle =
      viewerSettings.deskewMode === "auto" && session.filePath
        ? (await pdfPageAnalyzer.analyze(page, session.filePath, pageNumber)).angleDeg
        : null;
    if (session.token !== pdfRenderToken) {
      return;
    }
    const outputScale = Math.max(window.devicePixelRatio || 1, 1);
    const content = pageContentTransform({
      width: viewport.width,
      height: viewport.height,
      outputScale,
      angleDeg: deskewAngle,
      crop: cropRectForPage(session.trimBoxes, pageNumber, viewport),
    });
    pageEl.style.width = `${content.contentWidth}px`;
    pageEl.style.height = `${content.contentHeight}px`;
    pageEl.innerHTML = "";
    applyPdfPageOverlayTransform(pageEl, content.overlay);

    const canvasWrapperEl = document.createElement("div");
    canvasWrapperEl.className = "canvasWrapper";
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(content.contentWidth * outputScale);
    canvas.height = Math.ceil(content.contentHeight * outputScale);
    canvas.style.width = `${content.contentWidth}px`;
    canvas.style.height = `${content.contentHeight}px`;
    canvasWrapperEl.appendChild(canvas);
    pageEl.appendChild(canvasWrapperEl);

    const textLayerEl = document.createElement("div");
    textLayerEl.className = "textLayer";
    pageEl.appendChild(textLayerEl);

    const linkLayerEl = document.createElement("div");
    linkLayerEl.className = "annotationLayer";
    pageEl.appendChild(linkLayerEl);

    const context = canvas.getContext("2d");
    if (!context) {
      continue;
    }

    await page.render({
      canvas,
      canvasContext: context,
      transform: content.canvas,
      viewport,
    }).promise;

    const textLayer = new TextLayer({
      textContentSource: page.streamTextContent(),
      container: textLayerEl,
      viewport,
    });
    await textLayer.render();

    if (pdfSearchState.isOpen && pdfSearchState.matches.length > 0) {
      applyPdfSearchHighlights();
    }

    const annotations = await page.getAnnotations();
    await renderPdfJsLinks(
      linkLayerEl,
      viewport,
      annotations as PdfAnnotationRecord[],
      session,
      pageNumber,
    );
    pageEl.dataset.rendered = "true";

    if (session.restoreTargetPage === pageNumber) {
      scheduleReadingPositionRestore();
    }
  }
}

async function updatePdfRenderWindow(session: PdfRenderSession, focusGroupIndex?: number) {
  if (session.token !== pdfRenderToken) {
    return;
  }

  if (session.isUpdating) {
    session.pendingFocusGroupIndex = focusGroupIndex ?? currentVisiblePdfGroupIndex(session);
    return;
  }

  session.isUpdating = true;

  try {
    const activeGroupIndex = focusGroupIndex ?? currentVisiblePdfGroupIndex(session);
    const planWindow = buildPdfRenderWindowPlan(
      session.plans.length,
      activeGroupIndex,
      PDF_RENDER_RADIUS,
      PDF_KEEP_RADIUS,
    );

    for (const plan of session.plans) {
      if (plan.groupIndex < planWindow.keepMin || plan.groupIndex > planWindow.keepMax) {
        releasePdfRenderPlan(plan);
      }
    }

    for (const index of planWindow.renderOrder) {
      const plan = session.plans[index];
      if (!plan) {
        continue;
      }

      await renderPdfRenderPlan(session, plan);

      if (session.token !== pdfRenderToken) {
        return;
      }
    }
  } catch (error) {
    // Closing a document destroys its PDF.js loading task, which rejects the
    // page and render promises this loop is waiting on. For a session the
    // token has already moved past, that rejection is the teardown working.
    if (session.token === pdfRenderToken) {
      console.warn("[riida] PDF render window update failed:", error);
    }
  } finally {
    session.isUpdating = false;
  }

  if (session.pendingFocusGroupIndex !== null) {
    const nextFocusGroupIndex = session.pendingFocusGroupIndex;
    session.pendingFocusGroupIndex = null;
    void updatePdfRenderWindow(session, nextFocusGroupIndex);
  }
}

export function schedulePdfRenderWindowUpdate(session: PdfRenderSession, focusGroupIndex?: number) {
  if (session.token !== pdfRenderToken) {
    return;
  }

  if (session.updateScheduled) {
    if (typeof focusGroupIndex === "number") {
      session.pendingFocusGroupIndex = focusGroupIndex;
    }
    return;
  }

  session.updateScheduled = true;
  window.requestAnimationFrame(() => {
    session.updateScheduled = false;
    void updatePdfRenderWindow(session, focusGroupIndex);
  });
}

export function syncImmediatePdfScrollMode() {
  const stageEl = currentViewerStage();
  if (!stageEl) {
    return;
  }
  stageEl.dataset.scrollMode = viewerSettings.scrollMode;
}

function getPdfPageEls(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".pdfjs-spread"));
}

function findActivePdfPageEl(stageEl: HTMLElement, pageEls: HTMLElement[]): HTMLElement | null {
  if (pageEls.length === 0) {
    return null;
  }
  const anchor = stageEl.scrollTop + stageEl.clientHeight * 0.3;
  let active: HTMLElement | null = pageEls[0] ?? null;
  for (const pageEl of pageEls) {
    if (pageEl.offsetTop <= anchor) {
      active = pageEl;
    } else {
      break;
    }
  }
  return active;
}

export function advancePdfPagedSpread(direction: 1 | -1) {
  if (viewerState.currentBook?.sourceType !== "pdf") {
    return;
  }
  if (appState.lastSnapshot?.pdfRenderer !== "pdfjs") {
    return;
  }
  const stageEl = currentViewerStage();
  if (!stageEl) {
    return;
  }

  if (viewerSettings.scrollMode !== "paged") {
    const step = Math.max(stageEl.clientHeight * 0.95, 40) * direction;
    stageEl.scrollBy({ top: step, left: 0, behavior: "auto" });
    return;
  }

  const pageEls = getPdfPageEls();
  const activeEl = findActivePdfPageEl(stageEl, pageEls);
  if (!activeEl) {
    return;
  }
  const index = pageEls.indexOf(activeEl);
  const target = pageEls[index + direction];
  if (target) {
    stageEl.scrollTo({ top: target.offsetTop, left: stageEl.scrollLeft, behavior: "auto" });
  }
}

export function handlePdfPagedKey(event: KeyboardEvent): boolean {
  if (viewerSettings.scrollMode !== "paged") {
    return false;
  }
  if (viewerState.currentBook?.sourceType !== "pdf") {
    return false;
  }
  if (appState.lastSnapshot?.pdfRenderer !== "pdfjs") {
    return false;
  }
  const stageEl = currentViewerStage();
  if (!stageEl) {
    return false;
  }
  const pageEls = getPdfPageEls();
  const activeEl = findActivePdfPageEl(stageEl, pageEls);
  if (!activeEl) {
    return false;
  }

  const key = event.key;
  if (
    key !== "ArrowLeft" &&
    key !== "ArrowRight" &&
    key !== "ArrowUp" &&
    key !== "ArrowDown" &&
    key !== "PageUp" &&
    key !== "PageDown"
  ) {
    return false;
  }

  const action = planPagedKeyAction(
    key,
    {
      scrollTop: stageEl.scrollTop,
      scrollLeft: stageEl.scrollLeft,
      clientHeight: stageEl.clientHeight,
      clientWidth: stageEl.clientWidth,
      pageOffsetTop: activeEl.offsetTop,
      pageOffsetLeft: activeEl.offsetLeft,
      pageHeight: activeEl.offsetHeight,
      pageWidth: activeEl.offsetWidth,
    },
    appState.activePdfRenderSession?.resolvedBindingDirection ?? "left",
  );

  event.preventDefault();

  if (action.kind === "jump-adjacent") {
    const index = pageEls.indexOf(activeEl);
    const target = pageEls[index + action.direction];
    if (target) {
      stageEl.scrollTo({ top: target.offsetTop, left: stageEl.scrollLeft, behavior: "auto" });
    }
    return true;
  }

  stageEl.scrollTo({ top: action.top, left: action.left, behavior: "auto" });
  return true;
}

export async function renderPdfJsBook(
  frame: HTMLIFrameElement,
  viewerStageEl: HTMLElement,
  pdfjsViewerEl: HTMLElement,
  sourceUrl: string,
) {
  if (!viewerState.currentBook) {
    return;
  }

  applyEpubViewerColors("inherit-theme");
  applyPdfViewerBackground(viewerSettings.backgroundMode);
  syncImmediatePdfScrollMode();
  releaseActivePdfDocument();
  appState.activePdfOutline = null;
  frame.hidden = true;
  frame.src = "about:blank";
  frame.dataset.filePath = "";
  pdfjsViewerEl.hidden = false;
  pdfjsViewerEl.innerHTML = "";
  pdfjsViewerEl.dataset.filePath = viewerState.currentBook.filePath;
  pdfjsViewerEl.dataset.position = viewerSettings.alignMode;
  applyViewerVerticalGapMode(viewerSettings.verticalGapMode);

  closePdfSearch();
  appState.pdfRenderInProgress = true;
  const currentToken = pdfRenderToken;
  const loadingEl = document.createElement("div");
  loadingEl.className = "pdfjs-loading";
  loadingEl.textContent = "Rendering PDF...";
  pdfjsViewerEl.appendChild(loadingEl);

  let passwordCancelled = false;
  try {
    const { getDocument, PDFDataRangeTransport } = await loadPdfJsRuntime();
    const filePath = viewerState.currentBook.filePath;
    const savedPassword = await invoke<string | null>("get_pdf_password", { filePath });
    let usedPassword: string | null = savedPassword;
    // Read the document in byte ranges when the source serves them, so the
    // worker holds the pages actually read instead of the whole file (see
    // src/pdf-range-source.ts). Falls back to the plain URL when it cannot.
    const rangeSource = await probePdfRangeSource(sourceUrl, fetch);
    if (!rangeSource) {
      console.info("[riida] PDF source does not serve byte ranges; reading the whole file");
    }
    const documentTask = getDocument({
      ...(rangeSource
        ? { range: createPdfRangeTransport(PDFDataRangeTransport, sourceUrl, rangeSource, fetch) }
        : { url: sourceUrl }),
      disableAutoFetch: true,
      cMapUrl: "/pdfjs/cmaps/node_modules/pdfjs-dist/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/pdfjs/standard_fonts/node_modules/pdfjs-dist/standard_fonts/",
      useSystemFonts: true,
      disableFontFace: false,
      // PDF.js's built-in DOMBinaryDataFactory routes through `fetchData()`,
      // which gates on `isValidFetchUrl()` — a hard-coded `http(s):` allow-
      // list. In Tauri 2 macOS production builds the document loads from
      // `tauri://localhost`, so cMap URLs resolve to `tauri:` and PDF.js
      // falls through to an XHR path that silently completes with an empty
      // body (`status === 0`). Without the Adobe-Japan1 reverse-CMap loaded,
      // PDF.js cannot map CID → Unicode for non-embedded standard CJK fonts
      // like Ryumin-Light-Identity-H, and ends up emitting raw CIDs to the
      // canvas. Provide a `BinaryDataFactory` class that uses plain
      // `fetch()` — which actually works on `tauri:` URLs in WKWebView.
      // PDF.js instantiates this class itself with `cMapUrl`,
      // `standardFontDataUrl`, and `wasmUrl`.
      BinaryDataFactory: TauriBinaryDataFactory,
      useWorkerFetch: false,
      password: savedPassword ?? undefined,
    });

    // Owned from here on, so switching books or leaving the viewer gives the
    // document's worker, bytes and decoded pages back. `releaseActivePdfDocument`
    // may already have run during the awaits above, in which case this task
    // is stale and goes straight back.
    if (currentToken !== pdfRenderToken) {
      void documentTask.destroy().catch(() => {});
      return;
    }
    activePdfLoadingTask = documentTask;

    documentTask.onPassword = async (updatePassword: (pw: string) => void, reason: number) => {
      // reason 1 = needs password, reason 2 = wrong password
      const isRetry = reason === 2;
      if (isRetry) {
        usedPassword = null;
      }
      const entered = await promptPdfPassword(isRetry);
      if (entered !== null) {
        usedPassword = entered;
        updatePassword(entered);
      } else {
        // User cancelled — destroy the task so documentTask.promise rejects
        passwordCancelled = true;
        void documentTask.destroy();
      }
    };
    const pdfDocument = await documentTask.promise;
    if (usedPassword !== null && usedPassword !== savedPassword) {
      await invoke("save_pdf_password", { filePath, password: usedPassword });
    }

    if (currentToken !== pdfRenderToken) {
      return;
    }

    // Resolve `bindingDirection: "auto"` to a concrete left/right by
    // probing the document. Explicit "left" / "right" prefs short-circuit
    // detection. When detection is inconclusive (e.g. pure-image PDFs)
    // we fall back to "left".
    let resolvedBinding: "left" | "right";
    if (viewerSettings.bindingDirection === "auto") {
      const detected = await detectPdfBindingDirection(
        pdfDocument,
        () => currentToken !== pdfRenderToken,
      );
      if (currentToken !== pdfRenderToken) return;
      resolvedBinding = detected ?? "left";
    } else {
      resolvedBinding = viewerSettings.bindingDirection;
    }

    // Margin trimming needs the document's crop boxes before any page size
    // is known; the pre-pass samples a spread of pages (cached per file).
    let trimBoxes: TrimBoxes | null = null;
    if (viewerSettings.trimMode === "auto") {
      trimBoxes = await resolvePdfTrimBoxes({
        document: pdfDocument,
        filePath,
        deskew: viewerSettings.deskewMode === "auto",
        analyzer: pdfPageAnalyzer,
        isCancelled: () => currentToken !== pdfRenderToken,
        onProgress: (measured, total) => {
          loadingEl.textContent = `Measuring margins (${measured}/${total})...`;
        },
      });
      if (currentToken !== pdfRenderToken) return;
    }
    // Page sizes at scale 1 as laid out: the trimmed extent when trimming.
    const basePageSize = async (pageNumber: number) => {
      const viewport = (await pdfDocument.getPage(pageNumber)).getViewport({ scale: 1 });
      return trimmedPageSize(trimBoxes, pageNumber, viewport);
    };

    pdfjsViewerEl.innerHTML = "";
    const layoutSettings = {
      pageMode: viewerSettings.pageMode,
      bindingDirection: resolvedBinding,
      treatFirstPageAsCover: viewerSettings.treatFirstPageAsCover,
    };
    const pageGroups = buildPageGroups(pdfDocument.numPages, layoutSettings);
    const restoreTargetPage = appState.activeReadingPosition?.pageNumber ?? null;
    const pageGap = viewerSettings.pageMode === "spread" ? 6 : 0;
    const viewerWidth = Math.max(pdfjsViewerEl.clientWidth, 720);
    const viewerHeight = Math.max(pdfjsViewerEl.clientHeight, 600);
    const maxColumns = viewerSettings.pageMode === "spread" ? 2 : 1;
    const availableWidth = viewerWidth - pageGap * (maxColumns - 1) - 32;
    const targetHeight = Math.max(260, viewerHeight - 56);

    // Strategy A: in fit-height + spread mode, split any 2-page group whose
    // combined rendered width would exceed the available viewer width.
    let layoutGroups = pageGroups;
    if (viewerSettings.pageMode === "spread" && viewerSettings.zoomMode === "fit-height") {
      layoutGroups = [];
      for (const group of pageGroups) {
        if (group.length === 2 && group[0] !== undefined && group[1] !== undefined) {
          const g0 = group[0];
          const g1 = group[1];
          const vp0 = await basePageSize(g0);
          if (currentToken !== pdfRenderToken) return;
          const vp1 = await basePageSize(g1);
          if (currentToken !== pdfRenderToken) return;
          const fitScale = targetHeight / Math.max(vp0.height, 1);
          const combinedWidth = (vp0.width + vp1.width) * fitScale + pageGap;
          if (combinedWidth > availableWidth) {
            layoutGroups.push([g0]);
            layoutGroups.push([g1]);
            continue;
          }
        }
        layoutGroups.push(group);
      }
    }

    const renderPlans: PdfRenderPlan[] = [];

    for (const [groupIndex, group] of layoutGroups.entries()) {
      if (currentToken !== pdfRenderToken) return;
      const visualOrder = getVisualPageOrder(group, layoutSettings);
      const spreadEl = document.createElement("section");
      spreadEl.className = "pdfjs-spread";
      spreadEl.dataset.pageCount = String(visualOrder.length);
      spreadEl.dataset.binding = resolvedBinding;
      spreadEl.dataset.cover = String(group.length === 1);

      const sampleViewport = await basePageSize(group[0]!);
      if (currentToken !== pdfRenderToken) return;
      const targetWidth =
        viewerSettings.pageMode === "spread"
          ? Math.max(220, Math.floor(availableWidth / Math.max(visualOrder.length, 1)))
          : Math.max(320, availableWidth);

      let baseScale = 1;
      if (viewerSettings.zoomMode === "fit-width") {
        baseScale = targetWidth / Math.max(sampleViewport.width, 1);
      } else if (viewerSettings.zoomMode === "fit-height") {
        baseScale = targetHeight / Math.max(sampleViewport.height, 1);
      }
      baseScale *= pdfZoomScale;

      pdfjsViewerEl.style.setProperty("--scale-factor", String(baseScale));

      const pageSlots = new Map<number, HTMLElement>();
      for (const pageNumber of visualOrder) {
        const estimatedSize = await basePageSize(pageNumber);
        if (currentToken !== pdfRenderToken) return;
        const pageEl = document.createElement("section");
        pageEl.className = "pdfjs-page page";
        pageEl.dataset.pageNumber = String(pageNumber);
        pageEl.style.width = `${estimatedSize.width * baseScale}px`;
        pageEl.style.height = `${estimatedSize.height * baseScale}px`;
        spreadEl.appendChild(pageEl);
        pageSlots.set(pageNumber, pageEl);
      }

      if (currentToken !== pdfRenderToken) return;
      pdfjsViewerEl.appendChild(spreadEl);
      renderPlans.push({
        groupIndex,
        visualOrder,
        spreadEl,
        pageSlots,
        baseScale,
        renderedPages: new Map(),
      });
    }

    const targetGroupIndex =
      restoreTargetPage === null
        ? 0
        : Math.max(
            0,
            layoutGroups.findIndex((group) => group.includes(restoreTargetPage)),
          );
    const session: PdfRenderSession = {
      token: currentToken,
      pdfDocument,
      viewerEl: pdfjsViewerEl,
      stageEl: viewerStageEl,
      plans: renderPlans,
      restoreTargetPage,
      updateScheduled: false,
      isUpdating: false,
      pendingFocusGroupIndex: null,
      resolvedBindingDirection: resolvedBinding,
      filePath: viewerState.currentBook?.filePath ?? "",
      trimBoxes,
    };
    appState.activePdfRenderSession = session;
    // Restore scroll position immediately using placeholder dimensions so
    // the user's view is preserved before async page rendering begins.
    // Without this, scroll-snap or stray scroll events during rebuild can
    // re-anchor the render window to group 0 and lose the target group.
    if (restoreTargetPage !== null) {
      restoreReadingPositionAttempt();
    }
    schedulePdfRenderWindowUpdate(session, targetGroupIndex);

    // Load PDF outline (TOC) asynchronously so it does not block rendering.
    appState.tocPanelOpen = false;
    appState.activePdfOutline = null;
    syncTocUi();
    if (pdfDocument.getOutline) {
      void pdfDocument.getOutline().then((outline) => {
        if (appState.activePdfRenderSession?.token !== currentToken) return;
        appState.activePdfOutline = outline ?? null;
        buildPdfToc();
        syncTocUi();
      });
    }
  } catch (error) {
    if (passwordCancelled) {
      pdfjsViewerEl.innerHTML = "";
      navigateBack();
      return;
    }
    // A render the token has moved past fails by design: closing its
    // document destroys the loading task and rejects whatever it awaited.
    // The viewer now belongs to a newer render, so leave its DOM alone.
    if (currentToken !== pdfRenderToken) {
      return;
    }
    pdfjsViewerEl.innerHTML = "";

    const errorEl = document.createElement("div");
    errorEl.className = "pdfjs-loading";
    const msg = String(error);
    errorEl.textContent =
      msg.includes("PasswordException") || msg.includes("No password given")
        ? "This PDF requires a password."
        : `Failed to render with PDF.js: ${msg}`;
    pdfjsViewerEl.appendChild(errorEl);
  } finally {
    if (currentToken === pdfRenderToken) {
      appState.pdfRenderInProgress = false;
    }
  }
}

export function initPdfStageScroll() {
  const viewerStageEl = currentViewerStage();

  viewerStageEl?.addEventListener(
    "scroll",
    () => {
      if (appState.lastSnapshot?.pdfRenderer !== "pdfjs" || !viewerState.currentBook) {
        return;
      }
      if (appState.pdfRenderInProgress) {
        return;
      }

      scheduleReadingPositionSave();
      if (appState.activePdfRenderSession) {
        schedulePdfRenderWindowUpdate(appState.activePdfRenderSession);
      }
    },
    { passive: true },
  );
}
