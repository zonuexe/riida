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
      await editor.destroy();
      root.innerHTML = "";
    },
  };
}
