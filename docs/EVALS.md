# UES evaluations

V11 separates catalog correctness, routing precision, benchmark integrity, final behavior, long-horizon orchestration and cross-stack coverage.

## 1. Static skill-routing contract

`evals/routing.json` keeps 43 representative scenarios and covers all installed skills.

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

## 5. Polyglot suite integrity

The polyglot suite contains **8 tasks** covering Python, Java, .NET, Next.js, React Native, SQL migration, monorepo boundaries and generated contract discipline.

```bash
npm run evals:polyglot:validate
```

The hidden graders must reject the intentionally broken fixture before the suite is considered valid.

## 6. Live baseline vs UES

```bash
ocskill eval-live --model provider/model --trials 3
ocskill eval-live --suite long --model provider/model --trials 3
ocskill eval-live --suite polyglot --model provider/model --trials 3
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
5. plan approval status is `passed` and contains a structured plan-verification receipt for the current plan hash;
6. every planned task has an attempt and ends `completed`;
7. every task is backed by a successful verification receipt;
8. integration verification is `PASS` and contains a structured integration-verification receipt for the verified workspace fingerprint;
9. integration and finalization evidence exist;
10. work item status is `completed`.

Therefore a model that directly patches all files in its main context but bypasses the long-task engine is not counted as a successful UES long-horizon run.

## 7. Benchmark matrix

Run all three behavioral suites in baseline and UES mode:

```bash
npm run evals:matrix -- --model provider/model --trials 3
```

The matrix verifies that the expected number of baseline and UES runs was produced before summarizing pass-rate delta. Use `--long-only`, `--standard-only`, `--polyglot-only`, or `--without-polyglot` to narrow the matrix.

## 8. Authentication isolation

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

## 9. Telemetry

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

## 10. Report aggregation

```bash
ocskill eval-report .ues-evals
```

Compare the same model, variant, prompt, fixture, grader and environment. Report multiple trials.

A benchmark result is evidence only for the measured workload. UES does not claim to turn one base model into another.


## V11 live-run observability and evidence gate

Live runs accept:

```bash
--heartbeat-ms 30000
--idle-timeout-ms 300000
--timeout-ms 900000
```

The harness prints a start line and heartbeat for an active model run. Hard timeout and idle timeout are recorded separately. Ctrl+C aborts the active OpenCode process tree and sets exit code 130 after the current result is recorded.

V8 long-suite UES mode requires **receipt-backed verification for every planned task**, a structured plan receipt bound to the current plan hash, and a structured integration receipt bound to the verified workspace fingerprint. Strict task completion additionally rejects a successful command receipt if the workspace changed after that receipt.

This intentionally raises the benchmark bar: final code correctness + durable orchestration + current machine-observable verification are all required.
