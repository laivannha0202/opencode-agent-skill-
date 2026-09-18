# Delegation guide

Subagents are useful when isolated context improves analysis. They are overhead when the task is tiny.

Good delegation:
- independent repository research
- architecture/blast-radius mapping
- root-cause investigation
- final read-only review
- independent verification planning or execution

Keep inline:
- one-file obvious edits
- tasks where delegation would duplicate the same reads
- sequential work where each step depends on the previous edit

Rules:
- do not ask multiple agents to edit the same working tree concurrently
- give each agent a narrow question and concrete scope
- prefer read-only subagents for review/research/verification
- verify subagent claims against repository state or command output
- the parent integrates results and owns the final completion claim
