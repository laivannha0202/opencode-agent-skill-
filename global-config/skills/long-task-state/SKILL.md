---
name: long-task-state
description: Preserve confirmed facts, assumptions, rejected hypotheses, decisions, progress, blockers, next actions, and verification for large or interruptible engineering tasks so work resumes without reconstructing or repeating reasoning.
---

# Long Task State

Use for work likely to span many steps, context compaction, or multiple sessions.

Prefer session-native task tracking for ordinary work. For an explicitly requested long-horizon run (for example `/ues-run`), use the deterministic `.ues-work/<slug>/` workspace managed by `ocskill work`. For ad-hoc persistence outside that explicit workflow, ask before adding repository-level state.

The V6 long-horizon workspace keeps `SPEC.md`, `PLAN.json`, `STATE.json`, `EVIDENCE.json`, task briefs, and reports. For smaller persistent notes that do not need task execution state, the concise [STATE.md](templates/STATE.md) ledger remains suitable.

Update it only at meaningful boundaries:
- acceptance criteria changed
- a fact or assumption materially changed the plan
- a hypothesis was disproved
- an architecture/implementation decision was made
- a work unit completed
- verification produced new evidence
- a blocker or risk appeared
- the next resumable action changed

Read [context-ledger.md](references/context-ledger.md) for the distinction between confirmed facts, assumptions, rejected hypotheses, and decisions.

On resume, read the state file plus current Git diff/status before acting. Revalidate assumptions that may have gone stale. Treat recorded success as historical evidence; rerun verification when a fresh completion claim depends on it.

Do not store secrets, hidden chain-of-thought, raw logs, or large copied source files in task state. Store concise evidence and decisions that another session can act on.
