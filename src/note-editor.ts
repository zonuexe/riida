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
  // Hide any previously mounted editor wrappers that are still attached to
  // this root. We intentionally do not remove them — see the destroy comment
  // below for the reason.
  for (const sibling of Array.from(root.children)) {
    if (sibling instanceof HTMLElement) {
      sibling.style.display = "none";
    }
  }

  // Mount Milkdown into a dedicated wrapper rather than into `root` directly.
  // This isolates each editor instance's DOM (and its ProseMirror
  // MutationObserver) from sibling wrappers so subsequent mount/destroy
  // cycles don't perturb DOM that an earlier instance is still watching.
  const wrapper = document.createElement("div");
  wrapper.className = "note-editor-instance";
  wrapper.style.cssText = "display: flex; flex-direction: column; height: 100%; min-height: 0;";
  root.appendChild(wrapper);

  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, wrapper);
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
      // Under Tauri 2 on macOS (WKWebView), every form of teardown we tried
      // freezes the renderer a moment after the current task queue drains:
      //   - calling editor.destroy() (Milkdown / ProseMirror's own teardown)
      //   - clearing root.innerHTML while Milkdown's MutationObserver is
      //     still watching the editor DOM
      //   - removing the wrapper from the DOM tree
      // The promises resolve cleanly, but a follow-up paint or CSS recalc
      // never returns and Cmd+Q stops working.
      //
      // We work around it by leaving the Milkdown instance and its DOM
      // exactly where they are and simply hiding the wrapper. The next
      // mount appends a fresh wrapper next to it. The instances leak for
      // the lifetime of the page, but the leak is bounded by the number of
      // books opened in a session and is a fair price for a renderer that
      // does not freeze on Home / Back / book switch.
      void editor;
      wrapper.style.display = "none";
    },
  };
}
