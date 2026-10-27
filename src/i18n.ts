import * as v from "valibot";

/**
 * UI language, chosen from the OS locale. Only the first-run flow is
 * translated so far; the rest of the shell still has fixed copy.
 */
export type Locale = "en" | "ja";

const en = {
  "welcome.kicker": "Welcome to riida",
  "welcome.title": "Bring in your bookshelf",
  "welcome.lead":
    "Drag a folder of PDF or EPUB books anywhere into this window. riida reads the files where they are; nothing is copied or moved.",
  "welcome.dropzone": "Drop a folder here",
  "welcome.choose": "Choose a folder…",
  "welcome.close": "Back to library",
  "welcome.dialogTitle": "Choose a library folder",
  "settings.openWelcome": "Open welcome screen",
  "settings.openWelcomeHint":
    "The welcome screen adds a folder by drag and drop and scans it right away.",
  "drop.one": "Drop to add this folder to your library.",
  "drop.many": "Drop to add these {count} folders to your library.",
  "status.scanning": "Scanning “{name}”…",
  "status.addedOne": "Added “{name}” to your library.",
  "status.addedMany": "Added {count} folders to your library.",
  "status.chooseFailed": "Failed to choose a folder: {error}",
  "rejection.notADirectory": "“{name}” is not a folder. Drop a folder of books.",
  "rejection.outsideHome":
    "“{name}” is outside your home folder, which riida cannot open books from yet.",
  "rejection.alreadyInLibrary": "“{name}” is already in your library.",
  "rejection.failed": "Could not add “{name}”: {error}",
} as const;

export type MessageKey = keyof typeof en;

const ja: Record<MessageKey, string> = {
  "welcome.kicker": "riida へようこそ",
  "welcome.title": "手元の本棚をつなぎましょう",
  "welcome.lead":
    "PDF や EPUB の入ったフォルダを、このウィンドウのどこかにドラッグしてください。ファイルは元の場所のまま読み込み、コピーや移動はしません。",
  "welcome.dropzone": "ここにフォルダをドロップ",
  "welcome.choose": "フォルダを選択…",
  "welcome.close": "ライブラリに戻る",
  "welcome.dialogTitle": "ライブラリのフォルダを選択",
  "settings.openWelcome": "ウェルカム画面を開く",
  "settings.openWelcomeHint":
    "ウェルカム画面では、フォルダをドラッグ＆ドロップで追加し、すぐにスキャンします。",
  "drop.one": "ドロップしてこのフォルダをライブラリに追加",
  "drop.many": "ドロップして {count} 個のフォルダをライブラリに追加",
  "status.scanning": "「{name}」をスキャン中…",
  "status.addedOne": "「{name}」をライブラリに追加しました。",
  "status.addedMany": "{count} 個のフォルダをライブラリに追加しました。",
  "status.chooseFailed": "フォルダを選択できませんでした: {error}",
  "rejection.notADirectory":
    "「{name}」はフォルダではありません。本の入ったフォルダをドロップしてください。",
  "rejection.outsideHome": "「{name}」はホームフォルダの外にあるため、まだ本を開けません。",
  "rejection.alreadyInLibrary": "「{name}」はすでにライブラリに含まれています。",
  "rejection.failed": "「{name}」を追加できませんでした: {error}",
};

const catalogs: Record<Locale, Record<MessageKey, string>> = { en, ja };

/**
 * Pick the UI language from the OS's preferred languages, most preferred
 * first (`navigator.languages`). The first language riida has a catalog for
 * wins; anything else falls back to English.
 */
export function resolveLocale(languages: readonly string[]): Locale {
  for (const language of languages) {
    const primary = language.toLowerCase().split(/[-_]/)[0];
    if (primary === "ja" || primary === "en") {
      return primary;
    }
  }
  return "en";
}

/** Look up a message and fill its `{placeholder}`s. */
export function translate(
  locale: Locale,
  key: MessageKey,
  params: Record<string, string | number> = {},
): string {
  return catalogs[locale][key].replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    name in params ? String(params[name]) : placeholder,
  );
}

export function isMessageKey(value: string): value is MessageKey {
  return value in en;
}

const addLibraryRootErrorSchema = v.variant("kind", [
  v.object({
    kind: v.literal("rejected"),
    reason: v.picklist(["notADirectory", "outsideHome", "alreadyInLibrary"]),
  }),
  v.object({ kind: v.literal("failed"), message: v.string() }),
]);

/**
 * Word an `add_library_root` failure for the user. The command reports a
 * structured reason; anything else (an IPC failure) is shown as text.
 */
export function describeAddLibraryRootError(
  locale: Locale,
  error: unknown,
  folderName: string,
): string {
  const parsed = v.safeParse(addLibraryRootErrorSchema, error);
  if (!parsed.success) {
    return translate(locale, "rejection.failed", { name: folderName, error: String(error) });
  }
  const output = parsed.output;
  if (output.kind === "failed") {
    return translate(locale, "rejection.failed", { name: folderName, error: output.message });
  }
  return translate(locale, `rejection.${output.reason}`, { name: folderName });
}
