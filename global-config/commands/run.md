---
description: Execute a complex or long-running engineering task with persistent state, plan validation, fresh-context task executors, dependency-safe waves, integration verification and resumability.
agent: build
---

Run this task using the UES long-horizon workflow: $ARGUMENTS

Treat this command as permission to create a repository-local `.ues-work/<slug>/` execution workspace for durable non-secret planning state.

Required workflow:
1. Inspect repository instructions and deterministic evidence with `ocskill inspect`, `ocskill repo-graph`, and targeted impact searches.
2. Create a concise SPEC with observable acceptance criteria.
3. Initialize persistent state with `ocskill work init`.
4. Produce a file-aware `PLAN.json` using the UES plan schema, then import it with `ocskill work plan`.
5. Dispatch `ues-plan-checker` in fresh context. Revise the plan until blocking findings are removed.
6. Use `ocskill task-graph` and execute only ready dependency-safe tasks. For each task, run `ocskill work start`, dispatch a fresh `ues-executor`, inspect its changes/evidence, then record completion with `ocskill work complete`. Independent tasks may run in parallel only when the safe-wave analysis and working-tree isolation make that safe.
7. On executor failure, record it with `ocskill work fail`, diagnose from fresh evidence, and escalate/re-plan rather than stacking patches.
8. After all tasks complete, dispatch `ues-integration-verifier`, then use reviewer/critic when risk warrants it.
9. Re-run affected verification, inspect final diff/status, and report only evidence-backed completion.

Do not merge, push, publish, deploy or perform destructive operations without explicit user approval.
