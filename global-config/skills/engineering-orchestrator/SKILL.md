---
name: engineering-orchestrator
description: Coordinate non-trivial engineering work by classifying scope, selecting focused skills, planning, delegating analysis, verifying evidence, and applying bounded retry/finish gates.
---

# Engineering Orchestrator

Use this as the process coordinator for non-trivial work.

1. Classify the task as small, standard, or complex by risk and blast radius.
2. Load process skills before domain skills, and keep the active set small.
3. Establish acceptance criteria and the verification needed to prove them.
4. Inspect enough repository context to plan real files and interfaces.
5. Implement in dependency order with verification after meaningful increments.
6. If a check fails, switch to diagnosis rather than stacking speculative fixes.
7. Before completion, run the evidence gate and inspect the final diff.

Read [routing.md](references/routing.md) when skill selection is ambiguous.
Read [verification-matrix.md](references/verification-matrix.md) before verifying medium/high-risk changes.
Read [retry-policy.md](references/retry-policy.md) when implementation or verification fails repeatedly.
Read [delegation.md](references/delegation.md) before using subagents or parallel analysis.
