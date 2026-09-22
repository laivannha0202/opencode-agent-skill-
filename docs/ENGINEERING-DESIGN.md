# UES engineering design

V11 evolves the project from an engineering workflow harness into a **perception-aware adaptive execution engine** designed to reduce context pressure on coding models while keeping evidence needed for correctness.

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

The catalog spans 48 skills. UES prefers a small active skill set and loads deeper references only when needed.

### Hard gates, not reminders

V11 machine-enforces the important boundaries:

1. long/high-risk plans are not executable until a structured plan-verification receipt matches the current plan hash;
2. long/high-risk task completion requires a successful verification receipt for the active run and the current workspace fingerprint;
3. durable state/evidence mutations are serialized with a per-work-item lock and atomic replacement;
4. integration PASS for strict work requires a structured integration receipt bound to the current workspace fingerprint;
5. finalization requires PASS and rejects any later workspace change.

These checks do not depend on a model remembering an instruction.

## Long-task state model

```text
.ues-work/<slug>/
  SPEC.md
  PLAN.json
  STATE.json
  EVIDENCE.json
  EVENTS.jsonl
  tasks/
  reports/
```

The state contains operational facts only: task status, attempts, decisions, blockers, approvals and evidence. It is not chain-of-thought.

`PLAN.json` is validated for task IDs, dependencies, cycles, acceptance criteria, verification and risk. Safe waves serialize overlapping or unknown declared file scopes.

## Fresh-context execution

On OpenCode V2, the managed plugin exposes `ues.dispatch_task`.

It:

1. calls the state engine to start one ready task;
2. obtains the bounded Context Manifest v3 pack;
3. resolves the configured model tier for the executor attempt;
4. optionally isolates a concurrent writer in a Git worktree;
5. creates a fresh OpenCode session rooted at the execution directory;
6. binds the session ID to the durable lease;
7. switches to `ues-executor` and optionally to the configured model;
8. prompts exactly the approved task;
9. heartbeats while waiting under a bounded timeout;
10. interrupts the child on timeout/cancel and returns a bounded report.

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

1. **static skill contract** — 43 scenarios covering the 48-skill catalog;
2. **V2 router precision matrix** — 120 required-route/negative-guard cases;
3. **standard live benchmark** — 20 executable hidden-graded tasks;
4. **long-horizon benchmark** — 5 tasks, including one 15-source-file integration workload;
5. **polyglot benchmark** — 8 tasks spanning Python, Java, .NET, Next.js, React Native, SQL migration, monorepo boundaries and generated contracts;
6. **matrix runner** — baseline vs UES across multiple suites/trials with coverage validation.

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


## V7.7 intelligence runtime additions

V7 adds four control loops around the V6 state machine:

1. **runtime reliability** — task attempts carry run fencing, heartbeats and leases; expired `running` state can be recovered after process/session interruption;
2. **evidence binding** — verification commands can emit structured receipts containing exit status, output digests and before/after workspace fingerprints;
3. **context intelligence** — fresh executors receive a bounded manifest of declared files, import neighbors, likely tests, instruction/manifests and accepted learnings;
4. **adaptive policy + learning** — deterministic task risk/complexity influences workflow/model tier and eval traces can produce explicit learning proposals.

Parallelism is now read/write aware. Read/read overlap can share a wave; writers serialize against readers/writers unless the parent intentionally moves them into isolated Git worktree sandboxes.

The V2 plugin probes actual session capabilities before dispatch rather than treating a major version number as sufficient proof that every runtime API exists.

Hermes is deliberately adapter-only. UES can detect Hermes and generate a bounded task handoff, but does not embed Hermes' runtime, memory, scheduler or gateway into core.

## V8 intelligence and reliability additions

V8 adds six control loops around the V7 runtime:

1. **hard evidence binding** — structured plan/integration receipts plus current-workspace task receipts;
2. **bounded executor lifecycle** — session binding, timeout interrupt, cancellation and task-scoped recovery;
3. **event sourcing for observability** — append-only `EVENTS.jsonl` alongside snapshot state;
4. **context manifest v3** — Git-change awareness, symbol hits, TF-IDF-style ranking and centered excerpts;
5. **safe parallel integration** — isolated worktrees with dirty-root conflict refusal and UES-only branch cleanup;
6. **benchmark-gated learning** — clustered proposals require explicit acceptance and measured shadow improvement before retrieval.

The local Control Center remains a safe local observer/controller. It can inspect receipts/events and request stale recovery, but it does not bypass plan, verification, safety or finalization gates and does not directly own OpenCode sessions.
