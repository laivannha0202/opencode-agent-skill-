---
name: long-task-state
description: Preserve decisions, progress, blockers, next actions, and verification for large or interruptible engineering tasks so work can resume without reconstructing context.
---

# Long Task State

Use for work likely to span many steps or sessions.

Prefer session-native task tracking for ordinary work. If persistent repository state would materially help, ask before adding a project-level `.ues/` directory.

When persistence is appropriate, keep one concise `.ues/STATE.md` using [STATE.md](templates/STATE.md). Update it only at meaningful boundaries:
- acceptance criteria changed
- a decision was made
- a work unit completed
- verification produced new evidence
- a blocker appeared
- the next resumable action changed

On resume, read the state file plus the current Git diff/status before acting. Treat recorded success as historical evidence; rerun verification when a fresh completion claim depends on it.

Do not store secrets, raw logs, or large copied source files in task state.
