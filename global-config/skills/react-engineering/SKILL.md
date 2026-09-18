---
name: react-engineering
description: Work on React apps using existing component, hooks, state, routing, data fetching, forms, performance, and testing conventions while preserving rendering and state invariants.
---

# React Engineering

Detect React/framework version and the repository's component, state, routing, form, data-fetching, styling, and test conventions before editing.

Prefer render-time derivation over duplicated state. Use effects for synchronization with external systems, not as a default data-flow mechanism. Preserve stable identity, ownership boundaries, controlled/uncontrolled form semantics, loading/empty/error states, and accessibility.

Before performance changes, identify the actual render/data hot path rather than adding memoization mechanically.

Read [workflow.md](references/workflow.md) for state/effect diagnosis, async race checks, rendering invariants, forms, and verification.
