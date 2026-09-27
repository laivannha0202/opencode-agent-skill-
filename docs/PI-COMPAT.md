# Pi Agent runtime

Repository này hiện đóng gói UES cho **Pi Agent**.

## Requirements

- Node.js 22.19+
- Git
- `@earendil-works/pi-coding-agent`

## Install

Stable npm release:

```cmd
npm install -g @earendil-works/pi-coding-agent
pi install npm:opencode-agent-skill
pi list
pi
```

Optional global CLI:

```cmd
npm install -g opencode-agent-skill@latest
ues version
```

GitHub main can still be installed when source-head testing is intended:

```cmd
pi install git:github.com/laivannha0202/opencode-agent-skill-
```

Project-local:

```cmd
pi install git:github.com/laivannha0202/opencode-agent-skill- -l
```

Hoặc từ checkout local:

```cmd
pi install .
```

## Resources loaded by Pi

`package.json` exposes:

- extension: `./pi/extensions/ues.ts`
- skills: `./global-config/skills`
- prompts: `./pi/prompts/*.md` (10 prompt templates; `/ues-run` is owned by the extension command)

The packaged runtime also contains `global-config/agents/`, `bin/ocskill.mjs`, and `lib/` because the Pi extension uses them for specialist child-agent execution and deterministic UES operations.

## Tools

### ues_cli

Runs bundled `ocskill` functionality directly, without requiring a separate global `ocskill` installation.

Typical uses:

- task policy;
- repository inspection;
- dependency/task graph;
- durable `.ues-work/` state;
- evidence and receipts;
- verification and recovery;
- worktree isolation.

### ues_execute

Runs the high-level deterministic controller for end-to-end engineering work.

The controller applies task policy, adaptive context, model-tier routing, optional diagnosis/plan gating, implementation, verifier/integration-verifier gates, bounded retries, and model-performance telemetry. This is the preferred entry point for weak models because the parent model no longer has to remember the orchestration protocol.

For a valid multi-task structured plan, the controller also computes dependency-safe waves, creates isolated Git worktrees for writing tasks, verifies each task independently, rejects writes outside the declared file scope, integrates successful work serially, and rolls back already-integrated work if a later integration in the same wave fails.

### ues_dispatch


Runs bundled specialist roles in isolated child Pi processes. Each child receives routed model selection plus a bounded adaptive context pack before execution.

Supported execution patterns:

- single;
- chain;
- bounded parallel.

Parallel writer agents require distinct explicit cwd/worktrees. Read-only agents may share the same repository.

Child Pi processes keep extension discovery enabled so custom model providers remain available, while skills, prompt templates and context files are disabled and each specialist receives a strict tool allowlist. Enriched task/context input is piped through stdin instead of argv for Windows command-line safety.

Each child also has bounded runtime supervision: a 30-minute hard timeout, a 5-minute idle timeout and a 15-second heartbeat by default. These can be tuned with `UES_CHILD_HARD_TIMEOUT_MS`, `UES_CHILD_IDLE_TIMEOUT_MS` and `UES_CHILD_HEARTBEAT_MS`.


## V15.15 Execution Contracts + Phase Gates

Long-horizon `/ues-run` now derives a deterministic execution contract before planning. The controller snapshots source-facing pre-existing dirty paths, blocks destructive Git discard commands such as `git restore`, `git checkout --`, and `git stash` in UES children, and injects the inherited-work boundary into every specialist role. Existing dirty work may only be changed when it is explicitly inside the approved task write scope; generated/U​​ES runtime artifacts are excluded from this baseline.

Local `.env` files are treated as runtime inputs, not repository implementation targets. UES child edit/write/code-edit and common shell-write paths are blocked for `.env`, `.env.local`, `.env.development`, and similar files unless the original task explicitly requests that local mutation. Templates such as `.env.example`, `.env.sample`, and `.env.template` remain writable. When local environment setup is missing but not authorized, agents should report `NEEDS_USER_ENV` instead of silently editing secrets/configuration.

