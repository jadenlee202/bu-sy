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

  // the day map: classes as busy blocks, a suggestion in every free gap
  await expect(page.locator(".blk.is-busy")).toHaveCount(2);
  await expect(page.locator(".blk.is-busy").first()).toContainText("BI 108 Lab");
  await expect(page.locator(".blk.is-free").first()).toContainText(/at (Mugar Library|Marciano Commons|West Campus Dining|Warren Towers Dining|FitRec)/);
  await expect(page.locator(".now-line")).toHaveCount(1);

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

test("navigating faster than the page transitions raises no errors", async ({ page }) => {
  const errors = browserErrors(page);
  await onboard(page);
  for (const hash of ["#/explore", "#/place/mugar-synthetic", "#/club/example-1", "#/about", "#/schedule", "#/"]) {
    await page.evaluate((h) => { location.hash = h; }, hash);          // no waiting between them
  }
  await expect(page.locator(".sentence")).toBeVisible();
  await page.waitForTimeout(600);
  expect(errors).toEqual([]);
});


test("the week strip shows seven days; a later day's gaps get suggestions you can plan", async ({ page }) => {
  const errors = browserErrors(page);
  await onboard(page);
  await page.locator('.tabs a[data-tab="schedule"]').click();
  await page.locator("#ics").setInputFiles({ name: "week.ics", mimeType: "text/calendar", buffer: ics([
    ["m", "CS 111 Lecture", "20261026T160000", "20261026T171500"],
    ["t1", "PS 101 Lecture", "20261027T093000", "20261027T104500"],
    ["t2", "MA 123 Discussion", "20261027T140000", "20261027T150000"]]) });
  await expect(page.locator(".week .day")).toHaveCount(7);
  await expect(page.locator('.week .day[aria-pressed="true"]')).toContainText("Today");
  await page.getByRole("button", { name: "Use my location" }).click();
  await expect(page.locator(".blk.is-free").first()).toContainText("min walk");
  await page.locator('.week .day[data-day="2026-10-27"]').click();
  await expect(page.locator(".blk.is-busy")).toHaveCount(2);
  await expect(page.locator(".blk.is-busy").nth(0)).toContainText("PS 101 Lecture");
  await expect(page.locator(".now-line")).toHaveCount(0);                     // not today
  await expect(page.locator(".now-card")).toHaveCount(0);
  // 10:45 AM – 2 PM: lunch from 11, then study, both inside the gap
  const midday = page.locator(".blk.is-free").nth(1);
  await expect(midday.locator(".fill")).toHaveCount(2);
  await expect(midday.locator(".fill").nth(0)).toContainText("11:00 AM");
  await expect(midday.locator(".fill").nth(0)).toContainText("Lunch at");
  await expect(midday.locator(".fill").nth(0)).toContainText(/\b45 min\b/);   // one meal, not the whole gap
  await expect(midday.locator(".fill").nth(1)).toContainText("Study at");
  // 3 PM on: the run club meets 6–7 PM, so it's offered; adding it turns it into a busy block
  const evening = page.locator(".blk.is-free").nth(2);
  await expect(evening.locator(".fill.is-club")).toContainText("Charles River Run Club");
  await expect(evening.locator(".fill.is-club")).toContainText("6:00 PM – 7:00 PM");
  await expect(evening).toContainText("Dinner at");
  await evening.locator(".fill.is-club").getByRole("button", { name: "Add to calendar" }).click();
  await expect(page.locator(".blk.is-busy")).toHaveCount(3);
  await expect(page.locator(".blk.is-busy").nth(2)).toContainText("Charles River Run Club meeting");
  await expect(page.locator(".fill.is-club")).toHaveCount(0);
  await midday.locator(".fill").nth(1).getByRole("button", { name: "Plan this" }).click();
  await expect(page.locator(".place")).toBeVisible();
  await expect(page.locator(".steps")).toContainText("Study until");
  await page.getByRole("link", { name: "Change" }).click();
  await expect(page.locator(".chip.free")).toContainText("Planning Tue, Oct 27");
  await page.getByRole("button", { name: "Use now" }).click();
  await expect(page.locator(".chip.free")).not.toContainText("Planning");
  await expect(page.locator(".chip.free")).toContainText("Free until 4:00 PM");   // back to now: Monday 3 PM is free until CS 111
  expect(errors).toEqual([]);
});

