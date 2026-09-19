# UES evaluation trace schema

Live evaluations write machine-readable JSON under `.ues-evals/`.

Each result item contains:

- `task`
- `mode`: `baseline` or `ues`
- `model` and optional `variant`
- `trial`
- `passed`
- `agentExit` and `graderExit`
- `durationMs`
- `authMode`: `env-only` or `current`
- `changedFiles`: added/removed/modified workspace paths
- bounded agent/grader stdout and stderr
- optional kept workspace path when `--keep` is used
- timestamp

## Telemetry

`telemetry` currently has schema version 1:

```json
{
  "schemaVersion": 1,
  "format": "best-effort-opencode-jsonl",
  "jsonLines": 42,
  "parseErrors": 0,
  "toolCalls": 12,
  "tools": {
    "bash": 4,
    "read": 5,
    "skill": 2,
    "subagent": 1
  },
  "skillsLoaded": ["ues-bug-diagnosis"],
  "subagents": ["ues-verifier"],
  "tokens": {
    "input": 12000,
    "output": 2200,
    "total": 14200
  },
  "cost": 0.18
}
```

OpenCode JSON event shapes can evolve, so telemetry extraction is best-effort. Hidden-grader correctness and process exit status remain the primary benchmark evidence.

The trace intentionally does not collect or score hidden chain-of-thought.

## Run summary

Each result file also contains:
- suite version
- auth mode
- selected model/variant
- trial count
- optional task filter
- modes executed
- pass counts and pass rates per mode

Use `ocskill eval-report` or `npm run evals:report -- <paths>` to aggregate multiple result files.

## Fair comparisons

Keep constant:
- model and variant
- task fixture
- prompt
- grader
- runtime/provider environment
- trial count when possible

Compare observable success, regressions, elapsed time, tool behavior and cost rather than narrative confidence.
