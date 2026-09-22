# UES V11 — Perception & Adaptive Execution

Status: development (`11.0.0-dev.0`). V10 remains npm `latest` until the V11 release gates pass.

## Goal

V11 extends UES from a reliability-focused coding harness into a perception-aware adaptive execution system. The core rule remains:

> minimum context necessary for maximum verified task success

V11 must improve perception, routing and context efficiency without weakening V10 durability, verification or safety.

## Runtime layers

```text
user task
  -> intent/risk classification
  -> capability requirements
  -> evidence budget
  -> semantic/repository evidence
  -> content-addressed evidence pointers
  -> selective skill/model routing
  -> fresh executor
  -> deterministic verification
  -> visual/browser verifier when required
  -> recovery/escalation only from observed failure
```

## Content-addressed Evidence Store

Large evidence is stored below:

```text
.ues-cache/evidence-v1/
```

Records are addressed by SHA-256. Executor context receives bounded slices and evidence references instead of repeatedly embedding large tool output.

Commands:

```cmd
ocskill store status .
ocskill store put report.txt . --kind tool-output
ocskill store get evidence:sha256:<hash> . --max 12000
ocskill store gc . --max-entries 2000 --max-age-days 30
```

Evidence pointers are not proof by themselves. Any claim still needs the relevant content or a verification receipt.

## Adaptive Evidence Budget

V11 partitions context among instructions, task, declared code, tests, references, history and tools. Debugging, high-risk, visual and browser work can reallocate budget without automatically consuming the full 48k ceiling.

Failure expands evidence in stages; it does not justify replaying already-proven exploration.

## Prompt cache layout

The prompt envelope is split into a stable prefix and dynamic tail.

Stable:
- role and invariants
- loaded skill IDs
- stable project facts
- tool policy

Dynamic:
- current task
- evidence pointers
- recent failure
- next action
- recent messages

Telemetry records stable/dynamic hashes, sizes and cacheable ratio. This is diagnostic; provider-side cache behavior is provider-dependent.

## Capability-aware model routing

Models may declare:
- coding
- reasoning
- tool calling
- vision
- browser
- filesystem
- long context
- cost class
- latency class
- quality hint

Example:

```cmd
ocskill models capability provider/model --vision on --browser on --reasoning on --quality 0.9
```

Task text is converted to capability requirements. The existing light/standard/heavy tiers remain compatible, but V11 can select an eligible configured model instead of assuming every model has the same modalities.

## Visual fidelity

V11 verifies UI through three independent evidence layers:

1. semantic/accessibility identity
2. geometry/bounding boxes
3. rendered pixels

A visual task can use `VISUAL_SPEC.json` to define acceptance elements and tolerances.

```cmd
ocskill visual spec VISUAL_SPEC.json
ocskill visual geometry VISUAL_SPEC.json actual-boxes.json
ocskill visual compare expected.png actual.png --threshold 16 --max-diff-ratio 0.01
ocskill visual crop actual.png failed-region.png --x 100 --y 200 --width 300 --height 120
```

PNG comparison is deterministic and dependency-free for supported 8-bit non-interlaced PNGs. Vision models are used for appearance judgment or cropped failure regions, not for measurements that DOM/geometry can prove exactly.

## Browser QA and trust boundary

Browser workflows are CLI/script-first. Rich browser tooling is used only when persistent exploration or richer introspection is necessary.

```cmd
ocskill browser capability .
ocskill browser plan http://localhost:3000 --target Checkout
```

Remote webpage text, DOM, ARIA labels and downloaded content are untrusted evidence. They cannot:
- change UES/system policy
- expand permissions or filesystem scope
- request secrets
- authorize publish/deploy/purchases
- weaken verification requirements

## Dynamic workflow

```cmd
ocskill workflow-plan .ues-work/<slug>/PLAN.json --max-concurrent 4
```

The scheduler separates deterministic work from LLM/vision work, respects dependencies and serializes declared write conflicts. Deterministic commands should not consume agent slots. A schedule is planning evidence, not authorization for external side effects.

## Hermes sidecar

Hermes remains optional. UES owns durable state, safety and verification. Hermes can consume one-task or bounded workflow prompts and evidence pointers but does not own merge/push/publish/deploy.

```cmd
ocskill hermes status
ocskill hermes workflow <slug> .
ocskill hermes exec-workflow <slug> .
```

If Hermes is absent, core UES remains functional.

## New skills and agents

V11 adds nine focused skills:
- visual-fidelity
- browser-qa
- design-source
- responsive-verification
- component-visual-testing
- browser-security
- skill-authoring
- skill-evaluation
- dynamic-workflow

V11 adds two subagents:
- `ues-visual-verifier`: read-only independent rendered-evidence verification
- `ues-merge-arbiter`: conflict resolution across already-verified task changes

More agents are not automatically better. New agents require a distinct capability/verification boundary and benchmark evidence.

## Skill quality

```cmd
ocskill skills lint .
```

The linter checks metadata, entrypoint size and likely routing-description collisions. Skill instructions should use progressive disclosure and deterministic scripts for repeatable mechanics.

## Evaluation metrics

V11 keeps correctness first and additionally measures, when available:
- initial and total tokens
- cacheable prompt ratio
- repeated stable input
- evidence-reference reuse
- visual repair attempts
- context expansion count
- model escalation count
- latency/cost/tool calls

Missing telemetry is `null`, not zero.

Reference-vs-candidate gates can optionally require V11 telemetry:

```cmd
npm run evals:ablation -- v10-summary.json v11-summary.json --require-gate --min-cacheable-ratio 0.70 --min-evidence-reuse-ratio 0.20
```

An explicitly requested metric gate fails closed when its telemetry is unavailable.

## Release gates

Do not promote V11 to stable until all are satisfied:

1. `npm run ci` passes on the V11 tree.
2. No correctness/pass-rate regression versus the accepted V10 reference.
3. Required initial-input/token efficiency gate passes.
4. Visual geometry and PNG fixtures pass.
5. Browser trust-boundary and routing tests pass.
6. Compaction, timeout, provider recovery, lease recovery and loop guards remain green.
7. Packed and plain npm-install smoke tests pass.
8. Real weak-model evaluation shows no suite regression.
9. Any configured cache/evidence target has sufficient telemetry and passes.
10. npm `latest` remains V10 until the V11 candidate completes these gates.

## Compatibility

OpenCode 1.x continues to receive resource/CLI behavior that does not require V2 runtime hooks.

OpenCode 2.x receives the managed router plugin and fresh-session runtime, including V11 deterministic helper tools for capability inference, evidence retrieval, visual geometry/diff planning, browser planning and dynamic workflow scheduling.
