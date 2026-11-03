// Window-level keyboard shortcuts for navigation and the viewers.

import { isNavigationBackShortcut, isNavigationForwardShortcut } from "../navigation-shortcuts";
import {
  EPUB_FONT_SIZE_DEFAULT,
  isViewerEndShortcut,
  isViewerHomeShortcut,
  isViewerNextPageShortcut,
  isViewerPrevPageShortcut,
  isViewerZoomInShortcut,
  isViewerZoomOutShortcut,
  isViewerZoomResetShortcut,
  nextEpubFontSizeDown,
  nextEpubFontSizeUp,
  nextViewerZoomIn,
  nextViewerZoomOut,
} from "../viewer-shortcuts";
import { closeAbout } from "./about";
import { isEditableTarget } from "./dom";
import {
  activeEpubRendition,
  applyEpubFontSizeShortcut,
  currentEpubFontSize,
  isEpubNextPageKey,
  isEpubPrevPageKey,
} from "./epub-viewer";
import { activeImageEpub, goToImageSpread } from "./image-epub-viewer";
import { navigateBack, navigateForward } from "./navigation";
import { closePdfSearch, isPdfSearchShortcut, openPdfSearch, pdfSearchState } from "./pdf-search";
import {
  advancePdfPagedSpread,
  handlePdfPagedKey,
  pdfZoomScale,
  setPdfZoomScale,
} from "./pdf-viewer";
import { closeAppSettings } from "./settings";
import { appState, viewerState } from "./state";
import { currentViewerTotalPages, navigateViewerToPage } from "./viewer";
import { closeTagEditor, tagEditorState } from "../main";

export function initGlobalShortcuts() {
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && tagEditorState.isOpen) {
      closeTagEditor();
      return;
    }

    if (event.key === "Escape" && viewerState.isAboutOpen) {
      closeAbout();
      return;
    }

    if (event.key === "Escape" && viewerState.isAppSettingsOpen) {
      closeAppSettings();
      return;
    }

    if (event.key === "Escape" && pdfSearchState.isOpen) {
      closePdfSearch();
      return;
    }

    if (
      isPdfSearchShortcut(event) &&
      appState.lastSnapshot?.pdfRenderer === "pdfjs" &&
      viewerState.currentBook
    ) {
      event.preventDefault();
      openPdfSearch();
      return;
    }

    if (isEditableTarget(event.target)) {
      return;
    }

    const shortcutInput = {
      platform: navigator.platform,
      key: event.key,
      code: event.code,
      metaKey: event.metaKey,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
    };
    const wantsBack = isNavigationBackShortcut(shortcutInput);
    const wantsForward = isNavigationForwardShortcut(shortcutInput);

    if (wantsBack) {
      event.preventDefault();
      navigateBack();
      return;
    }

    if (wantsForward) {
      event.preventDefault();
      navigateForward();
      return;
    }

    if (viewerState.currentBook) {
      const isPdfBook = viewerState.currentBook.sourceType === "pdf";
      const isEpubBook = viewerState.currentBook.sourceType === "epub";
      const pdfActive = isPdfBook && appState.lastSnapshot?.pdfRenderer === "pdfjs";
      const epubActive = isEpubBook && Boolean(activeEpubRendition);
      const imgEpubActive = isEpubBook && activeImageEpub !== null;

      if (pdfActive || epubActive || imgEpubActive) {
        if (isViewerZoomResetShortcut(shortcutInput)) {
          event.preventDefault();
          if (pdfActive) {
            setPdfZoomScale(1);
          } else if (epubActive) {
            applyEpubFontSizeShortcut(EPUB_FONT_SIZE_DEFAULT);
          }
          return;
        }

        if (isViewerZoomInShortcut(shortcutInput)) {
          event.preventDefault();
          if (pdfActive) {
            setPdfZoomScale(nextViewerZoomIn(pdfZoomScale));
          } else if (epubActive) {
            applyEpubFontSizeShortcut(nextEpubFontSizeUp(currentEpubFontSize()));
          }
          return;
        }

        if (isViewerZoomOutShortcut(shortcutInput)) {
          event.preventDefault();
          if (pdfActive) {
            setPdfZoomScale(nextViewerZoomOut(pdfZoomScale));
          } else if (epubActive) {
            applyEpubFontSizeShortcut(nextEpubFontSizeDown(currentEpubFontSize()));
          }
          return;
        }

        if (isViewerHomeShortcut(shortcutInput)) {
          event.preventDefault();
          navigateViewerToPage(1);
          return;
        }

        if (isViewerEndShortcut(shortcutInput)) {
          event.preventDefault();
          const totalPages = currentViewerTotalPages();
          if (totalPages && totalPages >= 1) {
            navigateViewerToPage(totalPages);
          }
          return;
        }

        if (isViewerNextPageShortcut(shortcutInput)) {
          event.preventDefault();
          if (imgEpubActive) {
            goToImageSpread(1);
          } else if (epubActive && activeEpubRendition) {
            void activeEpubRendition.next();
          } else if (pdfActive) {
            advancePdfPagedSpread(1);
          }
          return;
        }

        if (isViewerPrevPageShortcut(shortcutInput)) {
          event.preventDefault();
          if (imgEpubActive) {
            goToImageSpread(-1);
          } else if (epubActive && activeEpubRendition) {
            void activeEpubRendition.prev();
          } else if (pdfActive) {
            advancePdfPagedSpread(-1);
          }
          return;
        }
      }
    }

    if (handlePdfPagedKey(event)) {
      return;
    }

    if (
      viewerState.currentBook?.sourceType === "epub" &&
      (activeEpubRendition || activeImageEpub)
    ) {
      // DPFJ guide §ページ進行方向の遵守: in rtl books ArrowLeft advances reading order.
      const wantsNext = appState.activeEpubIsRtl
        ? isEpubPrevPageKey(event)
        : isEpubNextPageKey(event);
      const wantsPrev = appState.activeEpubIsRtl
        ? isEpubNextPageKey(event)
        : isEpubPrevPageKey(event);
      if (wantsNext) {
        event.preventDefault();
        if (activeImageEpub) {
          goToImageSpread(1);
        } else {
          void activeEpubRendition?.next();
        }
      } else if (wantsPrev) {
        event.preventDefault();
        if (activeImageEpub) {
          goToImageSpread(-1);
        } else {
          void activeEpubRendition?.prev();
        }
      }
    }
  });
}
