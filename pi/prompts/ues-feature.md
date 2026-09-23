---
description: Implement a feature through adaptive UES planning, bounded edits and evidence-backed verification.
---

Implement this feature: $@

Use the same adaptive admission rules as `/ues-run`. Determine scope with `ues_cli task-policy`; avoid durable state for small work and use `.ues-work/<slug>/` for long/high-risk work. For complex changes, use a fresh `ues-architect` or `ues-plan-checker` before implementation, then `ues-executor` and `ues-verifier`.

Keep changes file-aware and dependency-aware, preserve existing contracts unless the requirement changes them, and finish with fresh tests plus final diff/status evidence.
