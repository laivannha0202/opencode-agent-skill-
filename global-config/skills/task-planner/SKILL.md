---
name: task-planner
description: Create an executable, file-aware plan for multi-file, architectural, ambiguous, migration, or risky coding work with acceptance criteria, dependencies, risks, and verification.
---

# Task Planner

Build the plan from repository evidence, not generic architecture guesses.

Include:
- required outcome and observable acceptance criteria
- relevant existing files, interfaces, and the nearest working analogue
- ordered implementation steps with real dependencies
- compatibility, migration, and rollback concerns where applicable
- explicit verification for each risky boundary
- user decisions or destructive actions that require approval

Keep steps small enough to verify but large enough to be meaningful. Separate required work from optional cleanup. Re-plan when new evidence invalidates an assumption rather than forcing execution through a stale plan.

For persistent long-horizon execution, emit a machine-checkable `PLAN.json` and read [plan-schema.md](references/plan-schema.md). Validate it with `ocskill task-graph` and an independent `ues-plan-checker` before any executor edits files.

