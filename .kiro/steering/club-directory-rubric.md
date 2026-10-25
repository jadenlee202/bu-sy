# Club Directory — Engineering Rules (derived from the judging rubric)

These rules translate the hackathon judging rubric into concrete, checkable
constraints for the BU-sy club-directory feature. They apply to all code in the
Meetup/clubs section (frontend `web/js/`, backend `server/`, data, and tests).
Each rule exists to move a rubric category toward the "Excellent" (5) column.

The guiding non-negotiables inherited from the existing project:
- Never present invented facts as real. Synthetic/demo data must be labeled.
- Reuse the existing design system, two-mode data adapter, and device-token
  identity. Do not bolt on a parallel framework or a real auth system the stack
  cannot secure.
- Modify the Meetup section; do not break unrelated features.

---

## 1. Idea Impact & Relevance (25%)

- **R1.1 — Solve a real student problem.** The feature must let a student
  discover clubs, see when they meet and whether they are accepting members,
  and sign up. Every screen must serve that path; cut anything that does not.
- **R1.2 — Honest value, no vaporware.** Do not advertise capabilities the code
  does not deliver (e.g. "we'll email the officer") unless that action truly
  happens. If an action is demo-only, say so in the UI.
- **R1.3 — Fit the audience.** Copy, categories, and fields must match a college
  club context (school email, student year, meeting days). No generic
  placeholder lorem.
- **R1.4 — Scope discipline.** Prefer finishing the browse → details → sign-up →
  my-clubs loop fully over adding half-working extras.

## 2. Data Science Application (25%)

- **R2.1 — Use the data already in the system.** Clubs must connect to the
  existing busyness/occupancy data where it is meaningful (e.g. show how busy a
  club's meeting location tends to be at its meeting time, using the existing
  `analytics` time-weighted logic — not a new ad-hoc calculation).
- **R2.2 — One real method, correctly applied.** Any derived number (e.g.
  "typically quiet at this time", capacity utilization, waitlist likelihood)
  must come from a named, testable function, not a magic constant inline in a
  template.
- **R2.3 — Evaluate and label.** Derived/estimated values must carry their basis
  and be labeled estimate vs. fact, reusing the existing provenance pattern
  (`busyness_basis`, `data_mode`, demo-threshold notes). Never imply precision
  the data does not support.
- **R2.4 — Reproducible.** Any data transformation lives in a module with a
  function and a unit test, so a reviewer can re-run it. No one-off numbers
  pasted into JSON by hand that a generator should produce.

## 3. Technical Implementation (20%)

- **R3.1 — Everything works, nothing is fake.** Every button, filter, search,
  and form must perform its real action and persist. No visual-only controls.
- **R3.2 — Persist through the existing adapter.** Clubs, applications,
  memberships, capacities, and waitlists persist via the two-mode adapter:
  FastAPI + JSON store in api mode, `localStorage` in static mode. Behavior must
  be identical in both modes.
- **R3.3 — Validate on both sides.** Validate inputs in the browser AND in the
  backend/local mirror (required fields, school email format, year, lengths).
  Never trust client input alone.
- **R3.4 — Safe concurrency and limits.** Enforce capacity, duplicate-signup
  prevention, and waitlist transitions atomically (reuse the server's
  thread-lock pattern; mirror it in the local store). A full club offers a
  waitlist, never an unbounded join.
- **R3.5 — Graceful failure.** Handle unavailable storage, network errors, 404s,
  and empty results with the existing loading/error/empty-state components.
  Never crash to a blank screen.
- **R3.6 — No regressions.** The existing facilities, playback, and events
  endpoints and screens must keep passing their tests. Run `python -m pytest`
  before declaring done.
- **R3.7 — Tests for new behavior.** Add tests covering create, sign-up,
  duplicate prevention, capacity/waitlist, approval flow, and permission gating.

## 4. Design (10%)

- **R4.1 — Consistent with BU-sy.** Reuse existing CSS variables, the BU-red
  palette, typography, card/list/button classes, and hash routing. No new
  design language or UI library.
- **R4.2 — Clear hierarchy.** Club cards show name, category, schedule, and a
  prominent status badge and primary action. Availability is never conveyed by
  color alone (pair every status color with a word, matching the busyness meter
  rule).
- **R4.3 — Responsive.** Usable on mobile, tablet, desktop. Labels and status
  stay visible on small screens.
- **R4.4 — Accessible.** Semantic elements, labeled form fields, keyboard
  operability, visible focus, `aria-live` for async regions, and readable
  contrast. Modals/panels trap focus and close on Escape.
- **R4.5 — States and feedback.** Provide loading indicators, inline validation
  errors, and explicit success confirmations that say what happens next.

## 5. Responsibility & Ethics (10%)

- **R5.1 — Minimize personal data.** Collect only what sign-up needs (name,
  school email, year; the rest optional). Do not collect sensitive categories.
- **R5.2 — Protect private data.** A student must not see other students'
  applications or contact details. Rosters and application details are visible
  only to the club's organizer.
- **R5.3 — Honest permissions.** Organizer/admin gating reuses the existing
  host-token model and must be clearly labeled as demo-grade, NOT real
  authentication. Do not claim security the stack cannot provide.
- **R5.4 — No secrets in the frontend.** No API keys, tokens, or credentials in
  client code or committed files. Device/organizer tokens are random, local, and
  never another user's identity.
- **R5.5 — Truthful labeling.** Demo/sample clubs and any synthetic numbers are
  labeled as such. Never relabel demo data as official BU data. The app stays
  "not affiliated with Boston University."
- **R5.6 — Consent and reversibility.** Students can withdraw an application or
  cancel a membership with confirmation. State clearly that submitted info is
  stored (and, in static mode, stored only on their device).

## 6. Presentation (10%)

- **R6.1 — Self-explanatory UI.** A first-time user understands each screen
  without a tour. Hints explain demo-mode and data provenance in plain language.
- **R6.2 — Demoable happy path.** The browse → details → sign-up → my-clubs →
  organizer-review loop can be shown end to end without console tricks or manual
  data edits.
- **R6.3 — Documented handoff.** The PR/summary lists files changed, features,
  data-store changes, storage keys, and any remaining gaps or setup steps.
- **R6.4 — Readable code.** Clear names, short functions, comments only where
  intent is non-obvious, consistent with the existing file style.

---

## Definition of Done (checklist)

- [ ] Browse, search, and category/day/availability filters all work and persist.
- [ ] Club details view/modal shows full info; missing info shows "TBD" / "Not
      specified", never invented.
- [ ] Sign-up form validates client- and server-side; duplicates prevented;
      capacity enforced; waitlist offered when full; approval flow marks pending.
- [ ] "My Clubs" shows status and allows withdraw/cancel with confirmation.
- [ ] Organizer view gated by token; students cannot edit clubs or read others'
      applications.
- [ ] Any derived data point comes from a tested function and is labeled.
- [ ] `python -m pytest` passes, including new tests; no regressions.
- [ ] Works in both api and static modes; graceful on storage/network failure.
- [ ] No secrets committed; demo/sample data labeled; not-affiliated notice kept.
