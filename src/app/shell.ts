// Requests that travel up the module layers. A feature module may import only
// the modules below it, yet an editor has to repaint the whole library, a
// renderer has to re-render the open book, and the TOC has to jump to a page.
// Those calls go through here: main.ts installs the real functions at startup,
// and modules below the owner import the forwarding functions from this file.
// Modules above the owner import the real function directly.

type AppShell = {
  /** Repaint the sidebar and main pane from the current snapshot (library.ts). */
  renderApp: () => void;
  /** Re-render the open book with the current preferences (viewer.ts). */
  renderCurrentPage: () => Promise<void>;
  /** Move the open book to a page, recording history by default (viewer.ts). */
  navigateViewerToPage: (pageNumber: number, options?: { pushHistory?: boolean }) => void;
};

let installed: AppShell | null = null;

export function installAppShell(shell: AppShell) {
  installed = shell;
}

function appShell(): AppShell {
  if (!installed) {
    throw new Error("The app shell is not installed; main.ts installs it at startup.");
  }
  return installed;
}

export function renderApp() {
  appShell().renderApp();
}

export function renderCurrentPage() {
  return appShell().renderCurrentPage();
}

export function navigateViewerToPage(pageNumber: number, options?: { pushHistory?: boolean }) {
  appShell().navigateViewerToPage(pageNumber, options);
}