Explicit `PHASE N — ...` contracts are parsed before planning. Execution phases must be represented in the structured plan with an integer `phase`; constraint-only phases remain invariants rather than fake tasks. UES then adds deterministic previous-phase barriers so a later phase cannot begin until every task in the previous execution phase has independently verified and integrated. Durable runs persist `EXECUTION_CONTRACT.json`, `phases/MANIFEST.json`, one deterministic JSON artifact per phase, and `FINAL_VERDICTS.json`, so resume can use durable state instead of replaying a very large prompt.

Database/fixture cleanup tasks receive an additional fail-closed contract: refuse production, dry-run first, record exact candidate IDs plus pre/post counts, use deterministic audited markers, preserve canonical/user data, prove a second idempotent cleanup pass, and prefer transaction/rollback protection when available. A final `DB_CLEAN_PASS` requires cleanup evidence, counts, and idempotency evidence rather than a narrative claim alone.

Final completion is split into independent `SOURCE_PASS`, `RUNTIME_PASS`, `DB_CLEAN_PASS`, and `DEVICE_PASS` dimensions when relevant. Runtime PASS may be derived from fresh executable checks; database cleanup and real-device PASS require their own concrete evidence. If source/runtime/data are verified but requested Expo/physical-device testing was not performed, UES reports `SOURCE_RUNTIME_PASS_DEVICE_NOT_VERIFIED` instead of overstating full PASS.

## V15.14 Deterministic Read-Only Fast Path

Command-only read-only Git inspections no longer depend on a verifier model following a report template. When the user explicitly asks to run only whitelisted Git inspection commands such as `git status`, `git branch --show-current`, `git rev-parse HEAD`, `git rev-parse --show-toplevel`, or `git status --short`, UES executes them directly through the supervised process runner, captures their exit codes and output, compares the source workspace fingerprint before and after, and synthesizes the structured verification report deterministically.

This path is fail-closed: an unrecognized Git command disables the deterministic shortcut and falls back to the verifier model. Any command failure, abort, or source-facing workspace mutation prevents PASS. The model-backed read-only lane also now receives the exact required report sections and verdict format to reduce weak-model schema drift.

## V15.13 Read-Only Completion Semantics

Read-only verification now distinguishes real acceptance gaps from optional or explicitly out-of-scope checks. Localized no-failure wording such as `Không có lệnh git nào bị lỗi` is treated as an empty failure section, while statements such as `không có yêu cầu` / `out of scope` are warnings rather than completion failures.

The verifier contract now requires `None` when no actual failures or requested unresolved gaps remain, and directs optional checks to `## Checks not run`. This fixes false-negative READ-ONLY runs that had fresh successful command evidence, an unchanged source fingerprint, and `UES_VERDICT: PASS` but were still rejected by the generic completion auditor.

## V15.12 Safe Autopilot + Disk Hygiene

UES is command-only by default in the parent Pi session. Ordinary prompts and non-UES tools continue through Pi without UES shell/MCP interception, and the parent `ues_*` tools are removed from Pi's active tool set so normal models do not see or accidentally select them. Explicit `/ues-*` prompt commands activate the registered UES tools for that turn, then `agent_end` restores the non-UES tool set. Direct `/ues-run`, `/ues-clean`, and `/ues-status` commands do not need a parent-model tool turn.

`/ues-run`, `ues_execute`, `ues_cli`, `ues_service`, specialist dispatch, and `/ues-clean` fail closed unless their working directory resolves inside a Git worktree. The runtime canonicalizes to the Git top-level before creating cache, trace, sandbox, or durable state, preventing accidental artifact spill into parent folders such as `E:\\dev`.

Read-only tasks use a dedicated inspection policy: no writer worktree, no behavioral-receipt requirement, no integration gate, and a before/after source fingerprint check. Structured read-only leaves run in the root workspace and never allocate duplicate Git worktrees.

