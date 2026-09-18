# Writing useful tests

A useful test protects an observable behavior.

Before writing it, answer:
- what production change would make this test fail?
- does the assertion come from the requirement/contract rather than copying the implementation?
- can the test exercise real code instead of only a mock?
- is one behavior being tested clearly?

Prefer:
- stable public behavior over private implementation details
- small deterministic fixtures
- explicit edge cases that caused the bug
- failure messages that explain the violated behavior

Avoid:
- assertions that only check text/source presence when runtime behavior matters
- mocks that reproduce the implementation's own mistake
- snapshots for logic that deserves explicit assertions
- tests that pass before the behavior exists without explaining why
