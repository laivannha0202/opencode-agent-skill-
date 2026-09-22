# Dynamic workflow

Use `ocskill workflow-plan PLAN.json` for deterministic preview, but on OpenCode V2 prefer `ues.dispatch_parallel` for actual event-driven execution when multiple dependency-ready tasks can run safely.

Good fan-out units have independent inputs/outputs and clear ownership. Mechanical indexing, parsing, formatting, builds and test commands stay deterministic.

For LLM/vision units:
- pass one bounded context slice;
- write result/evidence to durable files;
- do not depend on sibling conversational output;
- verify task ownership before integration.

During execution:
- keep one shared model across worker/verifier sessions unless explicitly overridden;
- isolate writers and hold resource leases until verification plus integration completes;
- independently verify each task result;
- integrate one accepted worktree transactionally;
- record deterministic verification commands when the plan provides them;
- immediately schedule dependencies unlocked by that completed task rather than waiting for unrelated siblings.

On restart, resume from .ues-work, evidence references and the last verified integrated state rather than replaying the entire conversation.