Runtime storage is bounded. Trace files are rotated/pruned by file count, total bytes, per-file size, and age. Evidence cache uses entry, age, and byte quotas with automatic garbage collection. Durable runtime event journals compact before unbounded growth. Active task sandboxes are reclaimed on session shutdown. `/ues-clean` removes transient traces/services/dashboard state and rebuildable semantic/verification cache entries; evidence blobs are quota-pruned instead of blindly deleted, and evidence referenced by live verified memory is protected. Durable `.ues-work`, memory, learning, eval state, and verified-memory evidence are preserved. Parallel read-only work may still use the wider worker pool, while write waves are capped separately (`UES_MAX_WRITER_CONCURRENCY`, default 2 on Windows) to reduce peak worktree/build disk pressure.

A semantic `REVISE` from the plan checker now receives one bounded architect revision and one re-check before UES surfaces the failure to the user. This keeps fail-closed verification while avoiding needless manual prompt retries.

## V15.11 Session Identity Sync

UES keeps Pi session metadata aligned with the active engineering command instead of leaving the session selector named after an earlier conversational message. `/ues-run` derives a bounded deterministic session name from the task without an extra model call. Prompt-style commands such as `/ues-resume`, `/ues-fix`, `/ues-review`, and related UES aliases synchronize through Pi's interactive input hook.

Session display synchronization is UX-only and fail-safe: `pi.setSessionName()` updates the durable Pi session label, while `ctx.ui.setTitle()` is best-effort. Failure to update display metadata must never block controller execution, verification, resume, or cleanup.

## V15.10 Adaptive Stability Runtime

Planning children use activity-aware bounded deadlines. The initial hard deadline remains short for responsiveness, but recent real activity may extend it in bounded increments; an absolute deadline and the independent idle watchdog still terminate hung work. RPC timeout paths preserve partial assistant output before worker teardown, and CLI fallback uses the same deadline model.

Structured architect work is machine-first: when `UES_PLAN_JSON` is requested, the graph is emitted before optional prose. If transport ends after a complete graph has already been emitted, UES may salvage it only when normalization and deterministic plan validation succeed; the independent plan-checker is still mandatory before execution.

High-risk DEEP tasks keep full evidence budgets for executor/verifier/integration roles. Only read-only architect and plan-checker context is role-bounded, using targeted repository tools to fill concrete evidence gaps.

## V15.9 Runtime Artifact Isolation

UES runtime state is not task source state. Structured sandbox delta, declared write-scope checks, same-wave conflict detection, dirty-root inheritance, and sandbox integration now exclude UES-owned runtime directories such as `.ues-traces/**`, `.ues-cache/**`, `.ues-services/**`, `.ues-work/**`, and the other runtime-state directories covered by the shared runtime-artifact contract.

This filtering does not weaken source safety. Real repository files such as `apps/mobile/package.json` remain source-facing mutations and must still be declared by the task before integration.

## V15.8 Plan Gate Recovery

Plan-checker now uses an adaptive bounded policy instead of failing immediately at the old 45-second hard limit. The first pass is soft-steered toward an immediate verdict before its hard timeout; transport/runtime timeout without a semantic verdict receives one shorter warm-context recovery pass. A real REVISE verdict still fails closed.

Sandbox cleanup also scans the repository-specific UES sandbox directory directly. This allows `/ues-clean` to remove stale physical sandbox folders whose Git worktree registration was already lost after a crash or manual prune, while protecting active/live-owner sandboxes.

## V15.7 Lightweight Sandbox Cleanup

UES direct controller runs now track active task worktrees by trace and reclaim their own leftovers when the run ends, including Stop/error paths. Active worktrees remain protected. Stale same-process worktrees can be reclaimed without waiting for Pi to exit, legacy pre-lease worktrees use a 30-minute grace, orphan metadata sidecars are removed, and an empty sandbox base directory is deleted automatically.

