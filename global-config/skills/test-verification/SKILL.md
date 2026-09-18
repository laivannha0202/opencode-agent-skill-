---
name: test-verification
description: Prove engineering claims with fresh project-native tests, type checks, lint, builds, reproductions, contract checks, and final-diff inspection; never report success from expectation alone.
---

# Test Verification

Verification must match the claim.

1. Identify the observable acceptance criterion or original failure.
2. Choose the narrowest project-native check that proves it.
3. Run the check fresh and read the actual output and exit status.
4. Expand verification based on blast radius: adjacent tests, typecheck, lint, affected build, integration or contract checks, or the full suite when justified.
5. Re-test the original behavior, not only compilation.
6. Inspect the final diff and working tree for accidental changes.
7. Report passed, failed, and not-run checks separately.

For bug regressions, a strong test demonstrates that it can fail when the fix is absent where practical. For configuration or migration changes, verify the resulting behavior or state rather than only syntax.

Do not weaken valid tests, hide warnings that indicate real failure, or claim "done", "fixed", "passes", "builds", or "deployed" without fresh evidence.
