---
description: Execute engineering work through the deterministic UES runtime controller on Pi, with adaptive context, model routing, retries, and evidence-gated verification.
---

Run this task with UES on Pi: $@

Preserve the user's requested outcome and approval boundaries.

1. If the request is directly answerable and needs no repository evidence, edits, or machine-checkable verification, answer directly.
2. Otherwise prefer the `ues_execute` tool for end-to-end engineering work. Pass a concise but complete task and the current repository cwd. The controller owns task policy, bounded context construction, model-tier routing, optional diagnosis/plan gating, implementation, retries, independent verification, integration verification, and performance telemetry.
3. Do not manually reproduce the controller workflow unless `ues_execute` is unavailable or the user explicitly asks for plan-only/review-only/research-only work.
4. Use `ues_cli` for deterministic inspection, durable `.ues-work/` state, task graphs, receipts, evidence, worktrees, browser/visual helpers, and explicit policy/config operations.
5. Use `ues_dispatch` when you intentionally need one specialist, a custom chain, or bounded parallel read-only work. Routed dispatch automatically applies model policy and adaptive context.
6. Parallel read-only agents may share the repository. Parallel writer agents must use explicit distinct isolated cwd/worktrees; otherwise run writers serially. Never bypass this guard.
7. Preserve unrelated user changes. Do not force-clean a repository.
8. Do not merge, push, publish, deploy, rewrite history, or perform destructive operations without explicit user approval.
9. Final completion claims must come from a verified controller PASS or equivalent fresh command/test evidence plus the final diff/status.
