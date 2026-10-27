import { describe, expect, it } from "vitest";
import { describeAddLibraryRootError, isMessageKey, resolveLocale, translate } from "./i18n";

describe("resolveLocale", () => {
  it("picks Japanese from a Japanese OS locale", () => {
    expect(resolveLocale(["ja-JP", "en-US"])).toBe("ja");
    expect(resolveLocale(["ja"])).toBe("ja");
  });

  it("honours the most preferred supported language", () => {
    expect(resolveLocale(["en-GB", "ja-JP"])).toBe("en");
  });

  it("skips unsupported languages before a supported one", () => {
    expect(resolveLocale(["fr-FR", "ja_JP"])).toBe("ja");
  });

  it("falls back to English", () => {
    expect(resolveLocale(["fr-FR", "de"])).toBe("en");
    expect(resolveLocale([])).toBe("en");
  });

  it("ignores case", () => {
    expect(resolveLocale(["JA-jp"])).toBe("ja");
  });
});

describe("translate", () => {
  it("fills placeholders", () => {
    expect(translate("en", "status.addedOne", { name: "Books" })).toBe(
      "Added “Books” to your library.",
    );
    expect(translate("ja", "status.addedMany", { count: 3 })).toBe(
      "3 個のフォルダをライブラリに追加しました。",
    );
  });

  it("leaves unknown placeholders visible", () => {
    expect(translate("en", "status.scanning")).toBe("Scanning “{name}”…");
  });

  it("returns plain messages unchanged", () => {
    expect(translate("ja", "welcome.choose")).toBe("フォルダを選択…");
  });
});

describe("isMessageKey", () => {
  it("accepts catalog keys only", () => {
    expect(isMessageKey("welcome.title")).toBe(true);
    expect(isMessageKey("welcome.nope")).toBe(false);
  });
});

describe("describeAddLibraryRootError", () => {
  it("words each rejection reason", () => {
    expect(
      describeAddLibraryRootError("en", { kind: "rejected", reason: "notADirectory" }, "a.pdf"),
    ).toBe("“a.pdf” is not a folder. Drop a folder of books.");
    expect(
      describeAddLibraryRootError("ja", { kind: "rejected", reason: "outsideHome" }, "Books"),
    ).toBe("「Books」はホームフォルダの外にあるため、まだ本を開けません。");
    expect(
      describeAddLibraryRootError("ja", { kind: "rejected", reason: "alreadyInLibrary" }, "Books"),
    ).toBe("「Books」はすでにライブラリに含まれています。");
  });

  it("includes the backend message for other failures", () => {
    expect(
      describeAddLibraryRootError("en", { kind: "failed", message: "disk full" }, "Books"),
    ).toBe("Could not add “Books”: disk full");
  });

  it("falls back to the raw error for unexpected shapes", () => {
    expect(describeAddLibraryRootError("en", "IPC closed", "Books")).toBe(
      "Could not add “Books”: IPC closed",
    );
    expect(
      describeAddLibraryRootError("en", { kind: "rejected", reason: "mystery" }, "Books"),
    ).toBe("Could not add “Books”: [object Object]");
  });
});
