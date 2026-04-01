export type NavigationShortcutInput = {
  platform: string;
  key: string;
  metaKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
};

export function isNavigationBackShortcut(input: NavigationShortcutInput) {
  const isMac = input.platform.toUpperCase().includes("MAC");

  return (
    input.key === "BrowserBack" ||
    (isMac &&
      input.metaKey &&
      !input.shiftKey &&
      !input.ctrlKey &&
      !input.altKey &&
      (input.key === "[" || input.key === "ArrowLeft")) ||
    (!isMac && input.altKey && !input.metaKey && !input.ctrlKey && input.key === "ArrowLeft")
  );
}

export function isNavigationForwardShortcut(input: NavigationShortcutInput) {
  const isMac = input.platform.toUpperCase().includes("MAC");

  return (
    input.key === "BrowserForward" ||
    (isMac &&
      input.metaKey &&
      !input.shiftKey &&
      !input.ctrlKey &&
      !input.altKey &&
      (input.key === "]" || input.key === "ArrowRight")) ||
    (!isMac && input.altKey && !input.metaKey && !input.ctrlKey && input.key === "ArrowRight")
  );
}
