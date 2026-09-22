---
description: Resume an interrupted UES long-horizon work item from durable state, current Git evidence and the next dependency-safe task instead of reconstructing history from memory.
agent: build
---

Resume this UES work item: $ARGUMENTS

Read the matching `.ues-work/<slug>/SPEC.md`, `PLAN.json`, `STATE.json`, `EVIDENCE.json`, task reports and current Git status. Run `ocskill work resume <slug> .` and revalidate assumptions that may have gone stale.

Ignore a top-level `ues-work/` directory as official workflow state. Only `.ues-work/<slug>/` created/managed by `ocskill work` is canonical durable state.

Trust durable task state and Git evidence over conversational recollection. Respect the machine gates:
- if the plan is awaiting approval, run `ues-plan-checker` and record PASS with `ocskill work approve-plan`;
- resume failed/pending work from the last verified boundary;
- on OpenCode V2 prefer `ues.dispatch_task` for a fresh executor and configured model escalation;
- do not repeat completed tasks unless fresh evidence invalidates them;
- after all tasks complete, run `ues-integration-verifier`, record its verdict with `ocskill work verify-integration`, then finalize only after PASS and an unchanged workspace fingerprint.


V7 recovery additions:
- `ocskill work resume` automatically attempts stale-lease recovery before reporting ready work;
- use `ocskill work recover <slug> .` explicitly when inspecting an interrupted run;
- preserve the current runId when heartbeating/completing/failing an active task so a stale executor cannot accidentally fence a newer run;
- prefer receipt-backed verification for retried tasks so the resumed state is backed by observable command results.
