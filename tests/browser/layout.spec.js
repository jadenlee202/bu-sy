import { test, expect } from "@playwright/test";
import { browserErrors } from "./diagnostics.js";
import { readFileSync } from "node:fs";
import postcss from "postcss";

const tabs = ["plan", "places", "calendar", "clubs"];
const ready = { plan: "#plan", places: "#places a.row", calendar: "#calendar-date", clubs: "#clubs .club" };

export async function frameMeasurements(page) {
  return page.evaluate(() => {
    const frame = document.querySelector(".app");
    const rect = frame.getBoundingClientRect();
    const style = getComputedStyle(frame);
    const bar = document.querySelector(".tabbar").getBoundingClientRect();
    return { viewport: innerWidth, width: rect.width, left: rect.left, right: rect.right,
      scrollWidth: document.documentElement.scrollWidth, boxSizing: style.boxSizing,
      borders: parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth),
      bar: { width: bar.width, left: bar.left, top: bar.top, bottom: bar.bottom } };
  });
}

test("layout guard rejects a parseable comment swallowing the phone shell", async ({ page }) => {
  const css = readFileSync(new URL("../../web/styles.css", import.meta.url), "utf8");
  const start = css.indexOf("/* The phone frame:");
  const end = css.indexOf("/* ---------- Boston-blue", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  // In-memory response fixture only: recreate a comment swallowing the entire
  // shell even when it eventually closes and a syntax parser accepts the file.
  const swallowed = `/* ${css.slice(start, end).replaceAll("*/", "* /")} */`;
  const fixture = css.slice(0, start) + swallowed + css.slice(end);
  postcss.parse(fixture);
  await page.route("**/styles.css", (route) => route.fulfill({ contentType: "text/css", body: fixture }));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/#/plan");
  await expect(page.locator("#plan")).toBeVisible();
  expect((await frameMeasurements(page)).width).toBeGreaterThan(430);
  await expect(assertFrame(page)).rejects.toThrow();
});

async function assertFrame(page) {
  const m = await frameMeasurements(page);
  const diagnostic = JSON.stringify(m);
  // getBoundingClientRect measures the border box; global border-box includes the
  // two 1px wide-screen borders inside the intended 430px, rather than adding 2px.
  expect(m.boxSizing, diagnostic).toBe("border-box");
  expect(Math.abs(m.width - Math.min(430, m.viewport)), diagnostic).toBeLessThanOrEqual(1);
  expect(Math.abs(m.left - (m.viewport - m.width) / 2), diagnostic).toBeLessThanOrEqual(1);
  expect(m.scrollWidth, diagnostic).toBeLessThanOrEqual(m.viewport + 1);
  expect(m.left, diagnostic).toBeGreaterThanOrEqual(-1);
  expect(m.right, diagnostic).toBeLessThanOrEqual(m.viewport + 1);
  expect(Math.abs(m.bar.width - m.width), diagnostic).toBeLessThanOrEqual(1);
  expect(Math.abs(m.bar.left - m.left), diagnostic).toBeLessThanOrEqual(1);
  const nav = page.getByRole("navigation", { name: "Primary" });
  await expect(nav).toBeVisible();
  for (const tab of tabs) {
    const link = nav.locator(`[data-section="${tab}"]`);
    await expect(link).toBeInViewport();
    await link.click({ trial: true }); // Hit-testing also catches an obscured tab.
  }
  expect(await page.locator("main").evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom)), diagnostic)
    .toBeGreaterThanOrEqual(m.bar.bottom - m.bar.top);
  // The final page content must be reachable above the fixed navigation.
  const lastLink = page.locator(".foot a").last();
  await lastLink.scrollIntoViewIfNeeded();
  await expect(lastLink).toBeInViewport();
  await lastLink.click({ trial: true });
}

test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus) {
    await info.attach("layout-measurements", { body: JSON.stringify(await frameMeasurements(page).catch(() => null), null, 2), contentType: "application/json" });
  }
});

for (const width of [375, 390, 430, 768, 1280]) {
  for (const theme of ["light", "dark"]) {
    test(`${width}px ${theme}: phone frame, tabs, routes and controls`, async ({ page }, info) => {
      const errors = browserErrors(page);
      try {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
        await page.clock.setFixedTime(new Date("2026-10-26T16:00:00Z"));
        for (const tab of tabs) {
          await test.step(`${tab}: direct navigation and refresh`, async () => {
            await page.goto(`/#/${tab}`);
            await expect(page.locator(ready[tab]).first()).toBeVisible();
            await page.reload();
            await expect(page.locator(ready[tab]).first()).toBeVisible();
            await expect(page.locator(`.tabbar [data-section="${tab}"]`)).toHaveAttribute("aria-current", "");
            await assertFrame(page);
            if (tab === "plan") {
              await page.locator('#plan select[name="from"]').selectOption({ index: 1 });
              await page.getByRole("button", { name: "Find options", exact: true }).click();
              await expect(page.locator("#results")).not.toBeEmpty();
            } else if (tab === "places") {
              await page.getByRole("searchbox", { name: "Search places" }).fill("Mugar");
              await expect(page.locator('#places a[href="#/place/mugar-synthetic"]')).toBeVisible();
            } else if (tab === "calendar") {
              const previous = await page.locator("#calendar-date").inputValue();
              await page.getByRole("button", { name: "Next day", exact: true }).click();
              await expect(page.locator("#calendar-date")).not.toHaveValue(previous);
            } else {
              await page.getByRole("searchbox", { name: "Search clubs" }).fill("zz-no-matching-club");
              await expect(page.locator("#clubs .club")).toHaveCount(0);
              await page.getByRole("searchbox", { name: "Search clubs" }).fill("");
              await expect(page.locator("#clubs .club").first()).toBeVisible();
            }
          });
        }
        for (const tab of tabs) {
          await page.locator(`.tabbar [data-section="${tab}"]`).click();
          await expect(page.locator(ready[tab]).first()).toBeVisible();
          await expect(page).toHaveURL(new RegExp(`#/${tab}$`));
        }
        for (const [route, selector] of [["sources", ".src-section"], ["about", "h1"], ["place/mugar-synthetic", "#location-hours"]]) {
          await page.goto(`/#/${route}`);
          await expect(page.locator(selector).first()).toBeVisible();
          await page.reload();
          await expect(page.locator(selector).first()).toBeVisible();
          await assertFrame(page);
        }
        expect(errors).toEqual([]);
      } finally {
        await info.attach("browser-errors", { body: JSON.stringify({ width, theme, errors }, null, 2), contentType: "application/json" });
      }
    });
  }
}
