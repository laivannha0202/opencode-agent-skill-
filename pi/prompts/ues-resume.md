---
description: Resume interrupted UES work from durable state and current repository evidence.
argument-hint: "<slug>"
---

Resume UES work item: $ARGUMENTS

Read `.ues-work/<slug>/SPEC.md`, `PLAN.json`, `STATE.json`, `EVIDENCE.json`, reports, events, and current Git status. Run `ocskill work resume <slug> .` and recover stale leases if needed.

Trust durable state and Git evidence over conversational recollection. Continue only dependency-ready incomplete work. Use `ues_fresh_agent` for a fresh verifier or a bounded task when isolation materially helps. Re-run integration verification if the workspace changed after the last PASS. Finalize only after all tasks are complete and current evidence passes.
