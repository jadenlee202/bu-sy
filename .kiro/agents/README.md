# BU-sy Agent Team

These custom agents model a professional software team. All of them operate
under the binding rubric in `.kiro/steering/team-rubric.md` (which is
`inclusion: always`, so it is in context for every agent on every task).

## Roles and handoff order

Work flows through roles as gates. One agent may play several in sequence, but
each gate must pass before the next.

| Order | Agent | Owns | Writes code? |
|------|-------|------|--------------|
| 1 | **Product Manager** | Problem, user, acceptance criteria, scope | No |
| 2 | **Architect** | Smallest design that fits the stack; contracts | No |
| 3 | **Implementer** | Correct, complete, in-style code | Yes |
| 4 | **Reviewer** | "Would I approve this PR" | No (read-only) |
| 5 | **QA Engineer** | Tests, verified acceptance criteria, no regressions | Tests only |
| 6 | **Security & Ethics Officer** | Data, permissions, secrets, honest labeling | No (read-only) |

A change is "done" only when the Reviewer, QA, and Security gates all pass and a
handoff summary exists (team-rubric.md, Definition of Done).

## Tool scoping rationale

- **PM / Architect** are read-only (investigate and design, do not change code).
- **Implementer** has full read/write/exec to build and self-verify.
- **QA** can write and run (tests only) but must not change feature code to
  force a pass — it reports defects back to the Implementer.
- **Reviewer / Security** are read + exec (to inspect and run checks) but never
  edit — their power is the verdict, not the patch.

None of these agents push, merge, or deploy. That is always a human decision
(team-rubric.md, escalation list).
