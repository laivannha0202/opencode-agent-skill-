# Software architecture workflow

Architecture work starts with constraints, not preferred patterns.

Map:
- entry points and responsibility ownership
- data/control flow and state ownership
- public/internal contracts
- persistence and external side effects
- failure boundaries, retries and observability
- deployment/migration compatibility
- existing extension seams and nearest working analogues

Evaluate options by change surface, coupling, reversibility, operational risk, testability and fit with current code. Prefer an incremental seam over a rewrite when both satisfy the requirement.

Call out assumptions that require repository or production evidence. Do not introduce a service, queue, abstraction layer or generic framework solely for theoretical future scale.

A useful architecture recommendation includes the smallest viable direction, material rejected alternatives, rollout/rollback concerns and concrete verification needed before declaring the design safe.
