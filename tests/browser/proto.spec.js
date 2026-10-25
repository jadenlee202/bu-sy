import { test, expect } from "@playwright/test";
import { browserErrors } from "./diagnostics.js";

// The minimal prototype (web/proto.html) on a fixed Monday 3 PM, Boston time.
const NOW = new Date("2026-10-26T15:00:00-04:00");
const ics = (events) => Buffer.from(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\n${events.map(([uid, title, start, end]) =>
  `BEGIN:VEVENT\r\nUID:${uid}\r\nDTSTAMP:20261001T000000Z\r\nSUMMARY:${title}\r\nDTSTART;TZID=America/New_York:${start}\r\nDTEND;TZID=America/New_York:${end}\r\nEND:VEVENT\r\n`).join("")}END:VCALENDAR\r\n`);

async function onboard(page) {
  await page.clock.setFixedTime(NOW);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/proto.html");
  await page.getByRole("link", { name: "Get started" }).click();
  await expect(page.getByRole("switch")).toHaveCount(3);       // wait for the access screen, not the welcome one
  for (const s of await page.getByRole("switch").all()) await s.check();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Got it" }).click();
}

async function pick(page, word, option) {
  await page.locator(`[data-pick="${word}"]`).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: option }).first().click();
  await expect(page.locator(".sheet")).toHaveCount(0);
}

test("one sentence plans the gap with the shared engine", async ({ page }) => {
  const errors = browserErrors(page);
  await onboard(page);
  await expect(page.locator(".sentence").first()).toContainText("I have 1 hr to study");

  await page.locator('[data-pick="from"]').click();
  await page.keyboard.press("Escape");                        // the sheet closes without changing anything
  await expect(page.locator(".sheet")).toHaveCount(0);
  await pick(page, "from", "Mugar Library");
  await pick(page, "to", "Warren Towers");
  await expect(page.locator(".plan")).toContainText("starting from Mugar Library. Then I'm off to Warren Towers.");

  await page.getByRole("link", { name: "Find a spot" }).click();
  await expect(page.locator(".place")).toHaveText("Marciano Commons");
  await expect(page.locator(".steps")).toContainText("3:08 PM");
  await expect(page.locator(".steps")).toContainText("there by 3:50 PM");

  await page.getByRole("link", { name: "See all 2 options" }).click();
  await page.locator(".opt-card").nth(1).getByRole("button", { name: "Choose" }).click();
  await expect(page.locator(".place")).toHaveText("Mugar Library");
  expect(errors).toEqual([]);
});

test("nothing fits offers a fix the engine has checked", async ({ page }) => {
  await onboard(page);
  await pick(page, "activity", "Eat");
  await pick(page, "from", "West Campus");
  await pick(page, "to", "Warren Towers");
  await pick(page, "time", "30 min");
  await page.getByRole("link", { name: "Find a spot" }).click();
  await expect(page.getByRole("heading", { name: "Nothing fits this window" })).toBeVisible();
  await page.getByRole("button", { name: /Extend to 55 minutes/ }).click();
  await expect(page.locator(".place")).toBeVisible();
});

test("an imported schedule fills in free time; a bad file keeps the old one", async ({ page }) => {
  await onboard(page);
  await page.locator('.tabs a[data-tab="schedule"]').click();
  await page.locator("#ics").setInputFiles({ name: "classes.ics", mimeType: "text/calendar", buffer: ics([
    ["a", "BI 108 Lab", "20261026T130000", "20261026T150000"], ["b", "CS 111 Lecture", "20261026T160000", "20261026T171500"]]) });
  await expect(page.locator(".now-card")).toContainText("3:00 PM – 4:00 PM");
  await expect(page.locator(".now-card")).toContainText("then CS 111 Lecture");

  const toggle = page.getByRole("button", { name: /classes and clubs \(2\)/ });
  await expect(page.locator("#events")).toHaveAttribute("inert", "");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#events")).not.toHaveAttribute("inert", "");

  await page.locator("#ics").setInputFiles({ name: "notes.ics", mimeType: "text/calendar", buffer: Buffer.from("not a calendar") });
  await expect(page.getByRole("alert")).toContainText("previous schedule is unchanged");
  await expect(page.locator(".now-card")).toContainText("then CS 111 Lecture");

  await page.getByRole("button", { name: "Plan this time" }).click();
  await expect(page.locator(".chip.free")).toContainText("Free until 4:00 PM");
});

test("explore shows live status and filters places and clubs", async ({ page }) => {
  await onboard(page);
  await page.locator('.tabs a[data-tab="explore"]').click();
  await expect(page.locator("#results")).toContainText("Mugar Library");
  await expect(page.locator("#results li", { hasText: "FitRec" })).toContainText("Open now · until 11:00 PM");
  await page.getByRole("tab", { name: "Clubs" }).click();
  await page.getByLabel("Search places and clubs").fill("run");
  await expect(page.locator("#results li:not([hidden])")).toHaveCount(1);
  await expect(page.locator("#results li:not([hidden])")).toContainText("Charles River Run Club");
});

test("directions show the logo loader, then hand over to Google Maps", async ({ page, context }) => {
  // Google Maps is stubbed so the test never leaves this machine.
  await context.route("https://www.google.com/maps/**", (route) => route.fulfill({ contentType: "text/html", body: "<title>Maps stub</title>" }));
  await onboard(page);
  await expect(page.locator(".topbar .brand")).toContainText("BU-sy");
  await pick(page, "from", "Mugar Library");
  await pick(page, "to", "Warren Towers");
  await page.getByRole("link", { name: "Find a spot" }).click();
  await page.getByRole("link", { name: "Open directions" }).click();
  const loader = page.locator("#loader");
  await expect(loader).toHaveClass(/on/);
  await expect(loader).toContainText("Opening Google Maps");
  await expect(loader.locator(".terrier")).toBeVisible();
  await page.waitForURL(/google\.com\/maps\/dir/);
  expect(new URL(page.url()).searchParams.get("travelmode")).toBe("walking");
});

test("press feedback and transitions are off under reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await onboard(page);
  const btn = page.getByRole("link", { name: "Find a spot" });
  const duration = await btn.evaluate((el) => parseFloat(getComputedStyle(el).transitionDuration));
  expect(duration).toBeLessThan(0.01);
});
