---
description: Execute a complex or long-running engineering task with durable state, machine-enforced plan/integration gates, fresh-context task executors, dependency-safe waves, model escalation and resumability.
agent: build
---

Run this task using the UES long-horizon workflow: $ARGUMENTS

Treat this command as permission to create a repository-local, git-ignored `.ues-work/<slug>/` execution workspace for durable non-secret planning state.

Required workflow:
1. Inspect repository instructions and deterministic evidence with `ocskill inspect`, `ocskill repo-graph`, and targeted impact searches.
2. Create a concise SPEC with observable acceptance criteria.
3. Initialize persistent state with `ocskill work init`.
4. Produce a file-aware `PLAN.json` using the UES plan schema, then import it with `ocskill work plan`.
5. Dispatch `ues-plan-checker` in fresh context. A task cannot start until the checker returns PASS and the parent records it with `ocskill work approve-plan <slug> . --evidence <summary>`.
6. Use `ocskill task-graph` and execute only ready dependency-safe tasks. On OpenCode V2 prefer `ues.dispatch_task`: it starts the task, creates a fresh `ues-executor` session, applies configured attempt-based model escalation, waits for that executor, and returns its report. Inspect the diff and evidence, then record `ocskill work complete` or `ocskill work fail`.
7. Independent tasks may run concurrently only when the safe-wave analysis reports no declared-file overlap and their write surfaces are actually independent. Durable state updates are serialized by the UES engine.
8. On executor failure, record it with `ocskill work fail`, diagnose from fresh evidence, and retry in a fresh executor. Repeated attempts may escalate model tier automatically through `ues.dispatch_task`.
9. After all tasks complete, dispatch `ues-integration-verifier`. Record its actual verdict with `ocskill work verify-integration <slug> . --verdict PASS|FAIL|PARTIAL --evidence <summary>`.
10. `ocskill work finalize` is allowed only after a recorded PASS and only if the workspace fingerprint has not changed since that PASS. Re-run verification if it changed.
11. Inspect final diff/status and report only evidence-backed completion.

Do not merge, push, publish, deploy or perform destructive operations without explicit user approval.
