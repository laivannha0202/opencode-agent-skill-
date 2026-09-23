---
description: Review code for correctness, regressions, security, and verification gaps without editing.
argument-hint: "[scope]"
---

Review this code/work without editing: $ARGUMENTS

Inspect the actual diff and relevant surrounding code. Prioritize concrete correctness bugs, regressions, security or data-integrity issues, broken contracts, missing error handling, and verification gaps. Use a read-only `ues_fresh_agent` for an independent second pass when useful. Report findings with file/line evidence and avoid style-only noise unless it creates real risk.