The `/ues-clean` command performs the same safe stale-artifact cleanup on demand for the current repository.

## V15.6 Fast Planning

DEEP planning now has explicit latency budgets. Architect exploration is soft-steered after roughly 30 seconds or 16 tool calls and is terminated if it exceeds a 60-second hard or 25-second idle budget. A failed first pass gets one shorter cached recovery rather than a full rediscovery pass. Plan-checker has its own short budget; executor/verifier limits are unchanged.

Task worktree sandboxes now carry an owner PID lease. Before a new controller run, UES may remove old UES sandboxes whose recorded owner is no longer alive. Legacy sandboxes without leases use a conservative grace period.

## V15.5 Per-Leaf Turbo

Large DEEP tasks are decomposed into independently classified leaf tasks. A low-risk single-file leaf can use FAST execution and deterministic-first verification while the root plan still keeps final integration/completion gates. Retry evidence is reduced to a task-local failure delta, and context reuse is keyed by root repository namespace plus workspace fingerprint so equivalent retry worktrees can hit warm context safely. UES does not promise a universal 99% cache hit rate: first runs and changed source must miss; the target is very high warm-hit reuse for unchanged stable state without stale evidence.

## V15.4 ACP-safe child runtime

When UES is hosted by an ACP adapter such as Zed, specialist children must not reuse the ACP adapter's Node entrypoint. UES now verifies that a reusable host script belongs to `@earendil-works/pi-coding-agent`; otherwise Windows resolves the real managed Pi CLI or PATH Pi command. This prevents child specialists from rebinding the ACP host port and failing with `EADDRINUSE`.

## V15.3 DEEP Speed

DEEP/high-risk work keeps its full evidence and verification gates, but avoids redundant exploration. Generic long-horizon "fix" wording no longer forces a debugger before architecture unless concrete failure evidence exists. Architect, plan-checker and executor roles must consume the supplied UES context pack and declared task scope before broad repository searches, and stop discovery when the required evidence is already sufficient.

## V15.2 Turbo Fast Path

FAST low-risk single-file work now preserves the original task policy through internal executor/verifier prompts, uses bounded first-attempt latency budgets, and prefers deterministic fresh verification receipts before spending a second model turn. Timeout/recovery remains fail-closed.

Pi headless eval diagnostics are collected from both stdout and stderr so direct `/ues-run` controller usage is measured correctly.

## V15.1 deterministic admission and managed services

On `main`, `/ues-run` is now an extension command rather than only a prompt template. Pi resolves extension commands before templates, so the controller starts deterministically even when a weak model would otherwise ignore `ues_execute`.

Long-running servers/watchers should use `ues_service`:

```text
start -> wait-ready/status/logs -> stop
```

The runtime blocks common foreground server commands in bash/powershell and directs the agent to `ues_service`. Services support TCP/log readiness, bounded log evidence and session cleanup. See `docs/V15-MANAGED-RUNTIME.md`.

## V14.2 Turbo Weak-Model Runtime

V14.2 keeps the Pi-native controller and specialist roles but changes the hot path to reduce repeated startup, context and verification work.

- `UES_CHILD_RUNTIME=auto` prefers persistent Pi RPC workers and falls back to one-shot CLI children.
- A fresh Pi session is started between specialist runs even when the worker process stays warm.
- Interactive steering is forwarded to the single active RPC child; stop/cancel/dừng/hủy abort active children. RPC steer/abort control waits are bounded to 3 seconds by default before abort escalates to process-tree termination.
- `pi/extensions/ues-child-runtime.ts` is loaded explicitly in child sessions for output compaction, evidence recovery, shell safety and verification receipts.
- Test/lint/typecheck/build commands receive bounded default timeouts when the model omitted one.
- Pi's `details.fullOutputPath` is used when available so Evidence Store can preserve the full shell output instead of only the visible truncated tail.
- Low/medium-risk verifier roles may reuse an exact fresh PASS receipt when the workspace fingerprint is unchanged; high-risk verification does not receive this optimization.
- Context uses adaptive role budgets, bounded micro-skills, cached dependency graphs and affected-test hints.
- DEEP/long-horizon structured runs auto-create `.ues-work/<slug>` and require plan/task/integration receipts before finalization.

