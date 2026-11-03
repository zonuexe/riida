// First-run welcome screen and folder drops onto the window.

import { invoke } from "@tauri-apps/api/core";
import { type DragDropEvent, getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { describeAddLibraryRootError } from "../i18n";
import { type StatusTone, statusToneAttribute } from "../dom-form-utils";
import { folderDisplayName } from "../library-utils";
import { applyStatusMessage } from "./dom";
import { hasActiveLibraryFilter } from "./library-data";
import { renderApp } from "./library";
import { t, uiLocale } from "./locale";
import { navigateToState } from "./navigation";
import { closeAppSettings } from "./settings";
import { appState, viewerState } from "./state";
import type { AppConfigPayload } from "./types";

let libraryRootAddInFlight = false;
let libraryDropStatusTimer: ReturnType<typeof setTimeout> | null = null;

function isLibraryWelcomeVisible() {
  const welcomeEl = document.querySelector<HTMLElement>("#library-welcome");
  return Boolean(welcomeEl && !welcomeEl.hidden && !viewerState.currentBook);
}

function setLibraryDropOverlay(
  state: { phase: "drag" | "status"; message: string; tone?: StatusTone } | null,
) {
  const overlayEl = document.querySelector<HTMLElement>("#library-drop-overlay");
  const messageEl = document.querySelector<HTMLElement>("#library-drop-overlay-message");
  if (libraryDropStatusTimer !== null) {
    clearTimeout(libraryDropStatusTimer);
    libraryDropStatusTimer = null;
  }
  if (state?.phase === "drag") {
    document.body.dataset.libraryDrag = "active";
  } else {
    delete document.body.dataset.libraryDrag;
  }
  if (!overlayEl || !messageEl) {
    return;
  }
  if (!state) {
    overlayEl.hidden = true;
    return;
  }
  overlayEl.hidden = false;
  overlayEl.dataset.phase = state.phase;
  const toneAttr = statusToneAttribute(state.tone ?? "neutral");
  if (toneAttr === null) {
    delete overlayEl.dataset.tone;
  } else {
    overlayEl.dataset.tone = toneAttr;
  }
  messageEl.textContent = state.message;
}

// The welcome screen carries its own status line; elsewhere the overlay
// shrinks to a status pill that fades out once the outcome is known.
function reportLibraryAddStatus(message: string, tone: StatusTone) {
  const welcomeStatusEl = document.querySelector<HTMLElement>("#library-welcome-status");
  if (isLibraryWelcomeVisible() && welcomeStatusEl) {
    setLibraryDropOverlay(null);
    applyStatusMessage(welcomeStatusEl, message, tone);
    return;
  }
  setLibraryDropOverlay({ phase: "status", message, tone });
  if (tone !== "neutral") {
    libraryDropStatusTimer = setTimeout(
      () => {
        libraryDropStatusTimer = null;
        setLibraryDropOverlay(null);
      },
      tone === "error" ? 6000 : 3000,
    );
  }
}

function syncLibraryWelcomeControls() {
  const chooseEl = document.querySelector<HTMLButtonElement>("#library-welcome-choose");
  if (chooseEl) {
    chooseEl.disabled = libraryRootAddInFlight;
  }
}

/** Adds dropped or chosen folders as library roots, scanning each one. */
async function addLibraryRoots(paths: string[]) {
  if (libraryRootAddInFlight || paths.length === 0) {
    return;
  }
  libraryRootAddInFlight = true;
  syncLibraryWelcomeControls();
  const errors: string[] = [];
  const added: string[] = [];
  try {
    for (const path of paths) {
      const name = folderDisplayName(path);
      reportLibraryAddStatus(t("status.scanning", { name }), "neutral");
      try {
        appState.lastAppConfig = await invoke<AppConfigPayload>("add_library_root", { path });
        added.push(path);
      } catch (error) {
        errors.push(describeAddLibraryRootError(uiLocale, error, name));
      }
    }
  } finally {
    libraryRootAddInFlight = false;
    syncLibraryWelcomeControls();
  }

  if (added.length > 0 && viewerState.isLibraryWelcomeRequested) {
    viewerState.isLibraryWelcomeRequested = false;
    renderApp();
  }

  // The scan's `library-updated` event has already re-rendered the library.
  const [onlyAdded] = added;
  if (errors.length > 0) {
    reportLibraryAddStatus(errors.join(" "), "error");
  } else if (added.length === 1 && onlyAdded) {
    reportLibraryAddStatus(t("status.addedOne", { name: folderDisplayName(onlyAdded) }), "success");
  } else {
    reportLibraryAddStatus(t("status.addedMany", { count: added.length }), "success");
  }
}

function handleLibraryDragDrop(event: DragDropEvent) {
  // The Settings form edits its own draft of the root list; a drop would
  // silently replace it, so drops are ignored while it is open.
  if (viewerState.isAppSettingsOpen || libraryRootAddInFlight) {
    return;
  }
  switch (event.type) {
    case "enter":
      if (event.paths.length > 0) {
        setLibraryDropOverlay({
          phase: "drag",
          message:
            event.paths.length === 1
              ? t("drop.one")
              : t("drop.many", { count: event.paths.length }),
        });
      }
      break;
    case "over":
      break;
    case "leave":
      if (document.body.dataset.libraryDrag === "active") {
        setLibraryDropOverlay(null);
      }
      break;
    case "drop":
      setLibraryDropOverlay(null);
      void addLibraryRoots(event.paths);
      break;
  }
}

export function initLibraryWelcome() {
  document.querySelector("#config-library-welcome-open")?.addEventListener("click", () => {
    closeAppSettings();
    viewerState.isLibraryWelcomeRequested = true;
    const welcomeStatusEl = document.querySelector<HTMLElement>("#library-welcome-status");
    if (welcomeStatusEl) {
      applyStatusMessage(welcomeStatusEl, "");
    }
    if (viewerState.currentBook || hasActiveLibraryFilter()) {
      // Leaving the book or filter would otherwise cancel the request.
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
      ).then(() => {
        viewerState.isLibraryWelcomeRequested = true;
        renderApp();
      });
      return;
    }
    renderApp();
  });

  document.querySelector("#library-welcome-close")?.addEventListener("click", () => {
    viewerState.isLibraryWelcomeRequested = false;
    renderApp();
  });
}

export async function registerLibraryDrops() {
  await getCurrentWebview().onDragDropEvent((event) => {
    handleLibraryDragDrop(event.payload);
  });

  document.querySelector("#library-welcome-choose")?.addEventListener("click", async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        defaultPath: "~/",
        title: t("welcome.dialogTitle"),
      });
      const path = Array.isArray(selected) ? selected[0] : selected;
      if (path) {
        await addLibraryRoots([path]);
      }
    } catch (error) {
      reportLibraryAddStatus(t("status.chooseFailed", { error: String(error) }), "error");
    }
  });
}
