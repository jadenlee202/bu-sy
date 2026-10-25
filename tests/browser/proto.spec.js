import { test, expect } from "@playwright/test";
import { browserErrors } from "./diagnostics.js";

// The minimal prototype (web/proto.html) on a fixed Monday 3 PM, Boston time.
const NOW = new Date("2026-10-26T15:00:00-04:00");
const ics = (events) => Buffer.from(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\n${events.map(([uid, title, start, end]) =>
  `BEGIN:VEVENT\r\nUID:${uid}\r\nDTSTAMP:20261001T000000Z\r\nSUMMARY:${title}\r\nDTSTART;TZID=America/New_York:${start}\r\nDTEND;TZID=America/New_York:${end}\r\nEND:VEVENT\r\n`).join("")}END:VCALENDAR\r\n`);

const MUGAR = { latitude: 42.351012, longitude: -71.107992 };
const HARVARD_SQ = { latitude: 42.3734, longitude: -71.1189 };     // ~2.3 km from West Campus: a long walk

async function onboard(page, { at = MUGAR } = {}) {
  if (at) { await page.context().grantPermissions(["geolocation"]); await page.context().setGeolocation(at); }
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
  // every open place shows a crowd badge with its word and how full it is; unverified hours show an
  // empty crowd and "No data", never "closed" and never a percentage
  const fitrec = page.locator("#results li", { hasText: "FitRec" }).locator(".busy-badge");
  await expect(fitrec.locator(".busy-icon")).toHaveAttribute("aria-label", /Busyness: (quiet|moderate|busy), simulated/);
  await expect(fitrec).toContainText(/(Quiet|Moderate|Busy)\s*\d+% full/);
  const fenway = page.locator("#results li", { hasText: "Fenway Dining" });
  await expect(fenway.locator(".busy-icon")).toHaveAttribute("data-level", "unknown");
  await expect(fenway.locator(".busy-icon g.on")).toHaveCount(0);
  await expect(fenway.locator(".busy-badge")).toHaveText("No data");
  // nothing in the prototype's lists leads back to the old UI
  await expect(page.locator('#results a[href^="index.html"]')).toHaveCount(0);
  await page.getByRole("tab", { name: "Clubs" }).click();
  await page.getByLabel("Search places and clubs").fill("run");
  await expect(page.locator("#results li:not([hidden])")).toHaveCount(1);
  await expect(page.locator("#results li:not([hidden])")).toContainText("Charles River Run Club");
  await expect(page.locator('#results a[href^="index.html"]')).toHaveCount(0);
});

test("a place page shows busyness now, today hour by hour, and the quietest time", async ({ page }) => {
  const errors = browserErrors(page);
  await onboard(page);
  await page.locator('.tabs a[data-tab="explore"]').click();
  await page.locator("#results a", { hasText: "Mugar Library" }).click();
  await expect(page).toHaveURL(/proto\.html#\/place\/mugar-synthetic$/);
  await expect(page.getByRole("heading", { name: "Mugar Library" })).toBeVisible();
  const now = page.locator(".busy-now .busy-badge");
  await expect(now).toHaveClass(/lg/);
  await expect(now).toContainText(/(Quiet|Moderate|Busy)\s*\d+% full/);
  await expect(page.locator(".busy-now")).toContainText(/About [\d,]+ people, against an illustrative capacity of 600/);
  // one column per open hour, the current hour marked, and an accessible summary of the day
  await expect(page.locator(".day-chart .col.now")).toHaveCount(1);
  await expect(page.locator(".day-chart")).toHaveAttribute("aria-label", /^Busyness today, simulated: .*3p (quiet|moderate|busy)/);
  await expect(page.locator(".quietest")).toContainText(/Quietest (later today|from now)/);
  await page.locator(".back", { hasText: "Explore" }).click();
  await expect(page.getByRole("tab", { name: "Places" })).toHaveAttribute("aria-selected", "true");

  // a place without verified hours today says so instead of charting a guess
  await page.locator("#results a", { hasText: "Fenway Dining" }).click();
  await expect(page.locator(".busy-now")).toContainText("No data");
  await expect(page.locator(".day-chart")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a club page is in the new UI: busy at meeting time, add a meeting, join", async ({ page }) => {
  const errors = browserErrors(page);
  await onboard(page);
  await page.locator('.tabs a[data-tab="explore"]').click();
  await page.getByRole("tab", { name: "Clubs" }).click();
  await page.locator("#results a", { hasText: "Charles River Run Club" }).click();
  await expect(page).toHaveURL(/proto\.html#\/club\/[^/]+$/);
  await expect(page.getByRole("heading", { name: "Charles River Run Club" })).toBeVisible();
  await expect(page.locator(".card", { hasText: "Busy at meeting time?" }).locator(".busy-badge")).toContainText(/Moderate\s*43% full/);

  // a weekly meeting goes on the shared schedule and comes off again
  const first = page.locator(".meetings li").first();
  await first.getByRole("button", { name: /^Add the meeting/ }).click();
  await expect(page.locator(".meetings [role=status]")).toContainText("to your schedule");
  await expect(page.locator(".meetings li").first().getByRole("button", { name: /^Remove the meeting/ })).toBeFocused();
  await page.locator('.tabs a[data-tab="schedule"]').click();
  await expect(page.getByRole("button", { name: /classes and clubs \(\d+\)/ })).toBeVisible();
  await page.goBack();
  await page.locator(".meetings li").first().getByRole("button", { name: /^Remove the meeting/ }).click();
  await expect(page.locator(".meetings [role=status]")).toContainText("from your schedule");

  // join: the same validation as the server, then a confirmation and the status on the club page
  await page.getByRole("link", { name: "Join", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Join" })).toBeVisible();
  await expect(page.locator("#full-note")).toBeHidden();
  await page.getByLabel("Full name").fill("Sample Student");
  await page.getByLabel("School email").fill("student@gmail.com");
  await page.getByLabel("Year").selectOption("Junior");
  await page.getByRole("button", { name: "Join club" }).click();
  await expect(page.locator(".form-error")).toHaveText("Use your school email (name@bu.edu).");
  await expect(page.getByLabel("School email")).toHaveAttribute("aria-invalid", "true");
  await page.getByLabel("School email").fill("student@bu.edu");
  await page.getByRole("button", { name: "Join club" }).click();
  await expect(page.getByRole("heading", { name: "You're in" })).toBeVisible();
  await page.getByRole("link", { name: "Back to the club" }).click();
  await expect(page.locator(".join-status")).toHaveText("You're a member");
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Withdraw" }).click();
  await expect(page.getByRole("link", { name: "Join", exact: true })).toBeVisible();
  await expect(page.locator('a[href^="index.html"]')).toHaveCount(0);
  expect(errors).toEqual([]);
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
