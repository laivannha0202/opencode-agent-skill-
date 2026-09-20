---
description: Execute complex/long-running engineering work with adaptive policy, crash-safe leases, structured evidence, context manifests, isolated sandboxes and integration gates.
agent: build
---

Run this task using the UES long-horizon workflow: $ARGUMENTS

Treat this command as permission to create a repository-local, git-ignored `.ues-work/<slug>/` execution workspace for durable non-secret planning state.

Required workflow:
1. Classify the request with `ocskill task-policy "$ARGUMENTS"`. Use the returned risk/mode/context guidance rather than assuming every non-trivial task needs the same workflow.
2. Inspect repository instructions and deterministic evidence with `ocskill inspect`, `ocskill repo-graph`, and targeted impact searches.
3. Create a concise SPEC with observable acceptance criteria.
4. Initialize persistent state with `ocskill work init`.
5. Produce a file-aware `PLAN.json` using the UES plan schema, then import it with `ocskill work plan`.
6. Dispatch `ues-plan-checker` in fresh context. A task cannot start until the checker returns PASS and the parent records it with `ocskill work approve-plan <slug> . --evidence <summary>`.
7. Use `ocskill task-graph` and execute only ready dependency-safe tasks. On OpenCode V2 prefer `ues.dispatch_task`: it starts the task, creates a fresh `ues-executor` session, applies configured attempt-based model escalation, waits for that executor, and returns its report. Inspect the diff and evidence, then record `ocskill work complete` or `ocskill work fail`.
8. Independent tasks may run concurrently only when safe-wave analysis reports no write/read conflict. For parallel write tasks, prefer isolated Git worktrees with `ocskill sandbox create <slug> <task> .` (created beside the main checkout) and integrate deliberately; do not point two executors at overlapping write surfaces in one working tree.
9. During long execution keep the task lease alive with `ocskill work heartbeat` (the V2 dispatcher does this automatically). On resume, `ocskill work recover` or `ocskill work resume` recovers expired leases instead of leaving tasks stuck in `running`.
10. Run declared checks through `ocskill work verify-command <slug> <task> . -- <command> [args...]` when practical so EVIDENCE.json contains structured exit-code/output-hash/workspace receipts. Then record completion or failure with the current runId.
11. On executor failure, diagnose from fresh evidence and retry in a fresh executor. Adaptive model policy may raise the model tier based on risk/complexity plus attempt count; do not escalate blindly.
12. After all tasks complete, dispatch `ues-integration-verifier`. Record its actual verdict with `ocskill work verify-integration <slug> . --verdict PASS|FAIL|PARTIAL --evidence <summary>`.
13. `ocskill work finalize` is allowed only after a recorded PASS and only if the workspace fingerprint has not changed since that PASS. Re-run verification if it changed.
14. Inspect final diff/status and report only evidence-backed completion.

Do not merge, push, publish, deploy or perform destructive operations without explicit user approval.


After a meaningful eval run, `ocskill learn analyze . --eval-dir .ues-evals` may produce deterministic learning proposals. Accepted lessons are explicit (`ocskill learn accept <id> .`) and can be surfaced in future context packs; UES never silently rewrites skills from one run.
