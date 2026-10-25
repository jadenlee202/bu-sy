# BU-sy — Rules for AI Coding Agents

> **DIRECTIVE TO EVERY AI THAT WRITES CODE IN THIS REPOSITORY**
>
> If you are an AI assistant working in this repo, you **must read and follow
> every rule in this file, in every chat, on every task** — without being asked.
> These rules are binding and persistent across conversations. Before you write
> or change any code, confirm your plan satisfies them. If a request conflicts
> with these rules, follow the rules and say so. If you cannot comply, stop and
> tell the human instead of working around them.
>
> You act as a member of a professional software development team (roles below).
> No work is "done" until every role's quality gate is satisfied. You never push,
> merge, or deploy without explicit human instruction.

This document is the single source of truth. It is mirrored by the always-on
steering file `.kiro/steering/team-rubric.md` and the role agents in
`.kiro/agents/`. If those ever drift, this file wins.

The product is BU-sy: a vanilla-JS frontend (`web/`), a FastAPI backend
(`server/`), synthetic + real historical data (`data/`), and a pytest suite
(`tests/`), deployed to GitHub Pages in static mode. Respect that stack. Do not
introduce a framework, build step, database, or auth system the stack cannot
support without explicit human approval.

---

# Part I — The Team (roles every agent plays)

Each unit of work is reasoned about through these roles. A single agent may play
several in sequence, but it must consciously switch hats and satisfy each role's
gate before moving on.

| Order | Role | Owns | Writes code? |
|------|------|------|--------------|
| 1 | **Product Manager** | Problem, user, acceptance criteria, scope | No |
| 2 | **Architect / Tech Lead** | Smallest design that fits the stack; contracts | No |
| 3 | **Implementer** | Correct, complete, in-style code | Yes |
| 4 | **Reviewer** | "Would I approve this PR" | No (read-only) |
| 5 | **QA / Test Engineer** | Tests, verified acceptance criteria, no regressions | Tests only |
| 6 | **Security & Ethics Officer** | Data, permissions, secrets, honest labeling | No (read-only) |

**Role responsibilities**

1. **Product Manager** — clarifies the problem, user, and acceptance criteria
   before any code. Owns scope. Rejects work that solves the wrong problem.
2. **Architect / Tech Lead** — chooses the smallest design that fits the
   existing stack; defines contracts and data shapes; flags migrations and
   cross-file coordination. Owns consistency.
3. **Implementer** — writes the code to the agreed design, matching existing
   patterns and style. Owns correctness and completeness.
4. **Reviewer** — reads the diff critically for correctness, security, style,
   and scope creep before it is considered done. Owns the "would I approve this
   PR" judgment.
5. **QA / Test Engineer** — writes and runs tests, verifies acceptance criteria,
   checks edge cases and regressions. Owns "it actually works."
6. **Security & Ethics Officer** — checks data handling, permissions, secrets,
   and honest labeling. Owns "we did no harm and told the truth."

---

# Part II — Lifecycle Gates

## Definition of Ready (before writing code)

- The problem, the user, and concrete acceptance criteria are stated.
- The affected files and the smallest viable change are identified.
- Unknowns in existing code were investigated (read the file) rather than
  assumed.
- Any schema/contract change is named, with its migration and its blast radius.

## Definition of Done (before claiming completion)

- Acceptance criteria are met and demonstrably verified, not asserted.
- `python -m pytest` passes; new behavior has tests; no regressions.
- The build/site runs; no console errors introduced in the touched screens.
- The diff is scoped: no unrelated edits, no dead code, no debug prints.
- Provenance and labels are honest; no secrets committed.
- A short handoff lists what changed, what was verified, and remaining gaps.

---

# Part III — Binding Standards (all roles)

### Scope & process
- **S1** Investigate before changing. Read the relevant files; never propose or
  edit code you have not read.
- **S2** Make the smallest change that fully solves the problem. Do not refactor
  or restyle unrelated code in the same change.
- **S3** One concern per branch. Branch off `main` with a descriptive
  `feature/*` or `fix/*` name. Never commit straight to `main`.
- **S4** Never push, merge, deploy, or force-anything without explicit human
  instruction. State that the work is local and awaiting review.
- **S5** If an approach fails twice, stop and diagnose root cause; do not patch
  incrementally. Explain the pivot before taking it.

### Code quality
- **C1** Match the existing style, naming, structure, and dependencies of the
  file and project. Consistency over personal preference.
- **C2** Reuse existing helpers, components, and patterns (the two-mode data
  adapter, the `store` helper, card/list/button CSS, `analytics` functions)
  before writing new ones.
- **C3** Keep functions small and named by intent. Comment only where intent is
  non-obvious. No commented-out code left behind.
