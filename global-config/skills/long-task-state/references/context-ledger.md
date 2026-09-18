# Context ledger

For long, complex, or interruption-prone work, preserve reasoning state compactly instead of preserving the whole conversation.

Track four different kinds of knowledge:

## Confirmed facts
Repository or runtime facts with evidence, such as paths, symbols, commands, outputs, versions, and contracts.

## Assumptions
Claims currently used for planning that are not yet proven. Include confidence and the cheapest way to verify each one.

## Rejected hypotheses
Failed debugging or design hypotheses and the evidence that rejected them. This prevents a resumed session from retrying already-disproved ideas.

## Decisions
Chosen implementation/architecture decisions, material alternatives considered, and the evidence or constraint that justified the choice.

Also keep:
- acceptance criteria and their current status
- a compact producer/consumer or boundary map when cross-module behavior matters
- changed files and why they changed
- fresh verification evidence with timestamps or run order
- unresolved risks/blockers
- exactly one resumable next action

Keep the ledger concise. Link to files and commands rather than copying source or raw logs. Historical verification is context, not proof for a new completion claim; rerun checks when freshness matters.
