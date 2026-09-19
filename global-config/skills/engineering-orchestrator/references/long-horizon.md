# Long-horizon execution

Use this path for work that is too large or interruption-prone for one conversational context.

## Durable artifacts

When the user explicitly chooses the long-horizon workflow (for example with `/ues-run`) create:

```text
.ues-work/<slug>/
  SPEC.md
  PLAN.json
  STATE.json
  EVIDENCE.json
  tasks/
  reports/
```

The directory is git-ignored execution state, not hidden reasoning. Store requirements, decisions, task status, reports and fresh verification evidence. Never store secrets or chain-of-thought.

## Machine-enforced gates

The V6 engine enforces three boundaries:

1. **Plan gate** — `work plan` leaves the item in `awaiting-plan-approval`. `work start` refuses to run until an independent plan checker PASS is recorded with `work approve-plan`.
2. **Concurrent state gate** — all mutable `STATE.json` and `EVIDENCE.json` operations use a per-work-item lock plus atomic file replacement, preventing safe-wave executors from losing each other's state.
3. **Integration gate** — finalization requires a recorded `verify-integration --verdict PASS`. The engine fingerprints the Git workspace at PASS time and rejects finalization if the workspace changes afterward.

## Pipeline

1. Map the relevant codebase using repository evidence and `ues-codebase-mapper` when useful.
2. Write observable acceptance criteria into `SPEC.md`.
3. Initialize state with `ocskill work init`.
4. Create `PLAN.json` following the plan schema and import it with `ocskill work plan`.
5. Run `ues-plan-checker`. If it returns PASS, persist that gate with `ocskill work approve-plan`.
6. Use `ocskill task-graph` to compute dependency-safe waves.
7. For each ready task:
   - on OpenCode V2 prefer `ues.dispatch_task`, which performs `work start`, creates a fresh `ues-executor` session, selects the configured attempt-based model tier, prompts it with a bounded context pack and waits for completion;
   - inspect the child diff and verification;
   - persist `work complete --evidence ...` or `work fail --reason ...`.
8. On failure, re-diagnose rather than stacking patches. A later `ues.dispatch_task` attempt can escalate from standard to heavy when configured.
9. After all tasks complete, run `ues-integration-verifier`.
10. Persist the verifier's actual result with `ocskill work verify-integration`.
11. Only a recorded PASS with an unchanged workspace can be finalized.

## Parallelism

Parallel execution is allowed only when:
- dependencies are satisfied;
- safe-wave analysis does not detect declared-file overlap;
- executors do not write shared implicit files or interfaces.

UES serializes durable state writes, but it cannot make conflicting source-code edits safe. When write-surface independence is uncertain, execute sequentially.

## Resume

On resume, trust `STATE.json`, `EVIDENCE.json`, reports, and current Git status over conversational memory. Revalidate assumptions that could have changed. Do not replay completed tasks merely because the current context does not remember them.
