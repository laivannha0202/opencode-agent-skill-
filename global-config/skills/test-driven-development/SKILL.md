---
name: test-driven-development
description: Use a pragmatic red-green-refactor loop for behavior changes and bug fixes when the repository has a practical test harness or a focused regression test can reasonably be added.
---

# Test-Driven Development

Prefer behavior-first tests when they will provide durable evidence.

1. Define one observable behavior or regression.
2. Write the smallest test that would fail if the desired behavior is absent.
3. Run it and confirm it fails for the intended reason, not because the test is broken.
4. Implement the minimum coherent production change.
5. Re-run the focused test until green.
6. Run adjacent regression checks.
7. Refactor only while tests stay green.

Do not test implementation trivia merely to satisfy the ritual. Avoid mocks when real behavior is cheap and stable to exercise.

TDD may be inappropriate for generated files, documentation/config-only changes, throwaway prototypes, or repositories with no practical harness. In those cases, use the strongest realistic verification instead and state the limitation.

Read [writing-good-tests.md](references/writing-good-tests.md) when adding or changing tests.
