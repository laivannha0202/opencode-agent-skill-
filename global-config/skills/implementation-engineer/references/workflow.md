# Implementation workflow

Start from observable acceptance criteria and the smallest repository-compatible design.

Before editing:
- identify the real entry point, nearest working analogue and direct callers/consumers
- map public contracts, persisted state and validation touched by the change
- choose the smallest coherent file set and define how behavior will be proven

During implementation, preserve existing abstractions unless they are the cause of the problem. Update coupled types, validation, serialization, UI states, tests and docs only where the changed contract requires them. Handle failure paths and cleanup alongside the happy path.

Avoid placeholder logic, silent catch-all fallbacks and speculative refactors.

After each meaningful increment, run the narrowest behavior-matched check. Before completion, inspect the full diff, re-run acceptance behavior, check accidental files and use independent review/critic for substantial or risky changes.
