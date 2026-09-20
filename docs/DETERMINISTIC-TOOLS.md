# Deterministic evidence and execution tools

UES 8 uses dependency-light Node helpers for work that should not rely on a model guessing or remembering it.

## Repository evidence

```cmd
ocskill inspect .
ocskill detect-stack .
ocskill detect-tests .
ocskill impact calculateOrderTotal .
ocskill evidence .
ocskill working-tree .
```

These identify stack/package manager, project-native checks, bounded impact hits and Git state.

## Repository graph

```cmd
ocskill repo-graph .
```

Builds a bounded import graph, local edges, external import frequencies and coupling hotspots. It is not a full language server/call graph.

## Review scope

```cmd
ocskill review-scope main .
```

Enumerates changed files and deterministic risk hints for persistence/schema, auth/security, payments, public interfaces, dependencies and delivery/infrastructure.

`coverageRequired` lets a reviewer account for every changed file instead of relying on memory.

## Verification plan

```cmd
ocskill verification-plan .
```

Combines project-native commands, working-tree evidence and changed-file risk into recommended checks plus risk-specific acceptance prompts.

## Task graph

```cmd
ocskill task-graph PLAN.json
```

Validates plan shape/dependencies/cycles and computes topological and safe waves. Same-wave tasks with overlapping/unknown declared files are serialized.

## Durable work state

```cmd
ocskill work init <slug> . --goal "..."
ocskill work plan <slug> PLAN.json .
ocskill work gate-receipt <slug> plan . --verifier ues-plan-checker --evidence "PASS" --out .ues-work/<slug>/reports/plan-receipt.json
ocskill work approve-plan <slug> . --evidence "PASS" --receipt-file .ues-work/<slug>/reports/plan-receipt.json
ocskill work start <slug> T1 .
ocskill work verify-command <slug> T1 . --run-id <run-id> -- npm test
ocskill work complete <slug> T1 . --run-id <run-id> --evidence "verified"
ocskill work fail <slug> T1 . --reason "..."
ocskill work gate-receipt <slug> integration . --verifier ues-integration-verifier --verdict PASS --evidence "PASS" --out .ues-work/<slug>/reports/integration-receipt.json
ocskill work verify-integration <slug> . --verdict PASS --evidence "PASS" --receipt-file .ues-work/<slug>/reports/integration-receipt.json
ocskill work finalize <slug> . --evidence "final acceptance verified"
ocskill work events <slug> . --limit 100
ocskill work resume <slug> .
```

State/evidence writes use a per-item lock and atomic replacement. `EVENTS.jsonl` is append-only runtime evidence. Long/high-risk tasks require successful receipts for the active run and current workspace fingerprint.

## Context pack

```cmd
ocskill context-pack <slug> <task> .
```

Returns the task, bounded spec, dependency reports, decisions, blockers, current task state and Context Manifest v3: declared files, import neighbors, likely tests, nearby instructions, Git-changed files, task-term relevance, symbol hits, centered excerpts and promoted lessons.

## Runtime dispatch on OpenCode V2

The managed plugin exposes `ues.dispatch_task`, which combines `work start`, context pack, model policy and a fresh OpenCode executor session with heartbeat, bounded wait and interrupt-on-timeout. It also exposes runtime cancellation/recovery helpers when the OpenCode session API supports them.

## Sandboxes and learning

```cmd
ocskill sandbox create <slug> <task-id> .
ocskill sandbox integrate <worktree-path> .
ocskill sandbox list .
ocskill learn analyze . --eval-dir .ues-evals
ocskill learn accept <proposal-id> .
ocskill learn promote <proposal-id> . --baseline 0.50 --candidate 0.75 --samples 4
```

Sandbox integration refuses overlap with dirty root files. Shadow-required learning proposals are not retrieved until a measured benchmark improvement is recorded.

## Constraints

These helpers:

- do not replace reading exact affected code
- do not pretend text/import scans are complete semantic analysis
- do not auto-merge/push/publish/deploy
- preserve unrelated user work
- use JSON outputs where machine consumption matters
