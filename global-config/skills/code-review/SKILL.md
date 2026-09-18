---
name: code-review
description: Review changed code for real defects and regressions with context-aware evidence, prioritizing correctness, data loss, security, contracts, state/races, performance, and missing verification over style noise.
---

# Code Review

Review the actual diff and enough surrounding context to validate each finding.

Prioritize:
1. correctness, data loss, and broken invariants
2. security, authentication, and permission boundaries
3. API, schema, type, and compatibility mismatches
4. error handling, edge cases, races, and state bugs
5. plausible performance regressions
6. maintainability problems that create concrete risk
7. missing or misleading verification

For each material finding include the location, evidence, impact, and a practical fix direction. Distinguish confirmed defects from risks or uncertainty. Check callers or contracts before asserting an issue. Prefer a few high-signal findings over speculative volume. Do not nitpick formatting already enforced by tooling.
