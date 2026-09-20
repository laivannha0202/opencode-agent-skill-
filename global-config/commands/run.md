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
6. Dispatch `ues-plan-checker` in fresh context. For long/high-risk work, bind the PASS to the current plan with a structured receipt, then approve it:
   `ocskill work gate-receipt <slug> plan . --verifier ues-plan-checker --evidence "<summary>" --out .ues-work/<slug>/reports/plan-receipt.json`
   followed by `ocskill work approve-plan <slug> . --evidence "<summary>" --receipt-file .ues-work/<slug>/reports/plan-receipt.json`.
7. Use `ocskill task-graph` and execute only ready dependency-safe tasks. On OpenCode V2 prefer `ues.dispatch_task`: it starts the task, creates a fresh `ues-executor` session, applies configured attempt-based model escalation, waits for that executor, and returns its report. Inspect the diff and evidence, then record `ocskill work complete` or `ocskill work fail`.
8. Independent tasks may run concurrently only when safe-wave analysis reports no write/read conflict. V8 can isolate concurrent writers in Git worktrees and integrate them with conflict detection; manual fallback is `ocskill sandbox create ...` followed by `ocskill sandbox integrate <worktree> .`. Never integrate over overlapping dirty root files.
9. During long execution keep the task lease alive with `ocskill work heartbeat` (the V2 dispatcher does this automatically). On resume, `ocskill work recover` or `ocskill work resume` recovers expired leases instead of leaving tasks stuck in `running`.
10. Run declared checks through `ocskill work verify-command <slug> <task> . --run-id <run-id> -- <command> [args...]`. For long/high-risk plans, a successful receipt for the active run is mandatory before `work complete`; narrative-only completion is rejected.
11. On executor failure, diagnose from fresh evidence and retry in a fresh executor. Adaptive model policy may raise the model tier based on risk/complexity plus attempt count; do not escalate blindly.
12. After all tasks complete, dispatch `ues-integration-verifier`. For PASS on long/high-risk work, create an integration receipt bound to the current workspace fingerprint:
   `ocskill work gate-receipt <slug> integration . --verifier ues-integration-verifier --verdict PASS --evidence "<summary>" --out .ues-work/<slug>/reports/integration-receipt.json`
   then record it with `ocskill work verify-integration <slug> . --verdict PASS --evidence "<summary>" --receipt-file .ues-work/<slug>/reports/integration-receipt.json`.
13. `ocskill work finalize` is allowed only after a recorded PASS and only if the workspace fingerprint has not changed since that PASS. Re-run verification if it changed.
14. Inspect final diff/status and report only evidence-backed completion.

Do not merge, push, publish, deploy or perform destructive operations without explicit user approval.


After a meaningful eval run, `ocskill learn analyze . --eval-dir .ues-evals` clusters recurring failures into candidate lessons. `ocskill learn accept <id> .` stages a proposal, but shadow-required lessons enter future context only after `ocskill learn promote <id> . --baseline <rate> --candidate <rate> --samples N` proves an improvement.
