---
description: Resume an interrupted durable UES work item on Pi from filesystem and Git evidence.
---

Resume this UES work item: $@

Treat only `.ues-work/<slug>/` as canonical durable UES state. Read SPEC, PLAN, STATE, EVIDENCE, task reports and current Git status. Use `ues_cli` with `["work","resume","<slug>","."]` (and `work recover` when needed) before deciding the next dependency-safe action.

Trust durable state and current repository evidence over conversational recollection. Do not repeat completed tasks unless fresh evidence invalidates them. Use `ues_dispatch` for fresh executor/verifier context. Parallel writers require distinct isolated cwd/worktrees. After all tasks complete, use a fresh `ues-integration-verifier`, record the integration result through `ues_cli`, and finalize only after PASS with an unchanged workspace fingerprint.
