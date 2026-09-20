# UES evaluations

UES 7.7 separates catalog correctness, routing precision, benchmark integrity, final behavior and long-horizon orchestration.

## 1. Static skill-routing contract

`evals/routing.json` keeps 34 representative scenarios and covers all installed skills.

```bash
npm run evals
# or
ocskill eval
```

This checks catalog consistency, not model behavior.

## 2. V2 router trigger matrix

`evals/router-triggers.json` contains **120 cases** spanning positive routes, negative guards and wording variations.

```bash
npm run evals:router
```

The evaluator reports required-route recall and negative-guard success. It exists to catch deterministic router drift separately from LLM behavior.

## 3. Standard live-suite integrity

The standard live suite contains **20 executable hidden-graded tasks**.

```bash
npm run evals:live:validate
```

Each grader must reject its intentionally broken fixture with an assertion failure. A grader that already passes or fails for unrelated setup reasons invalidates the suite.

## 4. Long-horizon suite integrity

The long suite contains **5 tasks**. Four exercise coordinated 3–4 file domains; one combines all four domains into a **15-source-file** integration workload.

```bash
npm run evals:long:validate
```

The same broken-fixture rule applies.

## 5. Live baseline vs UES

```bash
ocskill eval-live --model provider/model --trials 3
ocskill eval-live --suite long --model provider/model --trials 3
```

Each task runs as:

- **baseline** — isolated empty OpenCode config
- **ues** — same model/task with repository UES resources installed

Use multiple trials because coding-agent behavior is nondeterministic.

### Long-suite orchestration gate

For `--suite long`, a UES-mode result is PASS only if:

1. OpenCode agent process exits successfully;
2. hidden behavior grader passes;
3. at least one `.ues-work/<slug>/` item is valid;
4. the plan contains at least two tasks;
5. plan approval status is `passed`;
6. every planned task has an attempt and ends `completed`;
7. integration verification is `PASS`;
8. integration and finalization evidence exist;
9. work item status is `completed`;
10. every planned task has passing structured receipt-backed evidence for the current run/workspace;
11. integration verification has a passing structured receipt for the verified workspace.

Therefore a model that directly patches all files in its main context but bypasses the long-task engine is not counted as a successful UES long-horizon run.

## Authentication isolation

Default mode:

```text
--auth env-only
```

The harness isolates HOME, USERPROFILE, XDG config/data/cache/state and `OPENCODE_CONFIG_DIR`.

If provider auth was established through OpenCode itself:

```bash
ocskill eval-live --model provider/model --auth current --trials 3
```

`current` copies only the current auth file, not the user's global UES configuration.

## Telemetry

Results may include:

- pass/fail
- process exit status
- duration
- changed files
- bounded stdout/stderr
- best-effort tool calls
- loaded skills/subagent targets
- token/cost data when exposed
- long-suite orchestration inspection

No hidden chain-of-thought is collected.

## Report aggregation

```bash
ocskill eval-report .ues-evals
```

Compare the same model, variant, prompt, fixture, grader and environment. Report multiple trials.

A benchmark result is evidence only for the measured workload. UES does not claim to turn one base model into another.


### Runtime observability

Live evals support `--heartbeat-seconds`, `--timeout-minutes` and `--idle-timeout-minutes`. Result items include runtime timeout/cancellation metadata and the probed OpenCode capability set. This makes a provider/model hang distinguishable from a hidden-grader failure.
