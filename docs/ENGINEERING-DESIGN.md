# UES engineering design

UES 6 evolves the project from an engineering workflow harness into a **long-horizon execution engine** designed to reduce context pressure on coding models.

The selected model remains the selected model. UES improves orchestration, evidence, task boundaries, state persistence and verification; it does not claim model equivalence.

## Core design

### Thin orchestrator, durable artifacts, fresh workers

For long work:

```text
main/orchestrator
  ↓
SPEC + PLAN + STATE
  ↓
fresh executor per approved task
  ↓
task report + evidence
  ↓
integration verifier
```

Conversation history is not the source of truth. Durable artifacts are.

### Deterministic facts before probabilistic reasoning

UES moves cheap/reliable work into code:

- stack/test-command discovery
- repository import graph
- bounded impact search
- Git state
- changed-file review coverage
- risk hints
- verification recommendations
- task dependency validation
- safe-wave scheduling
- persistent work state
- completion gates

Models still reason about semantics and read affected code.

### Progressive disclosure

The catalog remains 39 skills. UES prefers a small active skill set and loads deeper references only when needed.

### Hard gates, not reminders

Three V6 gates are machine-enforced:

1. imported plans are not executable until plan-checker PASS is recorded;
2. durable mutations are serialized with a per-work-item lock and atomic replacement;
3. finalization requires integration PASS and an unchanged workspace fingerprint.

These checks do not depend on a model remembering an instruction.

## Long-task state model

```text
.ues-work/<slug>/
  SPEC.md
  PLAN.json
  STATE.json
  EVIDENCE.json
  tasks/
  reports/
```

The state contains operational facts only: task status, attempts, decisions, blockers, approvals and evidence. It is not chain-of-thought.

`PLAN.json` is validated for task IDs, dependencies, cycles, acceptance criteria, verification and risk. Safe waves serialize overlapping or unknown declared file scopes.

## Fresh-context execution

On OpenCode V2, the managed plugin exposes `ues.dispatch_task`.

It:

1. calls the state engine to start one ready task;
2. obtains the bounded context pack;
3. resolves the configured model tier for the executor attempt;
4. creates a fresh OpenCode session;
5. switches to `ues-executor`;
6. optionally switches to the configured model;
7. prompts exactly the approved task;
8. waits and returns child-session context.

The parent is still responsible for inspecting the child diff and recording completion/failure evidence.

## Model escalation

Roles map to `light`, `standard`, or `heavy`. Attempt number can raise a role one tier up to the configured cap. Model IDs are always user-configured; UES never invents provider/model identifiers.

Escalation follows evidence, not panic:

```text
attempt 1 fails
→ diagnose
→ fresh retry
→ stronger tier if configured
→ repeated causal failure
→ re-plan / architecture review
```

## OpenCode runtime

### V1

Uses compatible file-based skills, commands and agents. V2-only plugin behavior is not installed.

### V2

The managed plugin uses current V2 domains for:

- prompt admission skill routing
- model-context guardrails
- permission evaluation
- custom tools
- fresh session creation
- agent/model switching
- session waiting

Only UES-managed resources are rewritten/removed.

## Evaluation architecture

UES separates:

1. **static skill contract** — 34 scenarios covering the 39-skill catalog;
2. **V2 router precision matrix** — 120 required-route/negative-guard cases;
3. **standard live benchmark** — 20 executable hidden-graded tasks;
4. **long-horizon benchmark** — 5 tasks, including one 15-source-file integration workload.

For long-suite UES mode, final behavior alone is insufficient. A PASS also requires a completed durable work item with plan approval, at least two tasks, attempted/completed task records, integration PASS and finalization evidence.

This prevents a strong model from bypassing the architecture and still being counted as proof that the long-horizon engine worked.

## Package lifecycle and release safety

npm owns package installation. UES owns only its marked/namespaced OpenCode resources.

CI validates syntax, resource contracts, routing, hidden graders, unit tests, package contents and packed global installation. Update logic resolves npm's explicit `latest` tag and refuses accidental downgrade.

## Deliberate limits

UES deliberately avoids:

- hundreds of agents/tools
- loading every skill
- treating keyword routing as truth
- hidden chain-of-thought storage
- automatic merge/push/publish/deploy
- claiming success without fresh evidence
- claiming that one benchmark proves general model equivalence

The target is a small number of strong control loops: correct context, small tasks, durable state, deterministic checks and independent verification.
