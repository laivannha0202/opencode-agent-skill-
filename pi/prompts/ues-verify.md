---
description: Verify requested behavior with fresh evidence and no unsupported completion claims.
---

Verify this engineering work: $@

Start from the acceptance criteria and the actual current diff/status. Prefer the narrowest project-native checks that prove the claim, then expand according to blast radius. Use `ues_cli` for deterministic UES evidence/receipt commands and `ues_dispatch` with `ues-verifier` or `ues-integration-verifier` for independent fresh context.

Do not edit merely to make verification pass unless the user asked for a fix. Report failed checks, skipped checks, unresolved gaps, and exactly what the evidence proves.
