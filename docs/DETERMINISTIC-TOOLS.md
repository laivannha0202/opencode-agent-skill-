# Deterministic evidence and execution tools

UES 6 uses dependency-light Node helpers for work that should not rely on a model guessing or remembering it.

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
ocskill work approve-plan <slug> . --evidence "..."
ocskill work start <slug> T1 .
ocskill work complete <slug> T1 . --evidence "..."
ocskill work fail <slug> T1 . --reason "..."
ocskill work verify-integration <slug> . --verdict PASS --evidence "..."
ocskill work finalize <slug> . --evidence "..."
ocskill work resume <slug> .
```

State/evidence writes use a per-item lock and atomic replacement.

## Context pack

```cmd
ocskill context-pack <slug> <task> .
```

Returns only the task, bounded spec, dependency reports, decisions, blockers and current task state required for a fresh executor.

## Runtime dispatch on OpenCode V2

The managed plugin exposes `ues.dispatch_task`, which combines `work start`, context pack, model policy and a fresh OpenCode executor session.

## Constraints

These helpers:

- do not replace reading exact affected code
- do not pretend text/import scans are complete semantic analysis
- do not auto-merge/push/publish/deploy
- preserve unrelated user work
- use JSON outputs where machine consumption matters
