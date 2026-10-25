import { test, expect } from "@playwright/test";

// The other browser checks block the service worker so they always test this
// checkout. These tests turn it on to check the worker itself.
test.use({ serviceWorkers: "allow" });

async function installWorker(page) {
  await page.goto("/#/plan");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
}

test("the worker does not replace other pages with the app shell", async ({ page }) => {
  await installWorker(page);
  await page.goto("/counter/");
  await expect(page).toHaveTitle("BU-sy Counter");
  await expect(page.locator("#toggle")).toBeVisible();
});

test("the version note is never cached", async ({ page, context }) => {
  // version.json exists only in a deployment; serve one (context routes also see the worker's requests).
  await context.route("**/version.json", (route) => route.fulfill({ contentType: "application/json", body: '{"version":1,"commit":"test","history":[]}' }));
  await installWorker(page);
  await page.evaluate(() => fetch("version.json", { cache: "no-store" }));
  expect(await page.evaluate(async () => !!(await caches.match("version.json")))).toBe(false);
});

test("the installed app still opens offline", async ({ page, context }) => {
  await installWorker(page);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator("#plan")).toBeVisible();
});
