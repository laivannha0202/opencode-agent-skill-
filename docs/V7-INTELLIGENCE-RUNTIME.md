# UES 7.7 intelligence runtime

UES 7.7 strengthens long-running coding work around seven layers: runtime reliability, evidence, context, orchestration, isolation, learning, interoperability and observability.

## V7.0 — Runtime reliability

Every started task receives:

- `runId`
- `heartbeatAt`
- `leaseExpiresAt`
- optional `ownerSession`

A fresh dispatcher refreshes the lease while the child session is alive. `ocskill work resume` calls stale-run recovery before presenting the next state. Expired running tasks move to `failed` with explicit recovery evidence instead of remaining stuck forever.

`EVENTS.jsonl` records durable state transitions such as initialization, plan import/approval, task start/failure/completion, stale recovery, verification receipts and finalization.

Live model evals use an asynchronous process runner with:

- heartbeat/progress callbacks
- hard timeout
- idle timeout
- cancellation metadata
- bounded stdout/stderr capture
- Windows command-shim handling

## V7.1 — Evidence engine

Narrative evidence is useful context but is not a machine proof. New CLI-created work items therefore default to structured verification receipts.

Use:

```text
ocskill work check <slug> <task-id> . -- <command> [args...]
ocskill work check <slug> __integration__ . -- <command> [args...]
```

Each receipt stores:

- command
- exit code / PASS
- start/finish/duration
- stdout and stderr SHA-256
- workspace fingerprint
- active run ID when applicable
- executor session ID when supplied
- timeout/cancellation state

When strict evidence is active, task completion requires a passing receipt for the active run and current workspace. Integration PASS requires a current passing integration receipt.

The library API remains backward compatible for callers that initialize work without strict evidence.

## V7.2 — Context intelligence

`context-pack` now adds `contextManifest` containing:

- declared files
- local dependency neighborhood from the repository graph
- likely relevant tests
- coupling hotspots
- bounded source excerpts
- graph truncation/scanning metadata

The manifest reduces repeated rediscovery but is deliberately bounded and advisory. Executors still read exact affected code and repository instructions.

## V7.3 — Adaptive orchestrator

Execution policy scores observable signals:

- task risk
- declared file count
- context size
- attempt number
- failure class

It recommends:

- minimum model tier
- hard timeout
- idle timeout
- heartbeat interval
- max attempts
- whether isolated execution is appropriate

The configured provider/model mapping remains user-owned. UES raises a minimum tier only from evidence and never invents model IDs.

## V7.4 — Isolated parallel execution

Safe-wave scheduling now distinguishes:

- read/read overlap — may execute together
- write/read overlap — serialize
- write/write overlap — serialize
- unknown scope — conservative serialization

For higher-risk parallel work, UES can create detached Git worktrees outside the repository:

```text
ocskill sandbox create <slug> <task> .
ocskill sandbox status <slug> <task> .
ocskill sandbox diff <slug> <task> .
ocskill sandbox apply <slug> <task> .
ocskill sandbox remove <slug> <task> .
```

Sandbox creation requires a clean integration worktree. Applying changes uses a three-way Git patch so integration conflicts are explicit rather than silently overwritten.

## V7.5 — Learning engine

`ocskill learn .` scans local `.ues-evals/*.json` and groups observable outcomes into proposal categories such as:

- runtime exit
- orchestration adherence
- behavior correctness
- telemetry compatibility
- latency budget
- success pattern

Output is written under `.ues-learning/PROPOSALS.json`.

Learning is intentionally proposal-only. It never edits production skills or enables new rules automatically. A proposal should first become a regression test/eval, then a deliberate code or guidance change.

## V7.6 — Hermes bridge

Hermes Agent is treated as an optional peer runtime, not embedded into UES.

```text
ocskill hermes status
ocskill hermes handoff <slug> <task-id> .
```

A handoff carries approved task/spec/context/dependency information and constraints. UES remains the source of truth for PLAN, STATE, EVIDENCE and final completion gates.

## V7.7 — Control Center

```text
ocskill dashboard .
```

starts a local, read-only HTTP dashboard on `127.0.0.1:4317` by default. It refreshes:

- work-item status
- task attempts/status
- blockers
- plan/integration gates
- recent event-log entries
- eval summaries
- learning proposals

The first version is intentionally read-only. Mutating state remains CLI/runtime controlled so the UI cannot silently bypass machine gates.

## Capability-aware OpenCode support

UES still distinguishes V1 resource compatibility from V2 plugin installation, but live command invocation now probes actual CLI capabilities. The V2 plugin also registers fresh-session dispatch only when the required session methods are present.

This reduces breakage when a runtime version and its actual exposed API surface do not perfectly match.

## Completion invariant

For strict V7.7 work, truthful completion is:

```text
approved plan
+ completed dependency-safe tasks
+ no blockers
+ current passing structured task receipts
+ fresh integration receipt
+ integration verifier PASS
+ unchanged post-verification workspace
= finalizable
```