Useful switches:

```text
UES_CHILD_RUNTIME=auto
UES_RPC_MAX_WORKERS=8
UES_RPC_CONTROL_TIMEOUT_MS=3000
UES_ADAPTIVE_CONTEXT=1
UES_MICRO_SKILLS=1
UES_AFFECTED_TEST_HINTS=1
UES_CHILD_TOOL_COMPACTION=1
```

See `docs/V14.2-TURBO-WEAK-MODEL-RUNTIME.md`.

## Commands and prompt templates

Deterministic extension command:

```text
/ues-run
```

Prompt templates:

```text
/ues-plan
/ues-feature
/ues-fix
/ues-debug
/ues-review
/ues-verify
/ues-audit
/ues-research
/ues-critique
/ues-resume
```

There is intentionally no `pi/prompts/ues-run.md`; keeping that file would create two visible `/ues-run` entries in Pi.

## Safety

The extension intercepts risky `bash`/`powershell` calls and applies the UES destructive-command guard. Interactive Pi can ask for confirmation; non-interactive risky execution fails closed.

## Validation

Run from the repository:

```cmd
npm ci --ignore-scripts
npm test
npm run syntax
npm run smoke:pi
npm run smoke:package
npm pack --dry-run
```

The npm package manifest is Pi-only: it does not run lifecycle setup for another coding-agent host.


## Weak-model benchmark

Use the Pi-native benchmark to compare the same model with and without UES:

```cmd
ues eval-pi --model provider/model --thinking low --suite live --trials 3 --mode both
```

Each run uses an isolated workspace and an external grader. Extension discovery is disabled for fairness, then the model-provider extension is loaded explicitly in both baseline and UES modes; only UES mode additionally loads the UES extension. For `kilo/...` models the benchmark reuses the installed Kilo Pi provider when available and otherwise uses `git:github.com/Kilo-Org/kilo-pi-provider`. Other custom providers can be supplied with repeatable `--provider-extension <source>`. UES mode uses an isolated `UES_CONFIG_DIR` so role routing cannot silently substitute a stronger configured model. Telemetry includes parent and child-agent token/tool usage.

When `--mode both` is used, V14.2 also emits paired benchmark confidence. The turbo promotion view requires quality non-regression, isolated baseline arms, no controller false-PASS, bounded overhead and at least one measured efficiency improvement.

## Model routing

Runtime model routing is configured with `ocskill models ...` and is consumed directly by Pi child-agent dispatch. Set `UES_CONFIG_DIR` to override the UES config root. If a native UES policy does not exist, the runtime can read an existing legacy OpenCode model policy for migration compatibility.

## Package closure

`npm run smoke:package` inspects the actual npm pack file list, verifies required Pi/runtime files are present, checks relative module imports do not point outside the published package, and smoke-runs the deterministic task policy. This guards against the previous class of errors where Git installs worked but npm publication omitted a core dependency.


## V14 context and memory fabric

Pi child-agent dispatch keeps the existing specialist set. V14 strengthens the context supplied to those agents instead of adding more roles:

- L0/L1 hierarchy scopes are selected before broad L2 excerpts;
- only evidence-verified, non-superseded project memories are injected;
- capability providers expose deterministic health and fallback state.

Useful deterministic commands:

```cmd
ues capability-fabric status .
ues hierarchy "task query" .
ues memory status .
ues memory search "task query" .
```

`ues_execute` may persist a verified episodic memory only after an independent verifier has returned PASS. The memory record is backed by a content-addressed evidence receipt and is stored under ignored local `.ues-memory/` state.

See `docs/V14-CONTEXT-MEMORY-FABRIC.md`.