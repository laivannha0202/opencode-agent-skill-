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
7. Use `ocskill task-graph` and execute only dependency-ready tasks. On OpenCode V2, when two or more independent tasks are ready, prefer `ues.dispatch_parallel`. V13 uses multiple fresh sessions of one shared model, not multiple model families. For a single task or a deliberately serial path, use `ues.dispatch_task`.
8. `ues.dispatch_parallel` is event-driven rather than wave-barrier driven: as soon as a task is independently verified, transactionally integrated and durably completed, newly unblocked dependencies may start in the next free worker slot. Resource leases serialize overlapping writers, unknown scopes and shared configuration surfaces.
9. Each parallel writer gets an isolated Git worktree. Downstream worktrees inherit already integrated root changes through an internal sandbox snapshot; the user's root branch is not auto-committed. Integration is serialized and rolled back if post-integration verification/receipt/completion fails.
10. For machine-checkable verification, add `verificationCommands` to the approved task, for example `{"command":"node","args":["--test","test/foo.test.mjs"]}`. V13 runs these exact commands after integration via `ocskill work verify-command`, records deterministic receipts, then also records the fresh independent verifier verdict. For long/high-risk plans, current-fingerprint receipt evidence remains mandatory.
11. During long execution keep task leases alive (the V2 dispatcher does this automatically). On resume, `ocskill work recover` or `ocskill work resume` recovers expired leases instead of leaving tasks stuck in `running`. In parallel mode, keep one shared model for all worker/verifier sessions unless the user explicitly changes the run design.
12. After all tasks complete, dispatch `ues-integration-verifier`. For PASS on long/high-risk work, create an integration receipt bound to the current workspace fingerprint:
   `ocskill work gate-receipt <slug> integration . --verifier ues-integration-verifier --verdict PASS --evidence "<summary>" --out .ues-work/<slug>/reports/integration-receipt.json`
   then record it with `ocskill work verify-integration <slug> . --verdict PASS --evidence "<summary>" --receipt-file .ues-work/<slug>/reports/integration-receipt.json`.
13. `ocskill work finalize` is allowed only after a recorded PASS and only if the workspace fingerprint has not changed since that PASS. Re-run verification if it changed.
14. Inspect final diff/status and report only evidence-backed completion.

Do not merge, push, publish, deploy or perform destructive operations without explicit user approval.


After a meaningful eval run, `ocskill learn analyze . --eval-dir .ues-evals` clusters recurring failures into candidate lessons. `ocskill learn accept <id> .` stages a proposal, but shadow-required lessons enter future context only after `ocskill learn promote <id> . --baseline <rate> --candidate <rate> --samples N` proves an improvement.
