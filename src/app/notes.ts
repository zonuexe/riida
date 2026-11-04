// Floating note window: Milkdown editor lifecycle, autosave, drag and resize.

import { invoke } from "@tauri-apps/api/core";
import type { NoteEditorHandle } from "../note-editor";
import {
  clampNoteWindowPosition,
  ensureNoteWindowPlacement as ensureNoteWindowPlacementForViewport,
  beginNoteWindowInteraction,
  idleNoteWindowInteraction,
  noteWindowFrameForPointer,
  type NoteWindowInteraction,
} from "../note-window-utils";
import { renderApp } from "./shell";
import { viewerSettings, viewerState } from "./state";
import type { NoteDocument } from "./types";

type NoteState = {
  isOpen: boolean;
  isLoading: boolean;
  isSaving: boolean;
  activeFilePath: string | null;
  currentContent: string;
  savedContent: string;
  statusMessage: string;
  x: number | null;
  y: number | null;
  width: number;
  height: number;
};

let noteEditor: NoteEditorHandle | null = null;
export let noteSaveTimer: number | null = null;
let noteLoadToken = 0;
// Suppress scheduleNoteSave callbacks that fire while we are tearing down the
// Milkdown editor. Without this guard, Milkdown's listener plugin emits a
// final markdownUpdated event during editor.destroy() while the editor still
// has focus, which calls syncNoteUi → DOM mutation → ProseMirror's
// MutationObserver → another markdownUpdated → infinite re-entry, freezing the
// renderer. See https://github.com/Milkdown/milkdown/issues for related reports.
let isDestroyingNoteEditor = false;

let noteEditorModulePromise: Promise<typeof import("../note-editor")> | null = null;

async function loadNoteEditorModule() {
  noteEditorModulePromise ??= import("../note-editor");
  return noteEditorModulePromise;
}

export const noteState: NoteState = {
  isOpen: false,
  isLoading: false,
  isSaving: false,
  activeFilePath: null,
  currentContent: "",
  savedContent: "",
  statusMessage: "Notes are saved automatically.",
  x: null,
  y: null,
  width: 420,
  height: 540,
};

const noteInteractionState: NoteWindowInteraction = idleNoteWindowInteraction();

export function clampNoteWindow() {
  const nextState = clampNoteWindowPosition(noteState, {
    width: window.innerWidth,
    height: window.innerHeight,
  });
  noteState.x = nextState.x;
  noteState.y = nextState.y;
}

function ensureNoteWindowPlacement() {
  const nextState = ensureNoteWindowPlacementForViewport(noteState, {
    width: window.innerWidth,
    height: window.innerHeight,
  });
  noteState.x = nextState.x;
  noteState.y = nextState.y;
}

export function shouldAnchorNoteWindowToBottomRight() {
  return viewerSettings.alignMode === "left" || viewerSettings.alignMode === "center";
}

export function syncNoteUi() {
  const noteToggleEl = document.querySelector<HTMLButtonElement>("#note-toggle");
  const notePanelEl = document.querySelector<HTMLElement>("#note-panel");
  const noteEditorEl = document.querySelector<HTMLElement>("#note-editor");

  const hasBook = Boolean(viewerState.currentBook);

  if (noteToggleEl) {
    noteToggleEl.hidden = !hasBook || noteState.isOpen;
    noteToggleEl.textContent = "Notes";
  }

  if (notePanelEl) {
    notePanelEl.hidden = !hasBook || !noteState.isOpen;
    if (!notePanelEl.hidden) {
      ensureNoteWindowPlacement();
      notePanelEl.style.left = `${noteState.x}px`;
      notePanelEl.style.top = `${noteState.y}px`;
      notePanelEl.style.width = `${noteState.width}px`;
      notePanelEl.style.height = `${noteState.height}px`;
    }
  }

  if (noteEditorEl) {
    noteEditorEl.dataset.empty = noteState.currentContent ? "false" : "true";
  }
}

export async function destroyNoteEditor() {
  if (!noteEditor) {
    return;
  }

  const editor = noteEditor;
  noteEditor = null;
  isDestroyingNoteEditor = true;
  try {
    await editor.destroy();
  } finally {
    isDestroyingNoteEditor = false;
  }
}

async function saveNoteNow() {
  if (!noteState.activeFilePath) {
    return;
  }

  noteSaveTimer = null;
  noteState.isSaving = true;
  noteState.statusMessage = "Saving notes...";
  syncNoteUi();

  try {
    const note = await invoke<NoteDocument>("save_note", {
      filePath: noteState.activeFilePath,
      content: noteState.currentContent,
    });

    noteState.savedContent = note.content;
    noteState.statusMessage = "Saved";
  } catch (error) {
    noteState.statusMessage = `Failed to save notes: ${String(error)}`;
  } finally {
    noteState.isSaving = false;
    syncNoteUi();
  }
}

