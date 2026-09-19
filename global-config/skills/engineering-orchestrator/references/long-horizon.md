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

The files are execution state, not hidden reasoning. Store requirements, decisions, task status, reports and fresh verification evidence. Never store secrets or chain-of-thought.

## Pipeline

1. Map the relevant codebase using repository evidence and `ues-codebase-mapper` when useful.
2. Write observable acceptance criteria into `SPEC.md`.
3. Initialize state with `ocskill work init`.
4. Create `PLAN.json` following the plan schema and import it with `ocskill work plan`.
5. Run `ues-plan-checker` before implementation.
6. Use `ocskill task-graph` to compute dependency-safe waves.
7. For each ready task:
   - `ocskill work start`
   - build a bounded `ocskill context-pack`
   - dispatch a fresh `ues-executor`
   - inspect its diff and fresh verification
   - `ocskill work complete --evidence ...`
8. On failure, use `ocskill work fail`; re-diagnose rather than stacking patches.
9. After all tasks complete, run `ues-integration-verifier` and then reviewer/critic according to risk.
10. Only then claim completion.

## Parallelism

Parallel execution is allowed only when:
- dependencies are satisfied;
- safe-wave analysis does not detect declared-file overlap;
- executors have isolated working trees or the runtime guarantees non-conflicting writes.

When any condition is uncertain, execute sequentially.

## Resume

On resume, trust `STATE.json`, `EVIDENCE.json`, reports, and current Git status over conversational memory. Revalidate assumptions that could have changed. Do not replay completed tasks merely because the current context does not remember them.
