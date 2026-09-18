# UES evaluation trace schema

Live evaluations write machine-readable result files under `.ues-evals/` (gitignored).

Each run records enough data to compare the harness rather than trusting a narrative success report:

- task id
- mode: `baseline` or `ues`
- model and optional model variant
- trial number
- isolated workspace path only when `--keep` is used
- OpenCode process exit status
- grader exit status
- elapsed milliseconds
- bounded stdout/stderr excerpts for diagnosis
- final pass/fail
- timestamp

The summary records pass counts and rates per mode.

These traces intentionally do **not** attempt to score hidden chain-of-thought. They measure observable outcomes, tool/process success, and grader evidence. Future versions may add normalized tool-call counts and selected-skill events when the OpenCode JSON event schema is stable enough to parse without brittle assumptions.

## Interpretation

One passing trial is not a benchmark. Compare multiple trials on the same model and task set.

A useful comparison keeps constant:
- model and variant
- repository fixture
- prompt
- grader
- environment/runtime versions

The independent variable should be the UES harness.

Do not claim a model is equivalent to another model from this benchmark. Use it to measure whether UES improves task success, regression rate, recovery, verification, and cost for the tested workload.
