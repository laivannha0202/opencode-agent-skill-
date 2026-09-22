---
name: dynamic-workflow
description: Plan large fan-out engineering campaigns into bounded dependency-safe waves, separating deterministic work from LLM judgment, limiting concurrency, isolating writers and verifying integrated results before the next wave.
---

# Dynamic Workflow

Do not spawn agents for work a deterministic script/tool can do. Do not fan out small serial tasks.

For a large task:
1. classify each unit as deterministic, LLM judgment, or visual judgment;
2. build dependency-safe waves;
3. serialize overlapping writers and isolate independent writers;
4. bound concurrency by provider/machine capacity;
5. keep large intermediate results on disk/evidence references;
6. integrate and verify each wave before later waves branch from it.

Read [workflow.md](references/workflow.md) for campaign and recovery rules.
