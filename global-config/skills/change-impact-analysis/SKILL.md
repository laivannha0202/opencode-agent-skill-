---
name: change-impact-analysis
description: Map the blast radius of cross-module, public-contract, schema, auth, payment, migration, or shared-library changes before editing and before final review.
---

# Change Impact Analysis

For changes that cross a boundary, identify both producers and consumers. If `ocskill` is available, use `ocskill impact <term>` as a bounded evidence pass, then validate important matches with exact repository reads/callers.

Map:
- entry point and changed contract
- direct callers/importers/clients
- persisted data or schema assumptions
- validation/error behavior
- configuration/environment dependencies
- tests/fixtures/mocks
- generated code or documentation
- compatibility, migration, and rollback concerns

Before editing, identify the smallest safe boundary for the change.
After editing, inspect the diff and re-run the map: confirm every affected consumer was either updated, proven compatible, or explicitly left unchanged for a reason.

Do not infer "no impact" merely because compilation succeeds.
