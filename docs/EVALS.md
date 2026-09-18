# UES evaluations

UES has two evaluation layers because catalog correctness and agent correctness are different problems.

## 1. Static routing contract

`evals/routing.json` is a deterministic maintenance contract for representative engineering requests.

Run:

```bash
npm run evals
```

or:

```bash
ocskill eval
```

It checks scenario shape, valid skill IDs, focused routing expectations, and coverage of core process skills. It catches packaging/catalog drift without spending model tokens.

It does **not** prove that a model selected the right skill or solved a coding task.

## 2. Live behavioral benchmark

`scripts/eval-live.mjs` runs executable coding tasks through OpenCode in isolated temporary workspaces.

For each task it can run:
- **baseline** — the selected model with an isolated empty OpenCode config
- **ues** — the same model/task with the current repository's UES resources installed into an isolated config

The task workspace is copied from `evals/live/fixtures/`. The grader lives outside that workspace so success is determined by independent behavior checks rather than the agent's narrative.

Example:

```bash
npm run evals:live -- --model anthropic/claude-sonnet-4-5 --variant high --trials 3
```

or after global installation:

```bash
ocskill eval-live --model anthropic/claude-sonnet-4-5 --variant high --trials 3
```

Useful filters:

```bash
npm run evals:live -- --model openai/gpt-5.2 --task js-discount-regression --mode ues
```

Requirements:
- OpenCode CLI available as `opencode`
- provider credentials already available to OpenCode/environment
- a valid `provider/model`

Live result JSON is written under `.ues-evals/` and is intentionally gitignored. See `docs/TRACE-SCHEMA.md`.

## What to score

Grow the live suite around observable outcomes:
- hidden grader/task correctness
- regression rate
- recovery from injected failures
- acceptance-criteria coverage
- verification quality
- elapsed time
- token/tool-call cost when stable telemetry is available
- baseline vs UES pass rate over multiple trials

Do not claim GPT/Claude equivalence from one fixture or one passing trial. The benchmark measures whether this harness improves the selected model on the tested engineering workload.
