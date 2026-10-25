import { test, expect } from "@playwright/test";
import { browserErrors } from "./diagnostics.js";

// Replaces the untracked dynamic_check.mjs scratch check. The photo hero
// intentionally replaced .planner-skyline in a11fe7a; test the current artwork
// and its fallback, not the obsolete SVG build animation.
for (const width of [390, 1280]) {
  test(`${width}px: motion, replay, interactions and current planner hero`, async ({ page }, info) => {
    const errors = browserErrors(page);
    try {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.goto("/#/places");
      await expect(page.locator("#places a.row").first()).toBeVisible();
      const cascade = await page.locator("main").evaluate((main) => ({
        first: getComputedStyle(main.firstElementChild).animationName,
        rows: [...main.querySelectorAll(".list > li")].slice(0, 3).map((el) => ({
          name: getComputedStyle(el).animationName, delay: parseFloat(getComputedStyle(el).animationDelay),
        })),
      }));
      expect(cascade.first).toBe("rise-in-lg");
      expect(cascade.rows).toHaveLength(3);
      expect(cascade.rows.every((row) => row.name === "rise-in")).toBeTruthy();
      expect(cascade.rows[2].delay).toBeGreaterThan(cascade.rows[0].delay);
      await expect(page.locator("main")).not.toHaveClass(/view-enter/);
      const row = page.locator("#places a.row").first();
      await row.hover();
      await expect.poll(() => row.evaluate((el) => getComputedStyle(el, "::before").transform))
        .toBe("matrix(1, 0, 0, 1, 0, 0)");
      await row.focus();
      expect(await row.evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe("none");

      await page.goto("/#/place/fitrec-synthetic");
      await expect(page.locator(".chart svg .bar").first()).toBeVisible();
      const delays = await page.locator(".chart svg.is-entering .bar").evaluateAll((bars) =>
        bars.slice(0, 4).map((bar) => parseFloat(getComputedStyle(bar).animationDelay)));
      expect(delays).toHaveLength(4);
      expect(delays[3]).toBeGreaterThan(delays[0]);
      await expect(page.locator("main")).not.toHaveClass(/view-enter/);
      await page.locator(".pb-range").fill("900");
      const fill = await page.locator(".pb-range").evaluate((el) => parseFloat(el.style.getPropertyValue("--pct")));
      expect(Math.abs(fill - 900 / 1439 * 100)).toBeLessThan(0.5);
      await expect(page.locator("#hero .big")).toHaveClass(/is-changed/);
      await page.locator('[data-pb="toggle"]').click();
      await expect(page.locator(".playback")).toHaveClass(/is-playing/);
      await expect.poll(() => page.locator(".pb-status").evaluate((el) => getComputedStyle(el, "::before").backgroundColor)).toBe("rgb(204, 0, 0)");
      await expect(page.locator("main")).not.toHaveClass(/view-enter/);
      await page.locator('[data-pb="toggle"]').click();

      await page.locator('.tabbar [data-section="plan"]').click();
      await expect(page.locator("#plan")).toBeVisible();
      const image = page.locator(".hero-photo .hero-img");
      await expect(image).toBeVisible();
      await expect.poll(() => image.evaluate((img) => img.complete && img.naturalWidth > 0)).toBeTruthy();
      await expect(page.locator(".hero-photo h1")).toBeVisible();
      await page.locator('#plan label').filter({ has: page.locator('input[name="activity"][value="eat"]') }).click();
      await expect(page.locator('input[name="activity"][value="eat"]')).toBeChecked();

      await page.goto("/#/sources");
      await expect(page.locator(".src-section").first()).toBeVisible();
      expect(await page.locator(".reveal").count()).toBeGreaterThan(0);
      // Walk all content through the viewport; don't assume a hardcoded page height.
      await page.evaluate(async () => {
        for (let y = 0; y < document.documentElement.scrollHeight; y += 350) {
          window.scrollTo(0, y);
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      });
      await expect(page.locator(".reveal:not(.in-view)")).toHaveCount(0);
      await expect.poll(() => page.locator(".reveal").evaluateAll((elements) => elements.every((el) => getComputedStyle(el).opacity === "1"))).toBeTruthy();
      expect(errors).toEqual([]);
    } finally {
      await info.attach("browser-errors", { body: JSON.stringify({ width, errors }), contentType: "application/json" });
    }
  });
}

test("planner photo failure uses the existing SVG fallback", async ({ page }) => {
  await page.route("**/assets/campus/boston-hero.jpg", (route) => route.abort());
  await page.goto("/#/plan");
  await expect(page.locator("#plan")).toBeVisible();
  await expect(page.locator(".hero-photo .hero-bg svg")).toBeVisible();
  await expect(page.locator(".hero-photo h1")).toBeVisible();
});

test("reduced motion keeps all content visible and transitions short", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/#/sources");
  await expect(page.locator(".src-section").first()).toBeVisible();
  await expect(page.locator(".reveal")).toHaveCount(0);
  const duration = await page.locator("main > *").first().evaluate((el) => parseFloat(getComputedStyle(el).animationDuration));
  expect(duration).toBeLessThanOrEqual(0.001);
  await page.locator('.tabbar [data-section="places"]').click();
  const row = page.locator("#places a.row").first();
  await expect(row).toBeVisible();
  expect(await row.evaluate((el) => Math.max(...getComputedStyle(el).transitionDuration.split(",").map(parseFloat)))).toBeLessThanOrEqual(0.001);
});
