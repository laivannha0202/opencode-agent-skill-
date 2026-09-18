---
name: engineering-orchestrator
description: Coordinate non-trivial engineering work by classifying scope, selecting focused skills, preserving reasoning state, planning, delegating analysis, verifying evidence, challenging assumptions, and applying bounded repair/finish gates.
---

# Engineering Orchestrator

Use this as the process coordinator for non-trivial work.

1. Classify the task as small, standard, or complex by risk and blast radius.
2. Load process skills before domain skills, and keep the active set small.
3. Establish observable acceptance criteria and the verification needed to prove them.
4. Inspect enough repository context to plan real files, interfaces, producers, and consumers.
5. For complex or interruption-prone work, maintain a compact fact/assumption/decision/rejected-hypothesis ledger rather than relying on conversational memory.
6. Implement in dependency order with verification after meaningful increments.
7. If a check fails, switch to diagnosis rather than stacking speculative fixes.
8. For substantial or high-risk behavior changes, run an independent critic pass that attempts to falsify assumptions and find counterexamples.
9. Repair only evidence-backed blocking findings, re-run affected verification, and bound critic/repair cycles.
10. Before completion, run the evidence gate, inspect the final diff, and disclose unresolved risks accurately.

Read [routing.md](references/routing.md) when skill selection is ambiguous.
Read [verification-matrix.md](references/verification-matrix.md) before verifying medium/high-risk changes.
Read [retry-policy.md](references/retry-policy.md) when implementation or verification fails repeatedly.
Read [delegation.md](references/delegation.md) before using subagents or parallel analysis.
Read [evaluator-loop.md](references/evaluator-loop.md) for the critic/repair/re-verify loop on substantial changes.
