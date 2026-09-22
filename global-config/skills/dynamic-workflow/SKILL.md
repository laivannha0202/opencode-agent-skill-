---
name: dynamic-workflow
description: Execute large fan-out engineering campaigns with an event-driven dependency DAG, bounded same-model workers, resource leases, isolated writers and transactional verification/integration.
---

# Dynamic Workflow

Do not spawn agents for work a deterministic script/tool can do. Do not fan out small serial tasks.

For a large task:
1. classify each unit as deterministic, LLM judgment, or visual judgment;
2. build an explicit dependency DAG and declare read/write file scope;
3. use one shared model across fresh worker sessions unless the user explicitly requests otherwise;
4. serialize resource conflicts and isolate independent writers in worktrees;
5. bound/adapt concurrency instead of spawning as many agents as possible;
6. integrate one verified result at a time and immediately unlock newly ready dependencies;
7. keep large intermediate results on disk/evidence references instead of relaying them through parent chat context.

Read [workflow.md](references/workflow.md) for campaign and recovery rules.
