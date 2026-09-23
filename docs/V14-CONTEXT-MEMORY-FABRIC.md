# V14 Context & Memory Fabric

Status: beta prerelease (`14.0.0-beta.1`).

## Goal

V14 improves weak-model reliability without adding more specialist agents. It moves repository understanding, persistent memory, and tool/provider selection into deterministic runtime layers so the model receives less irrelevant context and makes fewer infrastructure choices itself.

## Architecture

### Hierarchical context

UES builds deterministic repository summaries on top of the incremental semantic index:

- **L0**: bounded routing abstract for a directory/subtree;
- **L1**: bounded overview with child areas, important symbols, extensions and files;
- **L2**: existing task-context source/test/instruction excerpts loaded only after scope selection.

`buildContextManifest` still preserves declared files, tests, Git changes and graph evidence, but semantic references inside selected hierarchy scopes receive a deterministic boost. The compact Pi child context includes only the highest-ranked L0/L1 scopes. A diversity fence prevents a single parent/child directory chain from consuming the complete scope budget.

### Verified persistent memory

Project memory lives in ignored local state under `.ues-memory/MEMORY.json`.

Memory lifecycle:

```text
candidate -> durable evidence -> independent PASS -> verified -> retrieval
                                                \-> superseded
```

A memory cannot become retrievable merely because an agent emitted text. Verification requires at least one content-addressed Evidence Store reference and a named verifier. Successful `ues_execute` runs record a bounded evidence receipt and promote an episodic memory only after task or integration verification passes.

Retrieval combines deterministic lexical BM25-style relevance, hashed-vector similarity, file-path affinity, task-class affinity, scope, recency and confidence using reciprocal-rank fusion. Candidate, superseded and expired memories are excluded. Recalled memories track `lastUsedAt` and `useCount` for future policy tuning.

### Capability fabric

`lib/capability-fabric.mjs` adds a provider layer above individual tools. Each capability may expose primary and fallback providers with health, priority, quality, latency and cost hints. Built-in UES services are health-checked without external network calls; optional command/package providers may be unavailable without making unrelated tasks fail. Bounded success/failure/latency observations are persisted in ignored `.ues-learning/CAPABILITY-OBSERVATIONS.json`; observation weight ramps up over repeated samples so one transient failure cannot immediately poison routing.

Project overrides may be placed in `.ues-capabilities.json` or supplied through `UES_CAPABILITY_CONFIG`.

## CLI

```text
ues capability-fabric status [dir]
ues capability-fabric select <capability> [dir]

ues hierarchy "<query>" [dir]

ues memory status [dir]
ues memory search "<query>" [dir] [--limit N]
ues memory propose "<text>" [dir] --evidence <evidence:sha256:...>
ues memory verify <id> [dir] --verdict PASS --verifier <name> [--evidence <ref>]
ues memory supersede <id> <replacement-id> [dir]
```

`ues doctor` also prints the currently selected capability providers and fallbacks.

## Safety properties

- no new autonomous specialist role is introduced;
- memory is fail-closed on missing evidence;
- supersession requires the replacement memory to be verified first;
- provider health is deterministic and optional providers do not silently masquerade as healthy;
- hierarchy and memory are bounded before being injected into child Pi context;
- memory recording failures never turn a verified engineering task into a failed task.

## Evaluation

V14 adds deterministic unit/CLI regression coverage plus `evals/v14/tasks.json` for hierarchy routing, verified recall, supersession, provider failover and context contamination. The existing weak-model baseline-vs-UES Pi benchmark remains the release-quality measure; V14 does not claim that orchestration makes a weak base model equivalent to a stronger model.
