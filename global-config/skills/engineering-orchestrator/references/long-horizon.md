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
  EVENTS.jsonl
  EXECUTION_CONTRACT.json
  FINAL_VERDICTS.json
  phases/
    MANIFEST.json
    phase-XX-<slug>.json
  tasks/
  reports/
```

The directory is git-ignored execution state, not hidden reasoning. Store requirements, decisions, task status, reports and fresh verification evidence. Never store secrets or chain-of-thought. Never substitute a top-level `ues-work/` directory for `.ues-work/<slug>/`; old/manual `ues-work/` files are non-canonical unless explicitly migrated.

## Machine-enforced gates

The runtime enforces seven boundaries:

1. **Inherited-work gate** — snapshot source-facing dirty paths before planning. UES children may not discard them with restore/checkout/stash/clean/reset, and planned writers must declare every touched file.
2. **Local-env gate** — local `.env*` runtime inputs are no-write by default; only explicit user authorization permits local env mutation. Repository templates remain writable.
3. **Plan gate** — `work plan` leaves the item in `awaiting-plan-approval`. Long/high-risk plans require a structured `plan-verification` receipt bound to the current plan hash before `work approve-plan` succeeds.
4. **Phase gate** — explicit execution phases become deterministic previous-phase barriers. Constraint-only phases stay global invariants.
5. **Concurrent state gate** — all mutable `STATE.json` and `EVIDENCE.json` operations use a per-work-item lock plus atomic file replacement, preventing safe-wave executors from losing each other's state.
6. **Integration gate** — long/high-risk source completion requires a structured `integration-verification` receipt bound to the current workspace fingerprint. Finalization rejects any later workspace change.
7. **Verdict matrix gate** — source, runtime, database cleanup and real-device proof remain independent. Missing required evidence is reported as not verified rather than promoted to PASS.

## Pipeline

1. Map the relevant codebase using repository evidence and `ues-codebase-mapper` when useful.
2. Write observable acceptance criteria into `SPEC.md`.
3. Initialize state with `ocskill work init`.
4. Create `PLAN.json` following the plan schema and import it with `ocskill work plan`.
5. If the user supplied explicit `PHASE N` sections, preserve every execution phase in the plan and let UES add phase barriers; constraint-only phases remain invariants.
6. Run `ues-plan-checker`. If it returns PASS, create `work gate-receipt <slug> plan` and persist approval with `work approve-plan --receipt-file ...`.
7. Persist the execution contract/phase artifacts and use `ocskill task-graph` to compute dependency-safe waves.
8. For each ready task:
   - on OpenCode V2, if two or more approved tasks are independent, prefer `ues.dispatch_parallel` so one shared model can execute them concurrently with isolated worktrees, leases, independent verifier sessions and serialized integration;
   - otherwise prefer `ues.dispatch_task`, which performs `work start`, creates a fresh `ues-executor` session, selects the configured attempt-based model tier, prompts it with a bounded context pack and waits for completion;
   - inspect the child diff and verification;
   - record at least one successful `work verify-command` receipt for long/high-risk work;
   - persist `work complete --evidence ...` or `work fail --reason ...`.
9. On failure, re-diagnose rather than stacking patches. A later `ues.dispatch_task` attempt can escalate from standard to heavy when configured.
10. After all tasks complete, run `ues-integration-verifier`.
11. Persist the verifier's actual result with a structured integration receipt plus `ocskill work verify-integration --receipt-file ...`.
12. Emit the independent final verdict matrix and persist `FINAL_VERDICTS.json`. Only a recorded PASS with an unchanged workspace can be finalized.

## Parallelism

Parallel execution is allowed only when:
- dependencies are satisfied;
- declared file/resource scopes are independent or protected by leases;
- the runtime exposes the fresh-dispatch capability surface;
- the root state satisfies the parallel runtime safety preconditions.

V13 uses event-driven scheduling rather than fixed wave barriers: a dependency may start as soon as its prerequisite has been independently verified, integrated and durably completed. Shared configuration surfaces and unknown scopes serialize conservatively. When write-surface independence is uncertain, execute sequentially.

## Resume

On resume, trust `STATE.json`, `EVIDENCE.json`, reports, and current Git status over conversational memory. Revalidate assumptions that could have changed. Do not replay completed tasks merely because the current context does not remember them.
