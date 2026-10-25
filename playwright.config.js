import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/browser",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  workers: 2,
  retries: 0,
  timeout: 45_000,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    browserName: "chromium",
    baseURL: "http://127.0.0.1:4173",
    serviceWorkers: "block", // Always test this checkout, not a previously cached release.
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node tools/serve-web.mjs",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
  },
});