test("every event on the calendar is busy, even one marked free; nothing is suggested over it", async ({ page }) => {
  const errors = browserErrors(page);
  await onboard(page);
  await page.locator('.tabs a[data-tab="schedule"]').click();
  const raw = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//EN",
    "BEGIN:VEVENT", "UID:a", "DTSTAMP:20261001T000000Z", "SUMMARY:Office hours", "TRANSP:TRANSPARENT",
    "DTSTART;TZID=America/New_York:20261027T120000", "DTEND;TZID=America/New_York:20261027T130000", "END:VEVENT",
    "BEGIN:VEVENT", "UID:b", "DTSTAMP:20261001T000000Z", "SUMMARY:Early lab",
    "DTSTART;TZID=America/New_York:20261027T070000", "DTEND;TZID=America/New_York:20261027T080000", "END:VEVENT",
    "BEGIN:VEVENT", "UID:c", "DTSTAMP:20261001T000000Z", "SUMMARY:Midterm week",
    "DTSTART;VALUE=DATE:20261027", "DTEND;VALUE=DATE:20261028", "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");
  await page.locator("#ics").setInputFiles({ name: "cal.ics", mimeType: "text/calendar", buffer: Buffer.from(raw) });
  await page.locator('.week .day[data-day="2026-10-27"]').click();
  await expect(page.locator(".allday")).toContainText("Midterm week");
  await expect(page.locator(".blk.is-busy")).toHaveCount(2);
  await expect(page.locator(".blk.is-busy").nth(0)).toContainText("Early lab");       // before 8 AM, still shown
  await expect(page.locator(".blk.is-busy").nth(1)).toContainText("Office hours");    // marked free in the file, busy here
  // no suggestion overlaps noon to 1 PM
  for (const when of await page.locator(".fill .when").allTextContents()) {
    const [a, b] = when.split(" – ").map((t) => { const [, h, m, ap] = t.match(/(\d+):(\d+) (AM|PM)/); return (Number(h) % 12 + (ap === "PM" ? 12 : 0)) * 60 + Number(m); });
    expect(b <= 12 * 60 || a >= 13 * 60, when).toBe(true);
  }
  expect(errors).toEqual([]);
});

test("you can add your own event or keep a suggestion; both are busy and can be removed", async ({ page }) => {
  const errors = browserErrors(page);
  await onboard(page);
  await page.locator('.tabs a[data-tab="schedule"]').click();
  await page.locator("#ics").setInputFiles({ name: "week.ics", mimeType: "text/calendar", buffer: ics([
    ["t1", "PS 101 Lecture", "20261027T093000", "20261027T104500"]]) });
  await page.locator('.week .day[data-day="2026-10-27"]').click();
  // your own event, from the header
  await page.getByRole("button", { name: "+ Add event" }).click();
  await page.getByLabel("Name").fill("Gym with Sam");
  await page.getByLabel("Starts").fill("16:00");
  await page.getByLabel("Ends").fill("15:00");
  await page.locator("#add-event").getByRole("button", { name: "Add to calendar" }).click();
  await expect(page.locator("#add-error")).toHaveText("The event has to end after it starts.");
  await page.getByLabel("Ends").fill("17:00");
  await page.locator("#add-event").getByRole("button", { name: "Add to calendar" }).click();
  await expect(page.locator("#add-event")).toHaveCount(0);
  const gym = page.locator(".blk.is-busy", { hasText: "Gym with Sam" });
  await expect(gym).toContainText("4:00 PM – 5:00 PM");
  await expect(gym).toContainText("added by you");
  await expect(page.locator(".blk.is-busy").first()).toContainText("PS 101 Lecture");       // the file's events stay
  // keep the lunch suggestion: it becomes a busy block and the gap re-fills around it
  const lunch = page.locator(".fill", { hasText: "Lunch at" });
  const title = (await lunch.locator(".title").textContent()).trim();
  await lunch.getByRole("button", { name: "Add to calendar" }).click();
  await expect(page.locator(".blk.is-busy", { hasText: title })).toBeVisible();
  await expect(page.locator(".fill", { hasText: "Lunch at" })).toHaveCount(0);
  // still there after a reload; removing one leaves the rest
  await page.reload();
  await page.locator('.week .day[data-day="2026-10-27"]').click();
  await expect(page.locator(".blk.is-busy")).toHaveCount(3);
  await page.locator(".blk.is-busy", { hasText: "Gym with Sam" }).getByRole("button", { name: "Remove" }).click();
  await expect(page.locator(".blk.is-busy")).toHaveCount(2);
  await expect(page.locator(".blk.is-busy", { hasText: "PS 101 Lecture" }).getByRole("button", { name: "Remove" })).toHaveCount(0);   // the file's events are the file's
  expect(errors).toEqual([]);
});
