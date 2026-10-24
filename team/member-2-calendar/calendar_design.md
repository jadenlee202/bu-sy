# BU-sy — Optional Calendar Integration (Member 2 preparation)

## 0. Status: what works vs. what doesn't exist

| Piece | State |
|---|---|
| Interval math (merge, clip, min-duration gaps) — `src/availability.mjs` `computeFreeGaps` | **Working, local, tested** |
| Planning-window resolution with IANA zones + DST — `resolvePlanningWindows`, `src/time.mjs` | **Working, local, tested** |
| Provider-neutral snapshot (ok / partial / disconnected / error) — `buildSnapshot` | **Working, local, tested** |
| Manual windows → same snapshot shape — `fromManualWindows` | **Working, local, tested** |
| Google free/busy response → neutral shape — `normalizeGoogleFreeBusy` | **Offline only.** Tested against a *synthetic* body shaped like the public reference; never run against a live response |
| OAuth, token storage, HTTP calls to Google, UI, disconnect flow | **Not implemented.** Designed in §5 only |
| Access to BU student calendars | **Unknown / unverified.** Do not assume it works (§2.4) |

No credentials were created, no accounts were connected, no secrets were requested. All fixtures are synthetic (`.invalid` domains, invented times).

**Repository inspection** ([jadenlee202/bu-sy](https://github.com/jadenlee202/bu-sy), read only):

- **Stack:** a FastAPI backend in `server/` (Python, pytest) and a static ES-module frontend in `web/js/`. The `feature/what-fits-now` branch adds a planner engine (`web/js/recommend.js`), tested with `node --test` on Node 22. This prototype uses the same frontend language (**Node ES modules, zero dependencies**, built-in `node:test` and `Intl`), so it can be moved into `web/js/` later without a rewrite.
- **Planner input model** (`recommend.js` on `feature/what-fits-now`, being edited by another teammate and **not modified here**): a request holds `start: "HH:MM"`, `minutes` (5–720, must not run past midnight), and `source: "manual" | "calendar"`, alongside user-chosen `activity`, `from`, `to`, `buffer`, and preferences. Its own comment already says a calendar event never proves where the student is. `toPlannerWindows` (§5.1) produces exactly the time fields of that request and nothing else.

## 1. Files

```
team/member-2-calendar/
  calendar_design.md          this document
  package.json                no dependencies; scripts only
  demo.mjs                    prints a snapshot for a fixture
  src/time.mjs                RFC 3339 parsing, IANA offsets, DST-aware wall-time → instant
  src/availability.mjs        computeFreeGaps, resolvePlanningWindows, buildSnapshot,
                              fromManualWindows, toPlannerWindows, isStale, normalizeGoogleFreeBusy
  fixtures/snapshot-cases.json        9 table-driven cases with expected output
  fixtures/google-freebusy-partial.json  synthetic Google-shaped response with failures
  fixtures/manual-entries.json        manual windows equal to case 0's derived result
  test/availability.test.mjs  33 checks
```

**Run** (from `team/member-2-calendar/`):

```sh
npm test            # or: node --test test/*.test.mjs
node demo.mjs       # snapshot for case 0; `node demo.mjs 99` lists cases
```

To make sure the checks can fail, I broke the code on purpose four times: merging adjacent intervals, clipping, choosing the DST-ambiguous instant, and reporting partial status. Each break failed between 1 and 3 tests.

## 2. Research: minimal Google Calendar access

The official pages at developers.google.com refused direct fetches from this sandbox (HTTP 403). The points below come from excerpts of those official pages returned by search, linked inline. Re-read the linked pages before building on them. Content was rephrased for compliance with licensing restrictions.

### 2.1 What free/busy access provides

- [`freebusy.query`](https://developers.google.com/workspace/calendar/v3/reference/freebusy/query) returns free/busy information for a set of calendars. The request takes `timeMin`, `timeMax` (RFC 3339), an optional `timeZone` for the response (the default is UTC), and `items: [{id}]`. There are optional `groupExpansionMax` (max 100) and `calendarExpansionMax` limits.
- The response has one entry per requested calendar ID. Each entry holds a `busy` list of `{start, end}` and, if something went wrong, an `errors` list such as `{domain: "global", reason: "notFound"}`. **A failure is reported per calendar, inside a successful HTTP 200**, so partial failure is the normal case to handle. `normalizeGoogleFreeBusy` maps this.
- The minimal scope is [`https://www.googleapis.com/auth/calendar.freebusy`](https://developers.google.com/workspace/calendar/api/auth), described as viewing your availability in your calendars. Google advises picking a non-sensitive scope when one is enough ([OAuth scopes](https://developers.google.com/identity/protocols/oauth2/scopes)). Whether this exact scope counts as non-sensitive must be checked in the Cloud Console consent-screen configuration (verify).
- Calendar sharing has a matching ["free/busy reader" level](https://developers.google.com/workspace/calendar/api/concepts/sharing). It shows whether time is busy but not event details.

### 2.2 What it cannot provide

Free/busy returns **only time ranges**. It does not return:

- event titles, descriptions, purposes, or categories (it can't tell a class from a club or a meal);
- locations or rooms, so **no inference about where the student is**;
- attendees, organizers, or RSVP status, so **no inference about actual attendance**;
- anything about hunger, mood, or intent. Busy/free only says the calendar has a blocking entry.

Other limits:

- Events set to "Show as: Available" (`transparency: transparent`) do not block time, so they don't appear as busy ([discussion](https://discuss.google.dev/t/google-calendar-free-events-block-godaddy-bookings-despite-correct-free-busy-api-response/406503)). An empty calendar does not prove the person is free. Commitments missing from the calendar are invisible.
- Query ranges have a maximum length. A community answer reports about 3 months, subject to change ([Stack Overflow](https://stackoverflow.com/questions/32675016)). This isn't official, so verify it. Our horizon is capped at 14 days.
- Bad ranges return HTTP 400 (for example "time range is empty", per the [error guide](https://developers.google.com/workspace/calendar/api/guides/errors)).

### 2.3 Optional features that need broader permissions

| Feature | Needs (beyond `calendar.freebusy`) | Recommendation |
|---|---|---|
| Let the user choose which calendars count | calendar list read (e.g. `calendar.calendarlist.readonly`, verify name) | Later; v1 queries `primary` only |
| Travel time from the previous event's building | event locations → `calendar.events.readonly` / `calendar.readonly` | **Don't.** It reads private details and invites location inference |
| Skip "optional" events or treat classes differently | event titles/details → `calendar.events.readonly` | Don't. Let users adjust windows manually |
| Add a chosen activity to the user's calendar | write access (`calendar.events` or narrower event-owned scopes) | Separate, explicit opt-in feature |

Scopes that read details are generally sensitive or restricted. They trigger Google app verification and, for restricted scopes, possibly a security assessment ([App verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/overview)).

### 2.4 Account and administrator restrictions to verify before promising anything

1. **BU's calendar platform.** Confirm which system holds students' schedules (Google Workspace for BU, Microsoft 365, or the registrar's own system). **Don't assume BU student calendars are in Google or readable at all.**
2. **Workspace admin app controls.** Workspace admins can restrict which third-party apps reach Google data over OAuth, and unconfigured apps can be blocked by default until approved ([Admin help](https://support.google.com/a/answer/13152743), [access requests](https://support.google.com/a/answer/16484119)). BU IT may need to allow the app.
3. **Admin sharing settings.** Admins can limit external calendar sharing to free/busy only ([Admin help](https://support.google.com/a/answer/60765)). This matters only if we ever read calendars other than the user's own.
4. **OAuth publishing status.** In "Testing", only allow-listed test users can sign in (hard cap of 100) ([App verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/overview)), and their authorizations and refresh tokens expire after 7 days ([Cloud help](https://support.google.com/cloud/answer/15549945)). A class demo in Testing mode needs re-consent each week.
5. **"Internal" user type** works only for an app owned inside the same Workspace organization. A student-team project is probably "External".
6. **Personal Gmail accounts** will work technically, but they may not contain class schedules. That's another reason manual entry stays the primary path.

## 3. Availability adapter contract (`busy.availability/v1`)

Every source (manual, synthetic, or calendar) produces this one shape:

```ts
type AvailabilitySnapshot = {
  schema: "busy.availability/v1";
  source: {
    kind: "manual" | "synthetic" | "calendar";
    provider: string | null;            // "user_entry" | "fixture" | "google" | ...
    connection?: "connected" | "disconnected" | "revoked" | "not_configured";
  };
  retrievedAt: string;                  // RFC 3339 with offset; manual = when entered
  planning: {
    selectedDate: string;               // "YYYY-MM-DD", local to timeZone
    horizonDays: number;                // 1..14
    timeZone: string;                   // IANA, e.g. "America/New_York" (required)
    dailyStart: string; dailyEnd: string; // "HH:MM"; dailyEnd <= dailyStart ⇒ ends next day; "24:00" allowed
    minDurationMinutes: number;
  };
  status: "ok" | "partial" | "disconnected" | "error";
  requiresUserConfirmation?: boolean;   // true when partial
  freeWindows: Interval[];              // ← what recommendations consume
  busyIntervals: Interval[];            // merged + clipped; time-only; optional to show
  calendars: { ref: string; status: "ok" | "degraded" | "error"; errorReason?: string; invalidIntervals?: number }[];
  issues: { code: string; severity: "info" | "warning" | "error"; message: string }[];
};
type Interval = {
  start: string; end: string;           // RFC 3339, rendered in planning.timeZone
  timeZone: string; planningDate: string; durationMinutes: number;
};
```

`Interval` holds only time data, deliberately: no title, location, attendee, or intent fields. A test checks this, including when a provider leaks extra fields.

**Status semantics**

| status | meaning | main app should |
|---|---|---|
| `ok` | every queried calendar answered with valid data | use `freeWindows` |
| `partial` | some calendars failed or had invalid intervals; windows come from the rest | show windows **with a warning** and ask the user to confirm or edit before recommending |
| `disconnected` | connection is `disconnected`, `revoked`, or `not_configured` | ignore calendar; use manual entry (it is **not** "empty calendar") |
| `error` | bad request (zone, date, horizon) or every calendar failed | show error; use manual entry |

**Issue codes:** `invalid_time_zone`, `invalid_selected_date`, `invalid_horizon`, `invalid_daily_start`, `invalid_daily_end`, `invalid_min_duration`, `invalid_source`, `invalid_retrieved_at`, `invalid_interval`, `calendar_unavailable`, `no_calendars`, `source_disconnected`, `dst_ambiguous_used_earlier`, `dst_nonexistent_shifted_forward`.

## 4. Algorithm and rules

### 4.1 `computeFreeGaps(busy, window, minDurationMinutes)`
This is a pure function over epoch-ms, half-open `[start, end)` intervals. It clips each interval to the window, drops empty ones, sorts, merges **overlapping and adjacent** intervals (back-to-back events leave no gap), and returns the gaps that are at least `minDurationMinutes` long. It reads no clock, does no I/O, and doesn't mutate its inputs.

### 4.2 Time and validation rules
- Inputs must carry an explicit offset (`Z` or `±HH:MM`). Times with no offset, impossible dates (Feb 30), missing ends, or an end before the start are **rejected and reported**. The snapshot then becomes `partial`, because a missing busy block might hide a conflict. Zero-length intervals block nothing and are ignored.
- The planning window is built per local day in `planning.timeZone`, so a horizon that crosses a DST change keeps 09:00 meaning 09:00 local time. Days can be 23 or 25 hours long.
- DST edges of the daily window follow the RFC 5545 / Temporal "compatible" rule. An ambiguous time (fall-back) uses the earlier instant. A nonexistent time (spring-forward) moves forward by the size of the gap. Both cases emit an `info` issue.
- Output times are rendered in the planning zone, whatever offset the provider used.

### 4.3 Manual input is the reference path
`fromManualWindows({request, entries:[{date, start:"HH:MM", end:"HH:MM"}], enteredAt})` returns the same snapshot with `source.kind = "manual"`. Its windows are clipped to the same horizon and minimum duration. A test shows that manual entries and calendar-derived windows covering the same times produce **identical `freeWindows`**. Assumption: the main app's manual model is "local date + start/end time in one zone". If it differs, change only this function.

### 4.4 Explicitly out of scope
Availability is never used to guess location, hunger, intent, or whether someone will actually attend. A free window means only "no blocking entry was found on the calendars we could read".

## 5. Integration handoff

### 5.1 What the main app eventually consumes
1. On "plan my day", the app builds `request` (selected date, horizon, IANA zone, daily hours, minimum duration).
2. **Manual (default, always available):** `fromManualWindows(...)`.
   **Calendar (opt-in):** server calls Google → `normalizeGoogleFreeBusy` → `buildSnapshot(...)`.
3. `toPlannerWindows(snapshot)` turns the snapshot into `[{date, start: "HH:MM", minutes, source}]`. That is the time part of the planner request in `web/js/recommend.js`. The user picks one window, and the form fills in `start`, `minutes`, and `source`, while `activity`, `from`, `to`, `buffer`, and preferences stay user-chosen. The planner covers a single day, so windows are cut at local midnight and capped at 720 minutes, with a note explaining each cut. A `partial` snapshot sets `requiresUserConfirmation`. A `disconnected` or `error` snapshot is `usable: false`, and the form stays manual.
4. The recommender runs **through the same entry point either way** (`validateRequest` → `recommend`). `source` is for UI copy only and must not change ranking. A test confirms manual and calendar-derived windows produce identical planner fields.
5. Calendar snapshots older than 15 minutes (`isStale`) are fetched again before recommending. Manual snapshots don't go stale.
6. The user can always edit or override calendar-derived windows, and edits turn the snapshot into a manual one.

### 5.2 Credentials and configuration needed later (none created now)
- A Google Cloud project with the Calendar API enabled and an OAuth consent screen (External, Testing at first). Add test users, and expect the 7-day token expiry.
- An OAuth 2.0 **Web application** client using the server-side authorization-code flow. The client secret stays on the server and never reaches `web/`.
- Requested scope: `calendar.freebusy` only (plus `openid` if sign-in is needed). Request it incrementally, when the user clicks "Connect calendar", never at signup.
- Server config (names are suggestions): `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI`, `TOKEN_ENCRYPTION_KEY`, `CALENDAR_FEATURE_ENABLED=false` by default.
- BU IT confirmation for every item in §2.4 before presenting this as a BU feature.

### 5.3 Data retention (minimal)
- **Store:** the encrypted refresh token, connection status, the timestamp of the last successful fetch, and opaque calendar refs (`cal-a`), not email addresses.
- **Don't store:** busy intervals or snapshots beyond the request or the short 15-minute cache. Never store titles or locations; with this scope we don't receive them.
- **Don't log:** calendar IDs, tokens, or raw responses. Issue messages already echo only start/end values.

### 5.4 Disconnect and deletion
1. A "Disconnect calendar" control on the settings or planning screen.
2. The server revokes the token with Google (`POST https://oauth2.googleapis.com/revoke`, per [Google's OAuth guidance](https://developers.google.com/identity/protocols/oauth2/resources/best-practices), which says to revoke and delete tokens that are no longer needed). It then **deletes** the stored token, cached snapshots, and calendar refs, and sets `connection = "disconnected"`.
3. If Google returns `invalid_grant` (the user removed access at myaccount.google.com/permissions, or the Testing token expired), the server sets `connection = "revoked"`, deletes the token, and prompts the user to reconnect or continue manually.
4. Manual availability and recommendations keep working after disconnecting.
5. Account deletion runs steps 2–3 as well.

## 6. Open questions for the team
- What is the main app's exact manual-availability model (fields, zone handling)? Align `fromManualWindows` with it.
- Which calendar system do BU students actually use, and will BU IT allow a third-party OAuth app?
- Should a `partial` snapshot be offered at all, or should the app fall straight back to manual? The current design offers it with a confirmation step.
- What are the default daily hours and minimum gap? The prototype defaults to 00:00–24:00 and 30 minutes, and the fixtures use 09:00–17:00.
