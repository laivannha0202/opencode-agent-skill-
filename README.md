# UES for Pi Agent

**A Pi-native engineering runtime that gives a coding agent deterministic context, skills, tools, delegation, and evidence-gated verification on real repositories.**

[![npm](https://img.shields.io/npm/v/opencode-agent-skill)](https://www.npmjs.com/package/opencode-agent-skill)
[![Node](https://img.shields.io/badge/node-%3E%3D22.19-5FA04E)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

`opencode-agent-skill` · version **16.12.0** · host **Pi Agent** · runtime **Node.js >= 22.19**

<!-- ues-version: 16.12.0 -->

---

## What is UES?

UES is a runtime layer that runs inside [Pi](https://pi.dev). It sits between the model and the
repository and takes over the mechanical work that a small or mid-tier model is bad at:
finding the right files, choosing the right skills, keeping context small, splitting work,
surviving interruptions, and refusing to call something done without evidence.

UES does **not** make a weaker model equivalent to a frontier model. It does not change the
model's underlying reasoning capability. What it changes is the orchestration, context, and
tooling burden the model has to carry on its own — and how much of the correctness work is
done by deterministic runtime code instead of by the model.

The design rule throughout: **the model is not trusted with a decision that code can make
deterministically.**

## Why UES?

| Problem | UES approach |
| --- | --- |
| A large repository does not fit in context | Graph-ranked retrieval over a semantic index, served in bounded evidence packs |
| A small model activates the wrong skills | Machine-readable skill contracts plus an evidence-ranked router that activates 1–3 skills |
| Every tool schema is always in context | Phase-scoped tool surface; missing capabilities are hydrated on evidence |
| Long tasks lose state | Durable run journal, runtime epochs, execution ownership, bounded write checkpoints |
| The model declares success without proof | Independent local verification gates that produce the only verdict |
| Tool output floods the context | Reversible compaction: the compressed view stays, the raw bytes remain retrievable |
| The model is confidently wrong about an uncertain decision | Optional DeepSeek Web advisor, consultant-only, never authoritative |
| Big tasks should be parallelised | Bounded specialist delegation with fresh context and verified handoff capsules |

## Highlights

- **Adaptive context** — L0/L1/L2 context packs, repo map, semantic index, affected-test hints.
- **Skill routing** — 48 machine-readable skill contracts; bounded capsule composition with
  section provenance instead of concatenated skill bodies.
- **Tool surface economy** — a trivial one-file fix sees read/search/edit/test, not browser,
  service manager, and document ingestion.
- **Specialist agents** — 12 existing roles reused for bounded delegation; fresh child context,
  depth 1 by default (hard max 2), 2 concurrent children (hard max 3).
- **Verified handoff** — child output goes to the Evidence Store; the parent gets a bounded,
  redacted capsule that carries no verdict authority.
- **Browser reliability** — Playwright/MCP on demand, semantic snapshots before pixels, bounded
  retries, untrusted-page-content boundary.
- **Web reasoning advisor** — optional DeepSeek Web lane with `AUTO` / `OFF` / `FORCE` modes.
- **Durable execution** — runtime epoch fencing, parent-heartbeat ownership leases, idempotent
  resume, Windows-safe cleanup.
- **Measured efficiency** — `VerifiedTaskCost`, efficiency ledger with explicit `MEASURED` /
  `DERIVED_FROM_MEASURED` / `NOT_MEASURED` provenance.

## Architecture

```
User task
    |
    v
Pi / UES router
    |
    v
Skill routing  ->  Skill capsule  |  Tool surface
    |
    v
Direct execution  or  bounded specialist delegation
    |
    v
Optional DeepSeek advisor (consultant-only, no repo access)
    |
    v
Implementation
    |
    v
Local verifier  ->  PASS  |  bounded recovery
```

Two rules never bend: the **parent Pi session is the execution authority**, and the **local
verifier is the final correctness authority**. No advisor, subagent, or learned heuristic can
produce a verdict.

## Quick Start

### Requirements

- Node.js **>= 22.19**
- [Pi Agent](https://pi.dev) 0.84+

### Install

```bash
npm install -g opencode-agent-skill
```

Then register the package with Pi:

```bash
pi package add opencode-agent-skill
```

### Verify

```bash
ues version
ues doctor
ues doctor --reasoning     # read-only web-reasoning readiness
```

### Use

```bash
ues status                            # runtime + repository status
ues skills route "fix the payment webhook idempotency"
ues context-report <trace-id>         # what the model was shown, and why
ues inspect run <run-id>              # bounded run artifacts
ues trial                             # paired baseline-vs-UES real-model measurement
```

Full CLI reference: `ues help` and [docs/PI-COMPAT.md](./docs/PI-COMPAT.md).

## How It Works

### 1. Context

UES never sends a repository dump. It builds a bounded evidence pack per task from a
graph-ranked repo map and a content-addressed semantic index, ranks files by structural and
graph contribution rather than lexical overlap, separates definitions from references, and
states the score contribution for every selected file. The pack is cached per workspace
fingerprint, and output compaction is reversible: the compressed view is what the model sees,
the raw bytes stay retrievable by reference.

### 2. Skills and tools

Each of the 48 skills has a machine-readable contract: intents, task classes, required and
optional capabilities and tools, forbidden actions, context class, output contract, and
verification requirements. The router ranks all 48 contracts against the task's intents, stack,
repo evidence, and measured past usefulness, then activates a minimal set — normally one to
three. Selected skills are composed into one bounded capsule with per-section provenance, so
constraint rules survive even when the capsule budget is tight.

The tool surface follows the task phase. A one-file fix gets read, search, edit, and shell; a
visual task adds browser tools; a schema task adds code intelligence. Hiding a tool from the
model never removes a runtime permission — the safety capability set is enforced regardless of
what is advertised, and a deferred capability can be hydrated once, with a deterministic
receipt, on explicit evidence.

### 3. Specialist delegation

Delegation is an evidence-driven decision, not a default. Review and test-analysis roles are
delegated because independence is the point; exploration is delegated when the context
separation pays for itself; trivial single-file edits and mechanical changes stay
parent-direct. Children start with a fresh context — the bounded task, the constraints, the
relevant files and symbols, the required skill capsule, and evidence references, but not the
parent conversation, the full skill bodies, or the whole tool set.

Raw child transcripts never go back into the parent. They land in the Evidence Store; the parent
receives a Verified Handoff Capsule with findings, risks, open questions, evidence refs, and
an explicit note that a child cannot grant permission or mark a task verified.

### 3b. Bounded parallel delegation

Independent children in the same safe wave run **concurrently** — explore + test-analysis, two
read-only investigations, independent review lanes. Parallelism is permitted only when the
scope classifier proves every condition at once: independent children, disjoint scopes,
compatible side-effect classes, no overlapping writer scope, no shared mutable service, no
duplicate external side effect, and a free concurrency slot.

Anything else stays serial and says why: two writers on the same file, a writer touching a
dev server or shared service, destructive shell, or publish/deploy. Writer conflicts are
isolated through the existing per-task Git worktree instead of being co-scheduled.

| Bound | Value |
| --- | --- |
| Active children | default 2, hard max 3 (`UES_MAX_ACTIVE_CHILDREN`) |
| Delegation depth | default 1, hard max 2 |

Concurrency never exceeds the budget, results are returned in task-id order regardless of
completion order, one child failing never cancels an unrelated read-only sibling, and a failing
child can never become a global PASS. Cancellation, the inactivity watchdog, and the per-child
timeout all terminate the real child process tree — there is no orphan left behind.

### 4. Verification

Verification is local and adversarial by construction. Turbo fast-path PASS requires complete,
error-free static diagnostics for the supported changed files *in addition to* fresh behavioral
evidence; incomplete diagnostics fail closed to an independent verifier instead of being treated
as clean. Active Evidence Store references are protected from garbage collection, missing blobs
at compaction resume are audited, and the pass/fail verdict matrix is computed independently of
the implementer's own claims.

### 5. Web reasoning

When a decision is genuinely hard and grounded local evidence is thin, UES can consult DeepSeek
Web through a persistent authenticated browser profile. It is a *consultant*: it cannot read the
repository, run a command, grant a permission, or produce a verdict. Its answer is untrusted
external data that must be bound to evidence before use. Rejecting the advice is an expected,
safe outcome.

## DeepSeek Web Reasoning

Optional. Off by default. The advisor is a *consultant*: it never decides PASS and never
holds authority over the task.

| Mode | Behavior |
| --- | --- |
| `OFF` | Never consults |
| `AUTO` | Consults only on genuine signals; stays local for grounded or trivial tasks |
| `FORCE` | Explicitly requests a consultation for a decision packet |

### One-time setup

```bash
# 1. Sign in once. This opens a REAL headed browser; you sign in yourself.
#    UES never reads, fills or logs a password, cookie, token, OTP or CAPTCHA.
ues deepseek login --profile personal

# 2. Enable web reasoning and choose the posture (persisted; AUTO is the default).
ues deepseek on                 # persist enabled=true
ues deepseek mode auto          # off | auto | force  (never FORCE by default)
ues deepseek status             # read-only: enabled, mode, active profile, lock
```

`login` persists ONLY safe metadata (`enabled`, `mode`, the profile NAME) to
`<ues-config>/.ues/web-reasoning.json`. No credential, cookie or storage state is ever written
by UES. Precedence at runtime is **env override > persisted config > built-in default**.

### Daily use

The daily flow is just:

```bash
cd <project>; pi
```

There is nothing else to launch. The browser is started **lazily**, only when a consultation is
actually about to be sent, and it is closed cleanly when the run ends. If the persisted session
has expired, `AUTO` observes it and falls back to local execution — it never blocks the task
and never asserts an authentication it did not observe. Re-run `ues deepseek login` only when a
consult is reported as needing auth.

```bash
ues doctor --reasoning          # read-only readiness; submits nothing, launches nothing
UES_WEB_REASONING_MODE=AUTO     # env override: AUTO | OFF | FORCE
```

### Properties (unchanged from V16.3/V16.4)

- consultant-only; `canProducePass = false`; never a task verdict
- no filesystem, no git, no terminal, no permissions, no secrets forwarded
- persistent authenticated browser profile; no credential or cookie output
- single-submit behaviour; bounded follow-ups
- local verification remains authoritative regardless of the answer

Specialist question types: `root-cause`, `architecture`, `alternative-fix`,
`adversarial-review`, `verifier-failure`.

### Developer smoke (not part of daily use)

The live smoke and the A/B benchmark are developer tools, separate from the daily flow. They
are **opt-in** and submit real external messages, so they require an explicit consent flag and
report `NOT_MEASURED` for anything they cannot observe.

```bash
npm run smoke:deepseek-web                      # preflight only: observes, submits nothing
npm run smoke:deepseek-web -- --live --yes-i-have-authorized-a-live-consultation
                                                # ONE bounded live consultation, real browser
node scripts/bench-web-reasoning-ab.mjs         # A/B: local-only vs AUTO (deterministic)
node scripts/bench-web-reasoning-ab.mjs --live --yes-i-have-authorized-a-live-benchmark
```

A live benchmark run is bounded, single-submit, and never presented as model evidence when only
the deterministic double ran.

## Safety Model

| Boundary | Guarantee |
| --- | --- |
| Dirty work | Pre-existing uncommitted work is never discarded; inherited dirty state is captured and checked |
| `.env` | Local environment file mutation is denied unless the task explicitly allows it |
| Destructive actions | Shell policy gates destructive commands; UES never uses them as debugging rituals |
| External side effects | No automatic replay of a failed external action |
| Untrusted web content | External/MCP output carries `instruction-authority=none`; page content cannot authorize actions |
| Verifier | Independent local verification is the only source of a verdict |
| Browser retries | Bounded, taxonomy-driven, with process-tree cleanup |
| Publish / push / deploy | Never automatic; subagents and advisors cannot do it at all |
| Secrets | Redaction across Evidence Store, handoffs, run artifacts, and progress views |
| Delegation | Depth ≤ 2, cycle guard, bounded concurrency (default 2 / hard max 3), unsafe scopes serialized, cancellation leaves no orphan |
| Skills and tools | No automatic skill deletion; hiding a tool never removes a permission |

## Performance & Measurement

Deterministic tests are **not** a model-performance proof, and this project does not present
them as one. Claims are separated by provenance:

- `MEASURED` — observed in this run (character counts, tool counts, call counts, ratios)
- `DERIVED_FROM_MEASURED` — computed from measured values by a documented formula
- `NOT_MEASURED` — not measured; reported as such rather than estimated

Tool schema character counts are `ESTIMATED` from a stable per-tool table. Provider tokens,
wall-clock speedups, and model-quality improvements are `NOT_MEASURED` unless a live A/B run
produced them.

Bounded parallel delegation reports `safeWaveCount`, `parallelDelegations`,
`serializedDelegations`, `maxObservedChildConcurrency`, `childQueueMs`, `childExecutionMs`,
`parallelWallMs`, `sequentialEquivalentMs`, and `overlapSavingsMs`. `overlapSavingsMs` is a
`MEASURED` dispatch overlap of child execution windows in this process. It is deliberately
**not** called a speedup, and it carries no provider-token or model-quality claim.

```bash
npm run eval:v16.5            # deterministic V16.5 evaluation
npm run eval:v16.6            # deterministic V16.6 unified-budget evaluation
npm run eval:v16.5:measure    # full measurement report
npm run eval:v16.5:routing    # skill routing matrix
ues trial                     # paired baseline-vs-UES real-model run
ues trial --require-promotion # fails closed when required efficiency evidence is absent
```

`VerifiedTaskCost` is the cost ledger used for promotion decisions.

## Commands

| Group | Command |
| --- | --- |
| Status | `ues status` |
| Diagnostics | `ues doctor`, `ues doctor --reasoning`, `ues skills registry` |
| Routing | `ues skills route <task>` |
| Context | `ues context-report <trace-id>`, `ues context-pack`, `ues replay <trace-id>` |
| Evidence | `ues evidence`, `ues inspect run <run-id>`, `ues run-inspect` |
| Verification | `ues verification-plan`, `ues test/verify` prompts |
| Optimization | `ues optimize-report`, `ues context-observatory` |
| Benchmark | `ues trial`, `npm run bench:*` |
| Version | `ues version` |

Full list: `ues help`.

## Project Structure

```
bin/     CLI entry point (ues / ocskill)
lib/     runtime modules (context, skills, tools, delegation, evidence, verification)
pi/      Pi extension and child runtime
global-config/  skills, specialist agents, commands, installer data
evals/   deterministic evaluation corpora and routing matrices
scripts/ release gates, checks, benchmarks, smoke tests
test/    per-file bounded test suite
docs/    design, compatibility, evaluation, and release documentation
```

## Documentation

| Topic | Document |
| --- | --- |
| Architecture | [ENGINEERING-DESIGN](./docs/ENGINEERING-DESIGN.md) |
| Pi runtime contract | [PI-COMPAT](./docs/PI-COMPAT.md) |
| Legacy OpenCode boundary | [OPENCODE-COMPAT](./docs/OPENCODE-COMPAT.md) |
| Deterministic hardening | [V16](./docs/V16-DETERMINISTIC-HARDENING.md) |
| Browser + web reasoning | [V16.3](./docs/V16.3-BROWSER-WEB-REASONING.md) |
| Measured adaptive runtime | [V16.4](./docs/V16.4-MEASURED-ADAPTIVE-RUNTIME.md) |
| Agent skill + delegation intelligence | [V16.5](./docs/V16.5-AGENT-SKILL-DELEGATION.md) |
| Unified adaptive orchestration | [V16.6](./docs/V16.6-UNIFIED-ADAPTIVE-ORCHESTRATION.md) |
| Context intelligence + economy | [V16.10](./docs/V16.10-CONTEXT-INTELLIGENCE-ECONOMY.md) |
| Advisor lifecycle + event-first | [V16.11](./docs/V16.11-ADVISOR-LIFECYCLE-EVENT-FIRST.md) |
| Execution acceleration runtime | [V16.12](./docs/V16.12-EXECUTION-ACCELERATION-RUNTIME.md) |
| Evaluations | [EVALS](./docs/EVALS.md) |
| Deterministic tools | [DETERMINISTIC-TOOLS](./docs/DETERMINISTIC-TOOLS.md) |
| Trace schema | [TRACE-SCHEMA](./docs/TRACE-SCHEMA.md) |
| npm publishing | [NPM-PUBLISH](./docs/NPM-PUBLISH.md) |
| Release history | [CHANGELOG](./CHANGELOG.md) |

## Development

```bash
npm ci
npm test                     # bounded per-file suite
npm run eval:v16.6           # V16.6 deterministic evaluation
npm run eval:v16.12          # V16.12 execution-acceleration evaluation
npm run release:verify       # full release gate chain
```

## Release Philosophy

Every release runs the deterministic gate chain: source integrity, runtime exports, syntax,
the bounded test suite, the focused per-version evaluations, release consistency, a packed
install smoke test, and a clean-child Pi acceptance run. A change is not promoted on "tests
pass"; it needs evidence that the behavior it claims actually happens.

No synthetic benchmark is promoted to a real-model claim. There is no hidden PASS: if
measurement is missing, the report says it is missing.

## License

MIT — see [LICENSE](./LICENSE).
