---
description: Execute engineering work with adaptive UES policy on Pi, escalating to durable state only when scope, risk or evidence requires it.
---

Run this task with UES on Pi: $@

Preserve the user's requested outcome and approval boundaries.

1. If the request is directly answerable and needs no repository evidence, edits, or machine-checkable verification, answer directly.
2. Otherwise call `ues_cli` with `["task-policy", "<concise task summary>", "--json"]`. Do not duplicate a huge user prompt into CLI arguments.
3. Follow the returned policy:
   - FAST / inline: inspect only targeted evidence, make the smallest coherent change, run targeted verification, and do not initialize durable state.
   - STANDARD: inspect affected code and tests, keep a concise working plan, edit bounded scope, and verify affected behavior.
   - DEEP / long-horizon / high-risk: use the durable `.ues-work/<slug>/` workflow, plan gate, task receipts, recovery, and final integration verification.
4. Use `ues_cli` instead of shelling out to `ocskill`; the Pi package always has the bundled CLI even when it is not on PATH.
5. For fresh specialist context use `ues_dispatch`. Prefer a fresh `ues-plan-checker` before approving a risky plan and a fresh `ues-integration-verifier` before finalization.
6. Parallel read-only agents may share the repository. Parallel writer agents must use explicit distinct isolated cwd/worktrees; otherwise run writers serially. Never bypass this guard.
7. Preserve unrelated user changes. Do not force-clean a repository.
8. Do not merge, push, publish, deploy, rewrite history, or perform destructive operations without explicit user approval.
9. Final completion claims must be backed by fresh command/test evidence and the final diff/status.
