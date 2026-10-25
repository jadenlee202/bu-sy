import { test, expect } from "@playwright/test";
import { browserErrors } from "./diagnostics.js";

// The BU-sy app (web/index.html) on a fixed Monday 3 PM, Boston time.
const NOW = new Date("2026-10-26T15:00:00-04:00");
const ics = (events) => Buffer.from(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\n${events.map(([uid, title, start, end]) =>
  `BEGIN:VEVENT\r\nUID:${uid}\r\nDTSTAMP:20261001T000000Z\r\nSUMMARY:${title}\r\nDTSTART;TZID=America/New_York:${start}\r\nDTEND;TZID=America/New_York:${end}\r\nEND:VEVENT\r\n`).join("")}END:VCALENDAR\r\n`);

const MUGAR = { latitude: 42.351012, longitude: -71.107992 };
const HARVARD_SQ = { latitude: 42.3734, longitude: -71.1189 };     // ~2.3 km from West Campus: a long walk

async function onboard(page, { at = MUGAR } = {}) {
  if (at) { await page.context().grantPermissions(["geolocation"]); await page.context().setGeolocation(at); }
  await page.clock.setFixedTime(NOW);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
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

test("one sentence plans the gap: walk from where you are, then the activity, nothing else", async ({ page }) => {
  const errors = browserErrors(page);
  await onboard(page);
  await expect(page.locator(".sentence")).toHaveText("I have 1 hr to study.");
  await expect(page.locator('[data-pick="from"], [data-pick="to"]')).toHaveCount(0);   // no start, no next stop

  await page.locator('[data-pick="time"]').click();
  await page.keyboard.press("Escape");                        // the sheet closes without changing anything
  await expect(page.locator(".sheet")).toHaveCount(0);

  await page.getByRole("link", { name: "Find a spot" }).click();
  await expect(page.locator(".place")).toBeVisible();
  await expect(page.locator(".steps li")).toHaveCount(2);                     // walk there, then study
  await expect(page.locator(".steps")).toContainText("from you (estimate)");
  await expect(page.locator(".steps")).toContainText("Study until 4:00 PM");  // no buffer: the activity runs to the end
  await expect(page.locator(".what .busy-icon")).toHaveAttribute("data-level", /quiet|moderate|busy/);
  const bar = await page.locator(".answer .bar").getAttribute("aria-label");
  expect(bar).not.toMatch(/buffer|preparation|cleanup|onward/);

  await page.getByRole("link", { name: /See all \d+ options/ }).click();
  await expect(page.locator(".legend")).toHaveText(/Walk\s*Study/);
  await page.locator(".opt-card").nth(1).getByRole("button", { name: "Choose" }).click();
  await expect(page.locator(".place")).toBeVisible();
  expect(errors).toEqual([]);
});

test("with location refused, it says why and offers a nearby building instead", async ({ page }) => {
  await onboard(page, { at: null });
  await page.getByRole("link", { name: "Find a spot" }).click();
  await expect(page.getByRole("heading", { name: "Where are you?" })).toBeVisible();
  await page.getByRole("button", { name: "I'm near a campus building" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Mugar Library" }).click();
  await expect(page.locator(".place")).toBeVisible();
  await expect(page.locator(".steps")).toContainText(/from Mugar Library|You're already there/);
});

test("nothing fits offers a fix the engine has checked", async ({ page }) => {
  await onboard(page, { at: HARVARD_SQ });
  await pick(page, "activity", "Eat");
  await pick(page, "time", "30 min");
  await page.getByRole("link", { name: "Find a spot" }).click();
  await expect(page.getByRole("heading", { name: "Nothing fits this window" })).toBeVisible();
  await page.getByRole("button", { name: /Extend to \d+ minutes/ }).first().click();
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
  // every open place shows a busyness meter with its word; unverified hours show empty bars and "no data", not "closed"
  const fitrec = page.locator("#results li", { hasText: "FitRec" }).locator(".busy-icon");
  await expect(fitrec).toHaveAttribute("aria-label", /Busyness: (quiet|moderate|busy|no data), simulated/);
  const fenway = page.locator("#results li", { hasText: "Fenway Dining" });
  await expect(fenway.locator(".busy-icon")).toHaveAttribute("data-level", "unknown");
  await expect(fenway.locator(".busy-icon rect.on")).toHaveCount(0);
  await expect(fenway.locator(".busy")).toHaveText("no data");
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
  await page.getByRole("link", { name: "Find a spot" }).click();
  await page.getByRole("link", { name: "Open directions" }).click();
  const loader = page.locator("#loader");
  await expect(loader).toHaveClass(/on/);
  await expect(loader).toContainText("Opening Google Maps");
  await expect(loader.locator(".pin-clock")).toBeVisible();
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

test("a place page shows live status, the busyness meter, the day chart, hours and sources", async ({ page }) => {
  const errors = browserErrors(page);
  await onboard(page);
  await page.locator('.tabs a[data-tab="explore"]').click();
  await page.locator("#results li", { hasText: "Mugar Library" }).getByRole("link").click();
  await expect(page.getByRole("heading", { name: "Mugar Library" })).toBeVisible();
  await expect(page.locator("#view")).toContainText("Open now · until 2:00 AM");
  await expect(page.locator("#view .busy-icon")).toHaveAttribute("data-level", /quiet|moderate|busy/);
  await expect(page.locator(".day-chart .col")).toHaveCount(16);
  await expect(page.locator(".day-chart .col.now")).toHaveCount(1);                  // 3 PM is marked
  await expect(page.locator("#view")).toContainText("Mon, Oct 26 · today");
  await expect(page.locator("#view")).toContainText("7:00 AM–2:00 AM (next day)");
  await expect(page.getByRole("link", { name: "Source" }).first()).toHaveAttribute("href", /bu\.edu/);
  await expect(page.getByRole("link", { name: "Open directions" })).toBeVisible();
  await page.locator("#view .back").click();
  await expect(page.locator(".seg")).toBeVisible();
  expect(errors).toEqual([]);
});

test("a club page lets you add a meeting to your calendar and join", async ({ page }) => {
  const errors = browserErrors(page);
  await onboard(page);
  await page.goto("/#/club/example-1");                                                 // Charles River Run Club (sample)
  await expect(page.getByRole("heading", { name: "Charles River Run Club" })).toBeVisible();
  await expect(page.locator("#view")).toContainText("Sample club");
  const add = page.getByRole("button", { name: "Add to calendar" }).first();
  await add.click();
  await expect(page.getByRole("button", { name: "Added ✓" }).first()).toBeVisible();
  await page.getByLabel("Full name").fill("Test Student");
  await page.getByLabel("School email").fill("test@gmail.com");
  await page.getByLabel("Year").selectOption("Junior");
  await page.getByRole("button", { name: /Join club|Send application/ }).click();
  await expect(page.locator("#join-error")).toContainText("name@bu.edu");               // school email only
  await page.getByLabel("School email").fill("test@bu.edu");
  await page.getByRole("button", { name: /Join club|Send application/ }).click();
  await expect(page.locator("#view")).toContainText(/You're a member|Application sent/);
  await expect(page.getByRole("button", { name: "Withdraw" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("about the data lists the datasets, their licences and how location is used", async ({ page }) => {
  await onboard(page);
  await page.getByRole("link", { name: "About the data" }).click();
  await expect(page.getByRole("heading", { name: "About the data" })).toBeVisible();
  for (const name of ["Crowdedness at the Campus Gym", "ROBOD", "NOVANIMAL", "COD"]) await expect(page.locator("#view")).toContainText(name);
  await expect(page.locator("#view")).not.toContainText("Chapel Hill");                 // evaluated, not used
  await expect(page.locator("#view")).toContainText("never stored or sent");
  await expect(page.getByRole("link", { name: "OpenStreetMap" })).toBeVisible();
});

test("no screen scrolls sideways, from a small phone to a laptop", async ({ page }) => {
  await onboard(page);
  for (const width of [320, 375, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    for (const hash of ["#/", "#/schedule", "#/explore", "#/place/mugar-synthetic", "#/club/example-1", "#/about", "#/answer"]) {
      await page.goto(`/${hash}`);
      await page.waitForTimeout(250);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      expect(over, `${hash} at ${width}px`).toBeLessThanOrEqual(1);
    }
  }
});
