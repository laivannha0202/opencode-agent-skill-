---
description: Diagnose a failure from reproducible evidence before applying a bounded fix.
---

Debug this problem: $@

Reproduce or capture the exact failure first. Use `ues_cli` for deterministic repo/test evidence and `ues_dispatch` with `ues-debugger` when fresh context helps. Trace where the state/value first becomes wrong, test one causal hypothesis at a time, and avoid speculative patch stacking.

If a code change is requested, make the smallest supported fix and verify the original failure plus affected checks. Preserve unrelated user changes.
