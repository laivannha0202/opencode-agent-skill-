---
description: Execute a complex or long-running engineering task with durable state, crash-safe leases, structured verification receipts, intelligent context, adaptive model routing and resumability.
agent: build
---

Run this task using the UES 7.7 long-horizon workflow: $ARGUMENTS

Treat this command as permission to create a repository-local, git-ignored `.ues-work/<slug>/` execution workspace for durable non-secret planning state.

Required workflow:
1. Inspect repository instructions and deterministic evidence with `ocskill inspect`, `ocskill repo-graph`, and targeted impact searches.
2. Create a concise SPEC with observable acceptance criteria.
3. Initialize persistent state with `ocskill work init`. New V7.7 work items require structured verification receipts by default.
4. Produce a file-aware `PLAN.json`, import it with `ocskill work plan`, and inspect `ocskill task-graph`.
5. Dispatch `ues-plan-checker` in fresh context. A task cannot start until the checker returns PASS and the parent records it with `ocskill work approve-plan <slug> . --evidence <summary>`.
6. Execute only ready tasks. On capable OpenCode runtimes prefer `ues.dispatch_task`; the dispatcher assigns a run lease, keeps a heartbeat while the fresh executor is active, builds a bounded context manifest, and applies adaptive model policy from attempt/risk/context signals.
7. Verification for each running task must be executed through `ocskill work check <slug> <task-id> . -- <command> [args...]`. This records a machine-bound receipt with exit status, output hashes, run identity and workspace fingerprint. Then record `ocskill work complete` only after inspecting the diff and receipt.
8. If an executor crashes or the process disappears, `ocskill work resume` recovers expired task leases. Use `ocskill work recover` explicitly when diagnosing stale runs. Never silently mark an abandoned running task complete.
9. For safe parallel work, use `ocskill sandbox create <slug> <task> .` only from a clean Git worktree. Independent tasks may run in isolated worktrees and be brought back with `ocskill sandbox apply`; remove the sandbox after integration. Read-only overlap does not force serialization, but any write/read or write/write conflict does.
10. On executor failure, record `ocskill work fail`, re-diagnose from fresh evidence, and retry in a fresh executor. Adaptive policy may raise the model tier after repeated/risky failures.
11. After all tasks complete, dispatch `ues-integration-verifier`. Run fresh integration checks through `ocskill work check <slug> __integration__ . -- <command> [args...]`, then record the actual verdict with `ocskill work verify-integration`.
12. `ocskill work finalize` is allowed only after recorded integration PASS, structured integration evidence when required, and an unchanged workspace fingerprint.
13. Inspect final diff/status and report only evidence-backed completion.

Optional post-run learning:
- `ocskill learn .` summarizes local eval traces into proposal-only lessons under `.ues-learning/`.
- Learning proposals never auto-edit or auto-activate skills; a regression must prove a change before adoption.
- `ocskill hermes status` and `ocskill hermes handoff` provide an optional Hermes Agent interoperability boundary without making Hermes the UES source of truth.
- `ocskill dashboard .` starts the local read-only UES Control Center.

Do not merge, push, publish, deploy or perform destructive operations without explicit user approval.
