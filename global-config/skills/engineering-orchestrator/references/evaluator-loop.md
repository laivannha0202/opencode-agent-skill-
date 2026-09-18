# Evaluator and repair loop

Use this loop for substantial behavior changes, risky fixes, public contracts, auth/security, payments, migrations, or work where a hidden regression would be costly.

1. **Implement** the smallest coherent change.
2. **Self-check** the diff against each observable acceptance criterion.
3. **Verify** the narrowest behavior that proves the change.
4. **Critic pass**: use an independent read-only critic/reviewer to search for counterexamples and unsupported assumptions.
5. **Repair** only evidence-backed blocking findings.
6. **Re-verify** the exact checks affected by the repair, then any broader checks justified by blast radius.
7. **Re-critic** only when the repair materially changed logic, contracts, permissions, persistence, concurrency, or failure behavior.

Bound the loop:
- at most two repair cycles from critic findings before pausing for a fresh root-cause/architecture review
- do not churn code to satisfy speculative or style-only feedback
- unresolved blocking findings must be fixed or explicitly surfaced; they cannot be silently converted into "done"

The critic is a falsification step, not an authority. Repository state, tests, contracts, and runtime evidence remain the source of truth.
