# Dynamic workflow

Use ocskill workflow-plan PLAN.json to produce a bounded schedule.

Good fan-out units have independent inputs/outputs and clear ownership. Mechanical indexing, parsing, formatting, builds and test commands stay deterministic.

For LLM/vision units:
- pass one bounded context slice;
- write result/evidence to durable files;
- do not depend on sibling conversational output;
- verify task ownership before integration.

After each wave:
- ensure every expected result exists;
- integrate verified branches/worktrees;
- run combined verification;
- branch the next wave from the integrated state.

On restart, resume from .ues-work, evidence references and the last verified integrated state rather than replaying the entire conversation.
