// About dialog: app identity, license and third-party notices.

import { getName, getVersion } from "@tauri-apps/api/app";
import { viewerState } from "./state";

let cachedAppName = "riida";
let cachedAppVersion = "0.9.5";
const buildDate = __BUILD_DATE__;
let cachedLicenseText = "Loading license text...";
let cachedThirdPartyRustText = "Loading Rust notices...";
let cachedThirdPartyJsText = "Loading JavaScript notices...";

function syncAboutUi() {
  const modalEl = document.querySelector<HTMLElement>("#app-about-modal");
  const nameEl = document.querySelector<HTMLElement>("#app-about-name");
  const versionEl = document.querySelector<HTMLElement>("#app-about-version");
  const buildDateEl = document.querySelector<HTMLElement>("#app-about-build-date");
  const licenseEl = document.querySelector<HTMLElement>("#app-license-text");
  const thirdPartyRustEl = document.querySelector<HTMLElement>("#app-third-party-rust-text");
  const thirdPartyJsEl = document.querySelector<HTMLElement>("#app-third-party-js-text");

  if (modalEl) {
    modalEl.hidden = !viewerState.isAboutOpen;
  }

  if (nameEl) {
    nameEl.textContent = cachedAppName;
  }

  if (versionEl) {
    versionEl.textContent = cachedAppVersion;
  }

  if (buildDateEl) {
    buildDateEl.textContent = `(built ${buildDate})`;
  }

  if (licenseEl) {
    licenseEl.textContent = cachedLicenseText;
  }

  if (thirdPartyRustEl) {
    thirdPartyRustEl.textContent = cachedThirdPartyRustText;
  }

  if (thirdPartyJsEl) {
    thirdPartyJsEl.textContent = cachedThirdPartyJsText;
  }
}

async function loadThirdPartyLicenses() {
  try {
    const [licenseModule, rustModule, jsModule] = await Promise.all([
      import("../../LICENSE?raw"),
      import("../../THIRD-PARTY-LICENSES-rust.md?raw"),
      import("../../THIRD-PARTY-LICENSES-js.md?raw"),
    ]);

    cachedLicenseText = licenseModule.default.trim();
    cachedThirdPartyRustText = rustModule.default.trim();
    cachedThirdPartyJsText = jsModule.default.trim();
  } catch (error) {
    const message = `Failed to load third-party notices: ${String(error)}`;
    cachedLicenseText = message;
    cachedThirdPartyRustText = message;
    cachedThirdPartyJsText = message;
  }
}

export const closeAbout = () => {
  viewerState.isAboutOpen = false;
  syncAboutUi();
};

export function initAbout() {
  const appAboutOpenEl = document.querySelector<HTMLButtonElement>("#app-about-open");
  const appAboutCloseEl = document.querySelector<HTMLButtonElement>("#app-about-close");
  const appAboutDoneEl = document.querySelector<HTMLButtonElement>("#app-about-done");
  const appAboutBackdropEl = document.querySelector<HTMLElement>("#app-about-backdrop");

  appAboutOpenEl?.addEventListener("click", () => {
    viewerState.isAboutOpen = true;
    syncAboutUi();
    if (
      cachedThirdPartyRustText === "Loading Rust notices..." ||
      cachedThirdPartyJsText === "Loading JavaScript notices..."
    ) {
      void loadThirdPartyLicenses().then(() => {
        syncAboutUi();
      });
    }
  });

  appAboutCloseEl?.addEventListener("click", closeAbout);
  appAboutDoneEl?.addEventListener("click", closeAbout);
  appAboutBackdropEl?.addEventListener("click", closeAbout);
}

export async function loadAppMetadata() {
  try {
    cachedAppName = await getName();
    cachedAppVersion = await getVersion();
  } catch (error) {
    console.error("failed to load app metadata", error);
  }
  syncAboutUi();
}
