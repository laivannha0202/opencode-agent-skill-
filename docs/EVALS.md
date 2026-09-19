# UES evaluations

UES uses three evaluation layers because catalog correctness, benchmark integrity, and model behavior are different problems.

## 1. Static routing contract

`evals/routing.json` contains 34 representative engineering prompts and covers every installed UES skill at least once while keeping each expected route focused.

Run:

```bash
npm run evals
```

or:

```bash
ocskill eval
```

This catches renamed/deleted skills, routing catalog drift, oversized expected routes, and missing domain coverage without spending model tokens. It does **not** prove that a model actually selected the skill.

## 2. Live-suite integrity

The live suite contains 20 executable tasks spanning bug fixing, authorization, API contracts, pagination, inventory, payment idempotency, webhook ordering, upload/path security, retry logic, migrations, money invariants, SQL allowlists, React request races, React Native platform behavior, dependency compatibility, configuration parsing, cache invalidation, and multi-file compatibility.

Run:

```bash
npm run evals:live:validate
```

The validator checks task/fixture/grader references and then runs every hidden grader against its intentionally broken fixture. Each grader must reject the broken starting state with an assertion failure; a grader that already passes or crashes for an unrelated reason fails validation.

## 3. Live behavioral benchmark

`scripts/eval-live.mjs` runs coding tasks through OpenCode in isolated temporary workspaces.

For each task:
- **baseline** — same selected model with an isolated empty OpenCode config
- **ues** — same model/task with the current repository's UES resources installed

The grader stays outside the editable workspace. Multiple trials are supported because agent runs are nondeterministic.

Example:

```bash
npm run evals:live -- --model provider/model --trials 3
```

or after global installation:

```bash
ocskill eval-live --model provider/model --trials 3
```

Useful filters:

```bash
ocskill eval-live --model provider/model --task payment-idempotency --mode both --trials 5
```

### Authentication isolation

Default:

```text
--auth env-only
```

The benchmark isolates `HOME`, `USERPROFILE`, XDG config/data/cache/state, and the OpenCode config so a baseline cannot accidentally inherit UES. Provider credentials must therefore already be available through environment variables.

For a workstation where OpenCode credentials were established with `/connect`, use:

```bash
ocskill eval-live --model provider/model --auth current --trials 3
```

`current` copies only the current OpenCode `auth.json` into each isolated data directory. It does not copy the user's global OpenCode configuration.

### Telemetry

Each result records:
- hidden-grader pass/fail
- process exit status and duration
- changed workspace files
- bounded stdout/stderr
- best-effort JSONL tool-call counts
- skills observed as loaded through the skill tool
- subagent tool targets
- token usage and cost when exposed by the OpenCode JSON event stream

Telemetry parsing is deliberately tolerant of event-shape variation. Missing telemetry is not converted into invented values.

Results are written under `.ues-evals/`.

## Report aggregation

Aggregate one result directory or explicit JSON files:

```bash
ocskill eval-report .ues-evals
```

The report computes per-mode pass rate, average duration/tool calls/tokens/cost, per-task pass rates, and the UES-minus-baseline pass-rate delta.

## Interpretation

One passing task or trial is not evidence of general model equivalence. Use the same model, variant, fixture, prompt, grader and environment across baseline/UES runs and compare multiple trials.

UES measures whether the harness improves observable engineering outcomes on the tested workload. It does not claim to turn one base model into another.