function scheduleNoteSave(markdown: string) {
  // Milkdown emits a final markdownUpdated event during destroy() while the
  // editor still has focus. Bail out so the teardown does not re-enter
  // syncNoteUi → DOM mutation → ProseMirror MutationObserver → another
  // markdownUpdated, which previously hung the renderer.
  if (isDestroyingNoteEditor) {
    return;
  }
  noteState.currentContent = markdown;
  noteState.statusMessage = "Waiting to save...";
  syncNoteUi();

  if (noteSaveTimer !== null) {
    window.clearTimeout(noteSaveTimer);
  }

  noteSaveTimer = window.setTimeout(() => {
    void saveNoteNow();
  }, 900);
}

export async function flushPendingNoteSave() {
  if (noteSaveTimer === null || noteState.currentContent === noteState.savedContent) {
    return;
  }

  window.clearTimeout(noteSaveTimer);
  await saveNoteNow();
}

export async function loadNoteForCurrentBook() {
  const noteRootEl = document.querySelector<HTMLElement>("#note-editor");
  const currentBook = viewerState.currentBook;

  if (!currentBook || !noteState.isOpen || !noteRootEl) {
    return;
  }

  if (noteState.activeFilePath === currentBook.filePath && noteEditor) {
    return;
  }

  await flushPendingNoteSave();
  await destroyNoteEditor();

  noteLoadToken += 1;
  const currentToken = noteLoadToken;
  noteState.isLoading = true;
  noteState.activeFilePath = currentBook.filePath;
  noteState.currentContent = "";
  noteState.savedContent = "";
  noteState.statusMessage = "Loading notes...";
  syncNoteUi();

  try {
    const note = await invoke<NoteDocument>("load_note", {
      filePath: currentBook.filePath,
    });

    if (currentToken !== noteLoadToken) {
      return;
    }

    noteState.activeFilePath = note.filePath;
    noteState.currentContent = note.content;
    noteState.savedContent = note.content;
    noteState.statusMessage = note.updatedAt ? "Saved" : "Notes are saved automatically.";

    const { mountNoteEditor } = await loadNoteEditorModule();
    noteEditor = await mountNoteEditor({
      root: noteRootEl,
      initialMarkdown: note.content,
      onMarkdownChange: (markdown) => {
        scheduleNoteSave(markdown);
      },
    });
  } catch (error) {
    noteState.statusMessage = `Failed to load notes: ${String(error)}`;
  } finally {
    if (currentToken === noteLoadToken) {
      noteState.isLoading = false;
      syncNoteUi();
    }
  }
}

function beginNoteDrag(event: PointerEvent) {
  const target = event.target as HTMLElement | null;
  if (!target || target.closest("#note-close")) {
    return;
  }

  event.preventDefault();
  ensureNoteWindowPlacement();

  Object.assign(
    noteInteractionState,
    beginNoteWindowInteraction(noteState, null, event.clientX, event.clientY),
  );
}

function beginNoteResize(event: PointerEvent, edge: string) {
  event.preventDefault();
  ensureNoteWindowPlacement();

  Object.assign(
    noteInteractionState,
    beginNoteWindowInteraction(noteState, edge, event.clientX, event.clientY),
  );
}

function updateNoteInteraction(event: PointerEvent) {
  const frame = noteWindowFrameForPointer(noteInteractionState, event.clientX, event.clientY, {
    width: window.innerWidth,
    height: window.innerHeight,
  });
  if (!frame) {
    return;
  }

  Object.assign(noteState, frame);
  clampNoteWindow();
  syncNoteUi();
}

function endNoteInteraction() {
  Object.assign(noteInteractionState, idleNoteWindowInteraction());
}

export function initNotes() {
  const noteToggleEl = document.querySelector<HTMLButtonElement>("#note-toggle");
  const noteCloseEl = document.querySelector<HTMLButtonElement>("#note-close");
  const noteDragHandleEl = document.querySelector<HTMLElement>("#note-drag-handle");
  const noteResizeEls = document.querySelectorAll<HTMLElement>(".note-resize-handle");

  noteToggleEl?.addEventListener("click", () => {
    noteState.isOpen = !noteState.isOpen;
    renderApp();
    if (noteState.isOpen) {
      void loadNoteForCurrentBook();
    }
  });

  noteCloseEl?.addEventListener("click", () => {
    noteState.isOpen = false;
    renderApp();
  });

  noteDragHandleEl?.addEventListener("pointerdown", (event) => {
    beginNoteDrag(event);
  });

  for (const resizeEl of noteResizeEls) {
    resizeEl.addEventListener("pointerdown", (event) => {
      const edge = resizeEl.dataset.resize;
      if (!edge) {
        return;
      }

      beginNoteResize(event, edge);
    });
  }

  window.addEventListener("pointermove", (event) => {
    updateNoteInteraction(event);
  });

  window.addEventListener("pointerup", () => {
    endNoteInteraction();
  });
}
