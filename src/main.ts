import "./vendor/fontawesome/css/fontawesome.min.css";
import "./vendor/fontawesome/css/brands.min.css";
import "./vendor/fontawesome/css/regular.min.css";
import "./vendor/fontawesome/css/solid.min.css";
import { applyAppTheme } from "./app-theme";
import { initAbout, loadAppMetadata } from "./app/about";
import { registerThumbnailEvents } from "./app/book-list";
import { initBulkSelection } from "./app/bulk-selection";
import { initCustomSourceEditor } from "./app/custom-sources";
import { finishStartupPhase } from "./app/dom";
import { initEpubFocusGuard } from "./app/epub-viewer";
import { initFulltextSettings, registerFulltextEvents } from "./app/fulltext";
import { primeHomeDirCache } from "./app/home-path";
import { initGlobalShortcuts } from "./app/keyboard";
import { refreshShelves } from "./app/library-data";
import { initLibrarySearch } from "./app/library-search";
import { initLibraryViewControls } from "./app/library-view";
import { registerLibraryEvents, renderApp } from "./app/library";
import { applyStaticTranslations } from "./app/locale";
import { initBookMetadataEditor, initLibraryAddButtons } from "./app/metadata-editor";
import {
  initHistoryPopstate,
  initNavigationControls,
  loadInitialLibraryState,
} from "./app/navigation";
import { initNotes } from "./app/notes";
import { initViewerPageJump } from "./app/page-jump";
import { initPdfSearch } from "./app/pdf-search";
import { initPdfStageScroll } from "./app/pdf-viewer";
import { initFlushOnUnload } from "./app/reading-position";
import { initAppSettings, loadAppConfig } from "./app/settings";
import { initShelfEditor } from "./app/shelf-editor";
import { installAppShell } from "./app/shell";
import { initShellControls, initSidebarControls } from "./app/sidebar";
import { initTagEditor } from "./app/tag-editor";
import { initTocToggle } from "./app/toc";
import { initViewerSettingsPanel } from "./app/viewer-settings-panel";
import {
  initViewerEditorButtons,
  initViewerResize,
  navigateViewerToPage,
  renderCurrentPage,
} from "./app/viewer";
import { initLibraryWelcome, registerLibraryDrops } from "./app/welcome";

installAppShell({ renderApp, renderCurrentPage, navigateViewerToPage });

window.addEventListener("DOMContentLoaded", async () => {
  applyStaticTranslations();
  await primeHomeDirCache();
  initBulkSelection();
  initLibrarySearch();
  initNavigationControls();
  initViewerPageJump();
  initShellControls();
  initPdfStageScroll();
  initLibraryViewControls();
  initLibraryAddButtons();
  initCustomSourceEditor();
  initSidebarControls();
  initAppSettings();
  initFulltextSettings();
  initLibraryWelcome();
  initAbout();
  initViewerEditorButtons();
  initShelfEditor();
  initTagEditor();
  initBookMetadataEditor();
  initViewerSettingsPanel();
  initTocToggle();
  initNotes();
  initPdfSearch();
  initGlobalShortcuts();
  initEpubFocusGuard();
  initViewerResize();
  initFlushOnUnload();
  await registerLibraryEvents();
  await registerLibraryDrops();
  await registerThumbnailEvents();
  await registerFulltextEvents();
  initHistoryPopstate();
  try {
    await loadAppConfig();
  } catch (error) {
    applyAppTheme("default");
    console.error("failed to load app config", error);
  } finally {
    finishStartupPhase();
  }

  await refreshShelves();
  loadInitialLibraryState();
  await loadAppMetadata();
});
