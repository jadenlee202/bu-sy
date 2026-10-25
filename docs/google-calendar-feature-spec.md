# BU-sy Feature: Google Calendar Integration and Personal Availability

Website: https://jadenlee202.github.io/bu-sy/#/places
Repository: the BU-sy repo in the current working directory.

Goal: help BU students find real free-time windows in their Google Calendar and match them to campus
locations that are open and, for dining halls, serving the right meal. The integration must be secure,
privacy-conscious, honest about its data, and compatible with the existing site.

## 0. Start from what already exists (do this first)

Part of this feature is already in the repo. **Audit and extend it. Do not build a second, parallel
implementation.** Before writing code, read and summarize:

- `server/google_calendar.py`: FastAPI router at `/api/calendar/*`. It handles the server-side OAuth flow
  with PKCE and `state`, uses the `calendar.freebusy` scope, keeps Fernet-encrypted tokens in SQLite behind
  an HttpOnly session cookie, makes FreeBusy queries against the `primary` calendar, and revokes on disconnect.
- `server/main.py`: where the router is mounted, the `/api/calendar/` no-cache middleware, and the
  access-log redaction of OAuth callback query strings.
- `web/js/calendar.js`: the `#/calendar` view. It covers connect/disconnect, the date picker, the minimum
  duration (15/30/45/60), the timezone field, and the "static site / not configured" state.
- `web/js/availability.js`: `zonedInstant`, `normalizeBusy`, `freeWindows`, `matchFreeWindows`.
- `web/js/hours.js` and `web/data/hours.json`: the **only** source of truth for verified building hours
  (`buildingHours`) and meal service (`serviceHours`: Breakfast, Brunch, Lunch, Dinner, Continental
  breakfast, Light lunch, Light dinner). Each schedule has `status`, `effectiveFrom` and `effectiveThrough`,
  `specialHours`, and a campus timezone of `America/New_York`.
- `web/data/campus.json`: holds **illustrative** planner hours and **sample, unrouted** walking times
  (`travel_basis: "Sample walking time"`). It must never be used as verified hours.
- `web/js/app.js` (Places list, `#/place/:id` detail, slider time) and `web/js/plan.js` (the planner, which
  already asks for a start location and a next location).
- Tests: `tests/availability.test.mjs`, `tests/test_google_calendar.py`, and the CI in `.github/workflows/tests.yml`.
- `README.md`, `DEMO.md`, and `.gitignore`. Check that `.env*` and the session database are already ignored.

Then list what is already done, what is missing, and any bugs or security gaps you find. Get my
confirmation on that list before you start large changes.

## 1. Architecture and hosting (the decision that blocks everything else)

The public site is a **static GitHub Pages deploy of `web/`**. GitHub Pages can't hold a client secret or
refresh tokens, so the Calendar feature only works when the FastAPI server is reachable.

- Keep the existing **server-side authorization-code flow with PKCE** (confidential web client). Do not
  switch to a browser-only token flow (implicit / Google Identity Services token client). That would put
  access tokens in page JavaScript.
- Pick and document one deployment option:
  - **(A) Same origin (recommended):** the FastAPI server serves `web/` and `/api/*` from one domain.
    The first-party cookie keeps working in browsers that block third-party cookies (Safari ITP, Chrome).
  - **(B) Split origin:** GitHub Pages frontend plus an API on another domain. This needs
    `SameSite=None; Secure` cookies, CORS limited to the exact Pages origin with credentials, and an
    `Origin` check on state-changing requests. Document that third-party cookie blocking can break it,
    and show a clear message when that happens.
- How the static frontend finds the API URL must be explicit configuration, not a guess.
- When no API is configured or reachable, the Calendar UI shows an honest "not available on this
  deployment" state. Every existing feature keeps working unchanged.

## 2. Google Cloud and OAuth configuration (document it, never commit secrets)

Document step by step, in the README:

- Create a Google Cloud project, enable the **Google Calendar API**, and create an **OAuth client ID of
  type "Web application"**.
- Authorized redirect URI(s): the exact `GOOGLE_REDIRECT_URI` for local development and production.
- OAuth consent screen: app name, support email, **privacy policy URL**, authorized domains, and the
  `https://www.googleapis.com/auth/calendar.freebusy` scope.
