# V11 Perception & Adaptive Execution

## Goal

V11 minimizes context and model cost without deleting evidence needed for correctness. It adds perception-aware UI/browser verification so the system can reason about **what an element is, where it is and how it looks** using different evidence channels.

## Runtime layers

```text
Task
  -> intent/risk
  -> capability requirements
  -> adaptive evidence budget
  -> semantic/index evidence
  -> content-addressed evidence pointers
  -> focused skills
  -> capability-aware model
  -> fresh executor
  -> deterministic verification
  -> visual/browser verifier when required
  -> diagnosis + evidence expansion only on failure
```

## Evidence Store

Large raw tool output, durable specs and dependency reports are stored under:

```text
.ues-cache/evidence-v1/<hash-prefix>/<sha256>.blob
.ues-cache/evidence-v1/<hash-prefix>/<sha256>.json
```

A prompt receives a bounded excerpt and a reference such as `evidence:sha256:<hash>`. Use `ocskill store get` to retrieve only the needed slice. `.ues-cache` is runtime state and is excluded from workspace verification fingerprints.

## Adaptive evidence budget

FAST/STANDARD/DEEP remain outer safety ceilings. Inside that ceiling V11 allocates characters by evidence role instead of treating all context as equally valuable. Debugging shifts budget toward tests/history; high-risk work shifts toward tests/references; browser/visual work shifts toward deterministic tool evidence.

Failure expands evidence through the existing initial -> diagnose -> deep-recovery stages instead of loading maximum context on the first attempt.

## Prompt cache shape

Stable material is separated conceptually from dynamic task/evidence. The runtime records stable/dynamic hashes and cacheable ratio. This is telemetry, not a promise that every provider supports prompt caching.

## Capability-aware routing

Model profiles may declare coding, reasoning, toolCalling, vision, browser, filesystem, longContext, cost/latency class and a quality hint. UES never invents an unavailable capability. If no configured candidate satisfies a requirement it exposes capability fallback instead of silently claiming that a text-only model can see screenshots.

## Visual fidelity

Visual verification uses three complementary layers: semantic DOM/accessibility identity, geometry/bounding boxes, and screenshot pixels. VISUAL_SPEC describes important anchors and tolerances. Geometry receipts prove position/size claims. PNG diff finds changed pixels and their bounding region. A failed region can be cropped so vision only sees the area that needs judgment.

Screenshot equality does not prove accessibility or interaction; DOM equality does not prove appearance.

## Browser QA and security

Browser workflows prefer bounded deterministic scripts/CLI for ordinary verification. Remote webpage content is untrusted and cannot change UES/tool permissions, request secrets, expand the approved task or authorize external side effects.

## Dynamic workflows

The scheduler classifies units as deterministic, LLM judgment or vision judgment. Deterministic work does not spawn agents. Independent tasks may share a wave only when dependencies are ready and file ownership does not conflict. Each wave is integrated and verified before later waves rely on it.

## Skill system

V11 keeps progressive disclosure: description metadata for routing, short SKILL.md entrypoint, references only when the selected mode needs them, and deterministic logic in runtime/scripts rather than repeated prompt text.

`ocskill skills lint` flags oversized entrypoints and highly overlapping descriptions.

## Hermes sidecar

Hermes remains optional. UES owns durable `.ues-work` state, evidence references, task leases/runId fencing, verification receipts and safety/permission boundaries. Hermes may execute a bounded task/workflow when explicitly available but does not become the source of truth.

## Release evidence

V11 must pass syntax/resource/router/V11 contract tests, all Node tests, package/install smokes, no-regression live suites, capability-routing tests, visual geometry/pixel fixtures, browser security/targeted-evidence fixtures and token/cache/evidence telemetry benchmarks before stable promotion.
