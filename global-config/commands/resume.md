---
description: Resume an interrupted UES long-horizon work item from durable state, current Git evidence and the next dependency-safe task instead of reconstructing history from memory.
agent: build
---

Resume this UES work item: $ARGUMENTS

Read the matching `.ues-work/<slug>/SPEC.md`, `PLAN.json`, `STATE.json`, `EVIDENCE.json`, task reports and current Git status. Run `ocskill work resume <slug> .` and revalidate assumptions that may have gone stale.

Trust durable task state and Git evidence over conversational recollection. Do not repeat tasks already marked completed unless fresh evidence proves their result is invalid. Resume failed/running work from its last verified boundary. Execute remaining tasks through fresh `ues-executor` contexts and finish with independent integration verification.