- Publishing status: while the app is in **Testing**, only listed test users can connect, and Google
  **expires refresh tokens after 7 days**. The app must handle that as a normal "please reconnect" state.
  Going to production may require Google's verification for the scope. Explain this; don't claim it is done.
- **BU accounts:** a Google Workspace admin can block third-party apps or specific scopes. Detect the
  resulting `admin_policy_enforced`, `access_denied` or `org_internal` errors and explain them in plain
  language, for example "Your BU account may not allow this app."
- Environment variables: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`,
  `CALENDAR_FRONTEND_ORIGIN`, `CALENDAR_FRONTEND_URL`, `CALENDAR_TOKEN_ENCRYPTION_KEY` (with how to
  generate a Fernet key), and `CALENDAR_SESSION_DB`. Add a `.env.example` with placeholders only.
- Comply with the **Google API Services User Data Policy (Limited Use)**.

References:
- OAuth 2.0 for web server apps: https://developers.google.com/identity/protocols/oauth2/web-server
- Calendar API scopes: https://developers.google.com/workspace/calendar/api/auth
- Calendar API overview: https://developers.google.com/workspace/calendar/api/guides/overview
- FreeBusy query: https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query
- User Data Policy: https://developers.google.com/terms/api-services-user-data-policy

## 3. Connect and disconnect

- A clearly visible **Connect Google Calendar** entry point on the Calendar page, plus a compact
  status/entry point on Places and on location detail pages.
- Before redirecting to Google, explain what is accessed (free/busy times only, primary calendar), what is
  not (titles, descriptions, attendees, locations), where it is stored, and how to revoke it. Include a
  **Cancel** button that sends no request.
- Handle these outcomes on return: success, user denied, user closed Google's page or came back without
  finishing (a pending session must expire), state mismatch, admin-blocked, and server misconfigured.
- Show a clear connected or disconnected status. **Disconnect** deletes the local session and revokes the
  Google token. If revocation fails, the local session is still deleted and the user is told to remove
  access at https://myaccount.google.com/permissions.
- Refresh expired access tokens on the server. Treat `invalid_grant` (revoked, expired, or the 7-day
  testing limit) as "disconnected, please reconnect", not as a generic error.
- Never simulate a connection or show fabricated events or busy blocks, including in demo mode. The
  empty default calendar in section 6a is allowed because it shows no events and is clearly marked
  "not connected."

## 4. Security and privacy

- No client secret, access token or refresh token in frontend code, URLs, `localStorage`, logs, error
  messages, or the repo. Tokens stay encrypted at rest. The session cookie is HttpOnly, Secure (in
  production) and SameSite.
- Use the narrowest scope: `calendar.freebusy`. Do not request `calendar.readonly` or
  `calendar.events.readonly`. Any future scope (for example, listing calendars) must be a separate,
  explicit, opt-in step.
- Do not store busy intervals on the server beyond the request. Do not log busy times, dates queried,
  or Google response bodies.
- Rate-limit `/api/calendar/*` per session to protect the Google quota.
- Keep the CSRF protections (state, PKCE, and an Origin check on POST).
- Add a short "Calendar privacy" section to the About page and a privacy policy page whose URL can be used
  on the consent screen. It must state that calendar data is never sold, shared, sent to an AI service,
  or used for anything else.

## 5. Retrieving availability (FreeBusy semantics)

- Query FreeBusy for the selected day in the **user's timezone**, with `timeMin` and `timeMax` computed
  as DST-aware instants. The `freebusy` scope cannot read the calendar's timezone setting, so default to
  the browser timezone, let the user change it (this already exists), and say this in the UI.
- Compare against campus hours in `America/New_York`, and show times in the user's timezone with a
  timezone label when the two differ.
- Calendars: the `calendar.freebusy` scope with `primary` covers the user's main calendar. Supporting
  other calendars would need an additional scope to list them. Either leave this out and say so in the
  UI, or add it as a separate opt-in. Don't claim multi-calendar support without it.
- Know what FreeBusy reports: events marked **"Free"** (transparency), **declined** events, and
  most **all-day** events don't appear as busy. Say this in the UI, for example: "Events marked 'free' in
  Google Calendar aren't counted."
- Handle **per-calendar `errors`** in the FreeBusy response as a failure. **Never show a calendar error
  as "you're free all day."**
- Handle 401 (refresh, then reconnect), 403 `rateLimitExceeded` or `usageLimits`, 429, and 5xx with
  bounded exponential backoff, plus a user-facing **Retry**.
- Re-fetch when the date or timezone changes, cancel or ignore stale responses, and avoid duplicate
  requests (a short in-memory cache per session and date is fine; don't persist it).
- A date range (for example, the next 7 days for "next opportunity") is allowed only within FreeBusy's
  range limits. Make it a single batched request, not one per day.

## 6. Daily schedule view (`#/calendar`)

- Header: "Your Tuesday schedule" plus the date. Previous/next day buttons and a date picker.
- A timeline (or list on narrow screens) with clearly distinct **Busy** and **Available** blocks. Don't
  rely on color alone; use a text label or pattern too.
- Only consider time inside the user's **preferred availability window** (default 8:00 AM–10:00 PM,
  editable). Time outside it is not shown as useful availability.
- A minimum free-time selector (15 / 30 / 45 / 60 min). Show the total free time that meets the minimum.
- For today, ignore time that has already passed ("free from now until…").
- States: loading, not configured / no API, disconnected, permission denied, admin-blocked, reconnect
  needed, rate-limited, error with Retry, and empty calendar ("No busy events: you're free all day within
  your window").
- Save the user's preferences (window, minimum duration, timezone) in `localStorage` only, and wrap
  storage access in try/catch.
- Accessible: keyboard operable, visible focus, `aria-live` for status changes, readable at 320px width.

### 6a. Default calendar when Google Calendar isn't connected

When the user hasn't connected Google Calendar, or the API isn't available on this deployment, still
show the schedule view as an **empty default calendar** instead of hiding it:

- Show the same day timeline, date navigation, preferred-window and minimum-duration controls, with
  **no events at all**. Don't add sample, placeholder or previously cached events.
- Never reuse busy data from an earlier connected session. After disconnecting, the view returns to the
  empty default calendar right away.
- Put a clear banner on it: "Google Calendar not connected · no events shown," with the **Connect
  Google Calendar** button (or the "not available on this deployment" message when there's no API).
- Don't label the empty day as "Available" or "You're free all day." BU-sy doesn't know the user's
  schedule, so the timeline shows the preferred window as unknown or neutral, not as free time.
- Campus information that doesn't depend on the calendar still works on the empty calendar, for
  example which places are open and which meals are served on the selected date. Phrase it as "open
  during these hours," not as a personal recommendation.
- After the user connects, the same view fills in with their real busy and free blocks with no page reload.

## 7. Matching free time to campus locations

Add **"Find a time to eat"** for dining halls and **"Find free time here"** for any location, on the location
detail page (`#/place/:id`). Optionally add a calendar-aware option to the planner.

- Use the location's existing `facility_id` and `hours.json`. No duplicated location or hours records.
- A recommendation needs:
  free window ∩ preferred window ∩ verified building hours (∩ the chosen meal period, for dining)
  to last **at least the minimum duration**, and the visit must **end before the building closes and before the meal service ends**.
- Respect `status`, `effectiveFrom`, `effectiveThrough` and `specialHours`. If hours are **unverified,
  unpublished, or the date is outside the published schedule, don't recommend**. Say why instead.
- "Next opportunity" searches forward from now (today, then the next days up to a limit), not just the selected day.
- Example output (illustrative only; real values must come from the user's calendar and `hours.json`):
  > **Your next opportunity to eat** · 12:15 PM–12:55 PM · 40 minutes free · Marciano Commons is open and
  > serving Lunch (11:00 AM–2:30 PM).
- **Travel time:** the walking times in `campus.json` are unrouted samples, and FreeBusy doesn't
  reveal where the user is before or after a gap. So by default **don't subtract or display travel
  time**; say "Travel time not included." Travel can be subtracted only if (a) the user picks where
  they're coming from and going to, as the planner already does, and (b) a reliable routing source is
  integrated. If sample times are used for the demo, label them "sample" as the planner does, and never
  present them as estimates.
- Not connected: "Find a time to eat" shows the location's open and meal hours for the date on the empty
  default calendar (section 6a). It invites the user to connect for personal recommendations and makes
  no claim that the user is free.
- No match: explain which constraint failed (no free window long enough, closed, meal not served,
  hours unverified) and offer controls to change the minimum duration, preferred hours, date, meal, or location.

## 8. Places page filters

Optional filters that only appear when they can work:

- Without a calendar: **Open now**, **Open on a selected date or time** (these should reuse the existing
  slider and status logic, so check whether they already exist before adding them).
- With a calendar connected: **Open during my free time**, **Serving breakfast / lunch / dinner during my
  free time**, and **Free for at least 15 / 30 / 45 / 60 minutes**, all on the selected date.
- Turning calendar filters on must not hide places without explanation. Places with unverified hours
  show "hours unverified" instead of disappearing silently, and the historical reference datasets are
  never suggested.
- With no calendar connected, every existing Places feature (map, cards, weekly schedules, slider,
  filters, navigation) behaves exactly as it does today.

## 9. Availability calculation rules (pure, reusable, testable)

Keep these in `web/js/availability.js` (or a sibling module), with no DOM or network access:

1. Normalize busy intervals: parse, drop invalid ones, clip to the query window, sort, and merge overlapping
   **and adjacent** blocks.
2. Free intervals = gaps in the clipped window.
3. Intersect them with the preferred availability window, and with "now" for today.
4. Apply the minimum duration **after** every intersection.
5. Intersect with verified building hours, then with the chosen meal period, for dining.
6. Handle date boundaries: events crossing midnight, periods ending at `24:00`, and service hours that run
   past midnight, if the data has any.
7. Handle timezones: the user's timezone vs. `America/New_York`, and DST transition days (23- and
   25-hour days).
8. Travel time is a separate, optional input: subtract it from both ends of a window only when provided.
9. Keep calendar availability, building hours, meal-service hours and travel time as separate inputs and outputs.
10. Return results with no double-counting, ordered by start time.

## 10. Tests

All tests use mocked Google responses. None need a real account or network access.

JS (`npm test`, Node 22+):
- Overlapping, nested and adjacent busy blocks; events crossing midnight; empty calendar.
- DST spring-forward and fall-back days (for example 2026-03-08 and 2026-11-01 in `America/New_York`),
  and a user timezone that differs from the campus timezone.
- Preferred window clipping; "today" clipping to now; minimum-duration filtering applied after intersections.
- Matching against building hours, each meal period, `specialHours` closures, and dates outside
  `effectiveFrom`–`effectiveThrough`.
- A visit can't run past closing or the end of a meal; unverified hours give no recommendation; no
  matching window found.
- UI state mapping: not configured, disconnected, reconnect needed, rate-limited, error.
- Default calendar: when not connected, the view renders an empty timeline with zero events, no
  "Available" or "free all day" labels, and a connect banner. After disconnecting, earlier busy data
  is cleared and the empty default calendar is shown.

Python (`pytest`):
- PKCE, state, the minimum scope, and the redirect/return-URL allowlist.
- Denied access, abandoned flows, state mismatch, admin-policy errors.
- Expired access token → refresh; `invalid_grant` → session removed and reconnect state.
- FreeBusy 403 rate limit, 429, 5xx with backoff, and **per-calendar `errors` → failure, not empty**.
- Disconnect: local deletion plus revocation, and revocation failure still disconnects locally.
- Logs and error responses contain no tokens, codes or busy times.
- Per-session rate limiting on `/api/calendar/*`.

Run `npm test` and `pytest`, and make sure the GitHub Actions test workflow still passes.

## 11. Deliverables

Before coding: the audit from section 0, the chosen hosting option from section 1, and the configuration
from section 2.

After coding, report:
- A summary of the feature and every file changed or added.
- How connecting, token refresh and disconnecting work, end to end.
- OAuth, Google Cloud and deployment steps, and the environment variables (also in the README and `.env.example`).
- What needs backend hosting or credentials, and what works on plain GitHub Pages.
- The exact test and build commands you ran, with pass/fail results. Report failures honestly.
- Anything left for manual setup: the Cloud project, consent screen, verification, the BU Workspace admin
  approval, hosting, and the privacy policy URL.
- An update to `DEMO.md` so the demo still runs without Google credentials.
