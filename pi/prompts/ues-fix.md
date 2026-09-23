---
description: Fix a verified bug with UES diagnosis, bounded implementation and fresh verification.
---

Fix this problem: $@

First establish the failure and root-cause evidence. For non-trivial bugs, use `ues_dispatch` as a chain: `ues-debugger` to diagnose, `ues-executor` to implement the smallest supported fix, then `ues-verifier` to independently verify. Pass prior output with `{previous}` where useful.

Do not stack speculative fixes. Preserve unrelated changes. Run the exact failing check again and then affected checks. Do not push, publish, deploy or perform destructive operations without explicit approval.
