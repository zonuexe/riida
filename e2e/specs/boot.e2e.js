// Smoke test: the app launches, the webview mounts, and the library shell
// renders. `browser` and `$` are injected globally by the WebdriverIO mocha
// framework.

describe("riida library shell", () => {
  it("launches and renders the sidebar brand", async () => {
    // The brand heading is static markup in index.html, so it appears as soon
    // as the frontend bundle mounts in the webview — a reliable signal that the
    // Tauri app booted and the page loaded, without needing an indexed library.
    const brand = await $(".sidebar-brand h1");
    await brand.waitForExist({ timeout: 30000 });
    await expect(brand).toHaveText("riida");
  });

  it("reports the riida document title", async () => {
    await expect(browser).toHaveTitle("riida");
  });
});