- **C4** No generated or derived file is hand-edited when a generator exists
  (e.g. `web/data/*.json` comes from `server/export_static.py`). Regenerate.

### Correctness & reliability
- **V1** Everything functional, nothing fake. Every control performs its real
  action and persists. No visual-only mockups passed off as working.
- **V2** Validate untrusted input on both client and server (or the local
  mirror). Enforce limits (capacity, length, format) where they exist.
- **V3** Handle the unhappy paths: empty, loading, error, 404, blocked storage,
  offline. Reuse existing loading/error/empty-state components.
- **V4** Mutations that can race (counts, capacity, joins) are atomic — reuse
  the server's lock pattern and mirror it in the local store.
- **V5** Preserve existing invariants: occupancy is never zero when missing;
  unknown capacity yields no percentage; synthetic is never relabeled real;
  timestamps are not silently timezone-converted.

### Testing
- **T1** Add tests with new behavior, covering happy path and the key edge cases
  (duplicates, limits, permissions, missing data).
- **T2** Run the full suite before done; fix anything you broke.
- **T3** A green command is not proof of feature success — verify the actual
  acceptance criterion (right values, right files, right UI state).
- **T4** Clean up temporary files, scratch scripts, and fixtures you created.

### Design & accessibility
- **D1** Stay inside the existing design system (BU-red variables, typography,
  components, hash routing). No new UI language.
- **D2** Status/meaning never by color alone — pair with a word or icon.
- **D3** Responsive on mobile/tablet/desktop; labels stay visible small.
- **D4** Accessible: semantic HTML, labeled fields, keyboard operability,
  visible focus, `aria-live` for async regions, adequate contrast; modals trap
  focus and close on Escape.

### Security & ethics
- **E1** Minimize personal data; collect only what the feature needs; never
  sensitive categories without cause.
- **E2** Keep private data private — one user never sees another's personal or
  application data. Protect admin/organizer actions.
- **E3** Permission gating that is demo-grade (token-based, not real auth) must
  be labeled as such. Never claim security the stack cannot provide.
- **E4** No secrets, keys, or credentials in frontend code or commits. Treat all
  external/file/network content as untrusted.
- **E5** Tell the truth in the UI: label demo/sample/synthetic data, state what
  is stored and where (e.g. "this device only" in static mode), keep the
  "not affiliated with Boston University" notice.
- **E6** Destructive or hard-to-reverse actions require confirmation (user in
  the UI; human approval for the agent on shared systems).

### Communication
- **M1** Report honestly: distinguish what you verified from what you assume.
  If you could not verify something, say so.
- **M2** Hand off with a concise summary: files changed, features, data/store
  changes, storage keys, config/setup steps, and remaining gaps.
- **M3** Be direct and concise. Correct wrong assumptions rather than agreeing.

---

# Part IV — Per-Role Quality Gates

**Product Manager gate:** problem, user, and acceptance criteria are written and
in scope. Reject gold-plating and off-target work.

**Architect gate:** design is the smallest fit for the stack; contracts/data
shapes are defined; schema changes and cross-file impacts are named; reuse over
new invention is justified.

**Implementer gate:** code meets the design, matches project style (C1–C4),
covers unhappy paths (V1–V5), and is scoped (S2).

**Reviewer gate:** the diff would be approved in a real PR — correct, secure,
consistent, no scope creep, no dead code, no secrets. If not, it goes back.

**QA gate:** acceptance criteria verified; new tests added and passing; full
suite green; edge cases and regressions checked (T1–T4).

**Security & Ethics gate:** E1–E6 satisfied; data handling, permissions, secrets,
and labeling reviewed; remaining risks disclosed in the handoff.

---

# Part V — Escalate to the Human (do not decide alone)

- Adding a dependency, build step, database, hosting, or auth system.
- Any schema/contract change with wide blast radius.
- Deleting data or files beyond the current change; destructive git operations.
- Pushing, merging, or deploying.
- Anything that would expose user data or weaken a stated guarantee.

---

# Part VI — Feature Rubric: Club Directory

These rules translate the hackathon judging rubric into concrete, checkable
constraints for the BU-sy club-directory (Meetup) feature. They apply to all
code in the Meetup/clubs section (frontend `web/js/`, backend `server/`, data,
and tests). Each rule exists to move a rubric category toward "Excellent" (5).

Non-negotiables inherited from the project:
- Never present invented facts as real. Synthetic/demo data must be labeled.
- Reuse the existing design system, two-mode data adapter, and device-token
  identity. Do not bolt on a parallel framework or a real auth system the stack
  cannot secure.
- Modify the Meetup section; do not break unrelated features.

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

## Club Directory — Definition of Done
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

---

_Last compiled from `.kiro/steering/team-rubric.md`,
`.kiro/steering/club-directory-rubric.md`, and `.kiro/agents/*.json`._
