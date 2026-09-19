---
description: Resume interrupted UES 7.7 work from durable state, recover stale executor leases, rebuild bounded context and continue from the next verified boundary.
agent: build
---

Resume this UES work item: $ARGUMENTS

Read the matching `.ues-work/<slug>/SPEC.md`, `PLAN.json`, `STATE.json`, `EVIDENCE.json`, `EVENTS.jsonl`, task reports, receipts and current Git status. Run `ocskill work resume <slug> .`; it recovers expired running-task leases before reporting ready work.

Trust durable task state, structured receipts and Git evidence over conversational recollection. Revalidate assumptions that may have gone stale.

Respect the machine gates:
- if the plan is awaiting approval, run `ues-plan-checker` and record PASS with `ocskill work approve-plan`;
- if a running task has an expired lease, let resume/recover mark it failed and retry from fresh evidence;
- resume failed/pending work from the last completed, receipt-backed boundary;
- on capable OpenCode runtimes prefer `ues.dispatch_task` for a fresh executor and adaptive model escalation;
- run task verification through `ocskill work check` so the new attempt has a current structured receipt;
- do not repeat completed tasks unless current Git evidence invalidates them;
- after all tasks complete, run fresh integration checks through `ocskill work check <slug> __integration__ . -- ...`, run `ues-integration-verifier`, record its verdict, then finalize only after PASS and an unchanged workspace fingerprint.
