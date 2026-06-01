// WebdriverIO config for the Tauri end-to-end smoke test.
//
// IMPORTANT: tauri-driver only supports Linux (WebKitWebDriver / webkit2gtk)
// and Windows (Edge WebDriver). It does NOT support macOS, whose WKWebView has
// no WebDriver implementation. This suite therefore runs only on Linux CI and
// exercises WebKitGTK — a different engine than the WKWebView riida ships on
// macOS. It catches gross regressions (app fails to launch, the webview never
// mounts, the shell does not render) but cannot reproduce macOS/WKWebView-
// specific behavior. See AGENTS.md > End-to-End Smoke Test.

import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

// The built Tauri binary tauri-driver launches. `npm run tauri build` (without
// a --target) writes it here.
const application = path.resolve("src-tauri/target/release/riida");

// tauri-driver is installed with `cargo install tauri-driver`, which lands in
// ~/.cargo/bin. Resolve it explicitly so the spawn does not depend on PATH.
const tauriDriverBin = path.resolve(os.homedir(), ".cargo", "bin", "tauri-driver");

let tauriDriver;

export const config = {
  runner: "local",
  specs: ["./specs/**/*.e2e.js"],
  maxInstances: 1,
  capabilities: [
    {
      maxInstances: 1,
      "tauri:options": {
        application,
      },
    },
  ],
  logLevel: "info",
  bail: 0,
  waitforTimeout: 30000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 3,
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: {
    ui: "bdd",
    timeout: 60000,
  },

  // tauri-driver bridges WebdriverIO to the platform's native WebDriver. Start
  // it before each session and tear it down afterwards.
  beforeSession: () => {
    tauriDriver = spawn(tauriDriverBin, [], {
      stdio: [null, process.stdout, process.stderr],
    });
  },
  afterSession: () => {
    if (tauriDriver) {
      tauriDriver.kill();
    }
  },
};
