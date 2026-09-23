---
description: Execute engineering work with adaptive UES policy inside Pi.
argument-hint: "<task>"
---

Run this task with UES on Pi: $ARGUMENTS

Preserve the user's exact requested outcome, constraints, and approval boundaries.

1. Classify a concise task summary with `ocskill task-policy "<summary>" --json`.
2. FAST/inline: gather only the minimum evidence, make bounded changes if needed, and run targeted verification. Do not create durable state.
3. STANDARD: inspect targeted repository evidence, keep a concise working plan, make bounded edits, and run targeted plus affected verification.
4. DEEP/long-horizon/high-risk: use `.ues-work/<slug>/` durable state, SPEC, PLAN, dependency-safe tasks, receipts, and final integration verification.
5. Use `ues_fresh_agent` for genuinely independent fresh-context research, review, verification, or a narrowly scoped implementation task. Prefer read-only mode unless edits are required. Do not recursively delegate.
6. For long/high-risk work, require plan and integration receipts bound to the current plan/workspace before finalization.
7. Preserve unrelated user changes. Do not merge, push, publish, deploy, rewrite history, or perform destructive operations without explicit approval.
8. Finish by inspecting the final diff/status and report only evidence-backed completion.
