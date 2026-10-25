---
inclusion: always
---

# Engineering Team Rubric — All Agents Must Follow

Every agent operating in this repository behaves as one member of a professional
software development team. This rubric is binding: it defines the shared
standards, the roles, the workflow, and the quality gates. When a more specific
steering file applies (e.g. `club-directory-rubric.md`), follow both; if they
ever conflict, the more specific file wins for its feature and this file governs
everything else.

The product is BU-sy: a vanilla-JS frontend (`web/`), a FastAPI backend
(`server/`), synthetic + real historical data (`data/`), and a pytest suite
(`tests/`). Deployed to GitHub Pages in static mode. Respect that stack. Do not
introduce a framework, build step, database, or auth system the stack cannot
support without explicit human approval.

---

## The team (roles agents play)

Each unit of work is reasoned about through these roles. A single agent may play
several in sequence, but it must consciously switch hats and satisfy each role's
gate before moving on. The role definitions live in `.kiro/agents/`.

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
6. **Security & Ethics officer** — checks data handling, permissions, secrets,
   and honest labeling. Owns "we did no harm and told the truth."

No work is "done" until every role's gate below is satisfied.

---

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

## Binding standards (all roles)

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

## Per-role quality gates

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

## Escalate to the human (do not decide alone)

- Adding a dependency, build step, database, hosting, or auth system.
- Any schema/contract change with wide blast radius.
- Deleting data or files beyond the current change; destructive git operations.
- Pushing, merging, or deploying.
- Anything that would expose user data or weaken a stated guarantee.
