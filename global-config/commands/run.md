---
description: Execute engineering work with adaptive UES policy, escalating to durable long-horizon state only when risk, scope or evidence requires it.
agent: build
---

Run this task using the UES adaptive workflow: $ARGUMENTS

Preserve the user's exact requested outcome, response constraints and approval boundaries. `/ues-run` means "use UES when useful"; it does not by itself declare the task long-horizon.

Adaptive admission:
1. If the request is directly answerable and requires no repository evidence, edits or machine-checkable verification, answer it directly and stop. Do not inspect the repository, create `.ues-work`, create SPEC/PLAN files, dispatch subagents or run unrelated commands.
2. Otherwise classify only a concise task summary with `ocskill task-policy "<concise task summary>"`. Never duplicate the full user prompt into shell arguments.
3. Follow the returned execution policy instead of forcing one workflow:
   - FAST / inline: use only the minimum direct evidence required by the request. Do not initialize durable state or plan/integration gates. Make bounded changes if needed and run targeted verification.
   - STANDARD: inspect targeted repository evidence, keep the working plan concise, make bounded edits and run targeted + affected verification. Durable `.ues-work` state, plan gates and parallel dispatch are not required by default.
   - DEEP / long-horizon / high-risk: use the durable workflow below. This includes cases where the policy reports durable state, a required plan check, long-horizon mode or high risk.
4. Escalate only from the actual request, policy result or new evidence. Never escalate merely because the alias is `/ues-run`.

Durable workflow for DEEP / long-horizon / high-risk work:
1. Inspect repository instructions and deterministic evidence with `ocskill inspect`, `ocskill repo-graph . --compact`, and targeted impact searches. Expand to the full graph only when exact edge detail is needed.
2. Create a concise SPEC with observable acceptance criteria.
3. Initialize persistent state with `ocskill work init`.
4. Produce a file-aware `PLAN.json` using the UES plan schema, then import it with `ocskill work plan`.
5. Dispatch `ues-plan-checker` in fresh context. For long/high-risk work, bind the PASS to the current plan with a structured receipt, then approve it:
   `ocskill work gate-receipt <slug> plan . --verifier ues-plan-checker --evidence "<summary>" --out .ues-work/<slug>/reports/plan-receipt.json`
   followed by `ocskill work approve-plan <slug> . --evidence "<summary>" --receipt-file .ues-work/<slug>/reports/plan-receipt.json`.
6. Use `ocskill task-graph` and execute only dependency-ready tasks. On OpenCode V2, when two or more independent tasks are ready, prefer `ues.dispatch_parallel`. V13 uses multiple fresh sessions of one shared model, not multiple model families. For a single task or a deliberately serial path, use `ues.dispatch_task`.
7. `ues.dispatch_parallel` is event-driven rather than wave-barrier driven: as soon as a task is independently verified, transactionally integrated and durably completed, newly unblocked dependencies may start in the next free worker slot. Resource leases serialize overlapping writers, unknown scopes and shared configuration surfaces.
8. Each parallel writer gets an isolated Git worktree. A pre-existing dirty root is treated as an inherited baseline, and downstream worktrees also inherit already integrated root changes through an internal sandbox snapshot; only task-local deltas are integrated and the user's root branch is not auto-committed. Integration is serialized and rolled back if post-integration verification/receipt/completion fails.
9. For machine-checkable verification, add `verificationCommands` to the approved task, for example `{"command":"node","args":["--test","test/foo.test.mjs"]}`. V13 runs these exact commands after integration via `ocskill work verify-command`, records deterministic receipts, then also records the fresh independent verifier verdict. For long/high-risk plans, current-fingerprint receipt evidence remains mandatory.
10. During long execution keep task leases alive (the V2 dispatcher does this automatically). On resume, `ocskill work recover` or `ocskill work resume` recovers expired leases instead of leaving tasks stuck in `running`. In parallel mode, keep one shared model for all worker/verifier sessions unless the user explicitly changes the run design.
11. After all tasks complete, dispatch `ues-integration-verifier`. For PASS on long/high-risk work, create an integration receipt bound to the current workspace fingerprint:
   `ocskill work gate-receipt <slug> integration . --verifier ues-integration-verifier --verdict PASS --evidence "<summary>" --out .ues-work/<slug>/reports/integration-receipt.json`
   then record it with `ocskill work verify-integration <slug> . --verdict PASS --evidence "<summary>" --receipt-file .ues-work/<slug>/reports/integration-receipt.json`.
12. `ocskill work finalize` is allowed only after a recorded PASS and only if the workspace fingerprint has not changed since that PASS. Re-run verification if it changed.
13. Inspect final diff/status and report only evidence-backed completion.

Never create or use `ues-work/` (without the leading dot) as durable UES state. If such a directory exists from an older/manual run, treat it as ordinary repository content unless the user explicitly asks to migrate it; official durable state must come from `ocskill work init` under `.ues-work/<slug>/`.

Do not merge, push, publish, deploy or perform destructive operations without explicit user approval.

After a meaningful eval run, `ocskill learn analyze . --eval-dir .ues-evals` clusters recurring failures into candidate lessons. `ocskill learn accept <id> .` stages a proposal, but shadow-required lessons enter future context only after `ocskill learn promote <id> . --baseline <rate> --candidate <rate> --samples N` proves an improvement.
