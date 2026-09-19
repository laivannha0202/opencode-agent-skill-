# UES engineering design

Version 4 evolves UES from a prompt/skill collection into a measured engineering harness with deterministic evidence helpers, progressive-disclosure domain workflows, executable behavioral evaluation, and OpenCode-version-aware runtime integration.

The selected model is still the selected model. UES improves the process around it; it does not claim that prompts or plugins turn one base model into another.

## Design principles

### Deterministic facts before probabilistic reasoning

Repository facts that are cheap to compute should not depend on the model guessing them. V4 adds dependency-free helpers for stack detection, test-command discovery, repository mapping, bounded impact search, evidence collection, and Git working-tree inspection.

The model still reads the exact affected code and reasons about architecture; deterministic helpers reduce avoidable context use and hallucinated setup assumptions.

### Progressive disclosure instead of prompt volume

The global workflow stays compact and routes to a small skill set. Main `SKILL.md` files contain the operational core; deeper framework/domain behavior lives in `references/` and is loaded only when needed.

V4 deepens previously short workflows without increasing the 39-skill catalog simply to appear more capable.

### Risk-aware routing

Small changes remain inline. Standard changes get concise planning and verification. Public contracts, persistence, auth/security, payments, migrations, deployment, and other high-risk work add impact analysis, compatibility/rollback thinking, and independent review when useful.

OpenCode 2.x can also use the managed UES router plugin. The plugin adds a bounded set of relevant skill IDs during prompt admission. It is intentionally conservative: routing is a hint that improves skill availability, not proof about repository state.

### Evidence-driven completion

Completion claims require evidence matched to the claim:
- behavior tests for behavior
- provider/consumer checks for contracts
- negative authorization cases for permissions
- migration/data evidence for persistence
- representative measurements for performance
- actual command output and exit status for builds/tests/releases

An agent report is not independent proof.

### Root-cause and bounded repair

Verification failures feed diagnosis rather than patch stacking. Repeated failed fixes trigger a fresh investigation and eventually architecture re-evaluation.

For substantial/high-risk changes, a critic/reviewer can attempt to falsify assumptions. Only evidence-backed blocking findings trigger repair, and critic-repair cycles are bounded to avoid churn.

### Structured resumable state

Long tasks can preserve confirmed facts, assumptions, rejected hypotheses, decisions, system boundaries, changed files, verification evidence, blockers, and one next action.

The ledger is not a chain-of-thought transcript. It preserves actionable engineering state so a resumed session does not repeat disproved work.

## Deterministic tooling layer

V4 adds:

```text
ocskill inspect
ocskill detect-stack
ocskill detect-tests
ocskill impact
ocskill evidence
ocskill working-tree
```

These helpers are read-only and use Node built-ins. Broad scans are bounded and common dependency/build directories are skipped.

They intentionally do not pretend to be semantic language servers. A text impact hit is a lead that still needs exact caller/contract inspection.

## OpenCode compatibility layer

UES detects the installed OpenCode major during resource synchronization.

For OpenCode 1.x, it preserves the existing compatible agent format and does not install a V2-only plugin.

For OpenCode 2.x, it converts UES-managed subagents to the native ordered `permissions` frontmatter shape and installs a managed global plugin under the documented global plugin discovery directory. The plugin uses the V2 prompt-admission hook to add selected skills through the normal skill-resolution path.

Only UES-managed files are rewritten or removed when the detected major changes.

See [OPENCODE-COMPAT.md](OPENCODE-COMPAT.md).

## Evaluation architecture

UES separates three different questions.

### Catalog/routing contract

`evals/routing.json` has 34 representative prompts and requires every installed skill to be covered while keeping each expected route small.

This proves catalog consistency, not model performance.

### Benchmark integrity

`npm run evals:live:validate` executes every hidden grader against the intentionally broken starting fixture. A grader must reject the broken state with an assertion failure.

This prevents false confidence from a grader that accidentally passes without a repair or crashes because the benchmark itself is invalid.

### Behavioral benchmark

The live harness runs the same task/model as:
- isolated baseline
- isolated UES

V4 contains 20 executable tasks across correctness, authorization, API/data contracts, payments, security, frontend state, dependency compatibility, and multi-file change.

Results include grader outcome, duration, changed files and best-effort tool/skill/subagent/token/cost telemetry. `ocskill eval-report` aggregates baseline-vs-UES outcomes across result files.

The hidden grader remains the primary correctness signal; telemetry helps explain efficiency and behavior but is not treated as ground truth when the upstream JSON event format omits data.

## Authentication isolation in live evals

Baseline validity requires preventing a supposedly empty run from reading the user's installed UES configuration. V4 continues to isolate HOME, USERPROFILE, XDG config/data/cache/state, and `OPENCODE_CONFIG_DIR`.

The default `--auth env-only` relies only on provider credentials already supplied through the environment. Optional `--auth current` copies only OpenCode's current auth file into the isolated data root; it does not copy the user's OpenCode config.

## Package lifecycle

npm owns package installation/versioning. UES owns only its namespaced and marked OpenCode resources.

The installer records:
- package/resource version
- detected OpenCode major
- managed skills
- managed commands
- managed subagents
- managed V2 plugins

Re-sync is idempotent. Unmanaged collisions are preserved. Foreign/corrupt state is not overwritten silently.

The packed-install smoke test installs the generated tarball into an isolated global npm prefix, forces the V2 compatibility path, verifies the package is a real copy instead of a source junction, checks native V2 agent syntax and the managed router, and runs the packed CLI.

## Update safety

Self-update uses npm's explicit `latest` dist-tag rather than ambiguous package metadata. If `npm view package@latest version` is unavailable, UES falls back to `npm dist-tag ls`.

The updater:
- refuses a published version older than the installed build
- re-syncs without reinstalling when equal
- uses lifecycle-disabled package replacement for a newer version
- invokes the newly installed CLI to synchronize resources

This specifically protects against stale registry metadata such as the observed case where an unqualified version query returned 2.1.0 while the `latest` tag already pointed to 3.0.0.

## Selective subagents

Six analysis-oriented subagents remain intentionally sufficient:
- architect
- debugger
- researcher
- reviewer
- critic
- verifier

V4 does not add agents merely to increase count. Independent context is useful for falsification and verification; broad multi-agent fan-out can duplicate work and correlate errors.

## What UES deliberately avoids

- loading all skills for every request
- treating keyword routing as truth
- default agent swarms
- hidden chain-of-thought logging
- declaring success from compilation alone
- generic cache deletion or dependency upgrades as debugging rituals
- broad rewrites when an incremental seam satisfies the requirement
- claiming general model equivalence from a small benchmark

## Research inputs

The design is informed by public engineering-agent patterns and current OpenCode/npm documentation listed in [RESEARCH-SOURCES.md](RESEARCH-SOURCES.md). UES does not vendor those projects; it implements its own model-agnostic workflow.
