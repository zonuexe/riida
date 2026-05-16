import { Editor } from "@milkdown/kit/core";
import { defaultValueCtx, rootCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
import { nord } from "@milkdown/theme-nord";
import "@milkdown/theme-nord/style.css";

export type NoteEditorHandle = {
  destroy: () => Promise<void>;
};

type MountNoteEditorOptions = {
  root: HTMLElement;
  initialMarkdown: string;
  onMarkdownChange: (markdown: string) => void;
};

export async function mountNoteEditor({
  root,
  initialMarkdown,
  onMarkdownChange,
}: MountNoteEditorOptions): Promise<NoteEditorHandle> {
  root.innerHTML = "";

  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, initialMarkdown);
      nord(ctx);
      ctx.get(listenerCtx).markdownUpdated((_, markdown) => {
        onMarkdownChange(markdown);
      });
    })
    .use(commonmark)
    .use(listener)
    .create();

  return {
    destroy: async () => {
      // Intentionally avoid calling editor.destroy(). Under Tauri 2 on macOS
      // (WKWebView), invoking Milkdown / ProseMirror's destroy() inside a
      // navigation teardown causes the renderer to freeze a moment after the
      // current task queue drains — even hanging the JS event loop hard
      // enough to make Cmd+Q unresponsive. The destroy() promise itself
      // resolves cleanly; the freeze comes from work it schedules onto the
      // renderer thread (likely a CSS recalc or layout cascade triggered by
      // ProseMirror's DOM cleanup).
      //
      // We work around it by removing the editor's DOM but leaving the
      // Editor instance in memory until the page unloads. The remaining
      // instances are small relative to the rest of the app and bounded by
      // the number of books opened in a single session.
      void editor;
      root.innerHTML = "";
    },
  };
}
