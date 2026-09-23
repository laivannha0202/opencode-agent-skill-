# Changelog

All notable changes to this project are documented here.

The project follows Semantic Versioning.

## [Unreleased]

### Changed
- Durable `.ues-work` task contexts now recall the same evidence-verified V14 memory used by inline Pi execution and expose bounded selected/fallback provider hints from Capability Fabric.
- Finalized durable work now records a non-fatal evidence-backed episodic memory using the plan's declared file scope.
- Adaptive Pi context now exposes Capability Fabric provider selections so weaker models do not have to guess which healthy backend should satisfy a capability.

### Fixed
- Explicit file scope is authoritative when recording verified task memory, preventing unrelated pre-existing dirty files from contaminating future recall.
- Workspace fingerprints now ignore `.ues-memory/` state in both Git and non-Git workspaces, so memory writes cannot invalidate otherwise fresh verification evidence.

### Regression coverage
- Added durable-context parity coverage for verified memory, provider hints, finalization memory, explicit memory file scope, and non-Git memory fingerprint isolation.

## [14.0.0-beta.1] - 2026-09-24

### Added
- Persisted capability success/failure/latency observations under ignored `.ues-learning/` state with bounded confidence before routing influence.
- Added task-class affinity, expiry filtering and usage accounting for verified persistent memory.
- Added hierarchy scope diversity so a single parent/child directory chain cannot consume the context scope budget.
- Exposed V14 capability-fabric health alongside memory status in Control Center.

### Changed
- Adaptive context now passes the current task class into memory retrieval and records actual recalled-memory usage.
- Capability routing can learn away from repeatedly failing providers without letting one transient failure poison selection.

### Regression coverage
- Added focused V14 tests for learned provider failover, hierarchy diversity, memory expiry/task-class/use tracking and Control Center telemetry.

## [14.0.0-beta.0] - 2026-09-24

### Added
- Added a deterministic capability fabric with provider health checks, primary/fallback selection, quality/cost/latency scoring, project overrides and `ues doctor` visibility.
- Added hierarchical repository context with bounded L0 routing abstracts, L1 subtree overviews and existing L2 source/test/instruction excerpts.
- Added verified persistent project memory under ignored `.ues-memory/` state with candidate/verified/superseded lifecycle, durable Evidence Store requirements, confidence and reinforcement metadata.
- Added hybrid memory retrieval combining BM25-style lexical relevance, deterministic hashed-vector similarity, file-path affinity, recency/confidence and reciprocal-rank fusion.
- Added `capability-fabric`, `hierarchy` and `memory` CLI surfaces plus V14 Control Center memory telemetry.
- Added V14 deterministic contract/eval fixtures for hierarchy routing, evidence-backed recall, supersession, provider failover and context contamination.

### Changed
- Adaptive task context now scope-boosts semantic references using the hierarchy and injects only bounded verified memories into child Pi context.
- Pi `ues_execute` records an episodic memory only after independent task/integration verification passes; memory failures remain non-fatal to an already verified engineering task.
- Semantic indexing excludes `.ues-memory/` runtime state.

### Safety
- Candidate or superseded memories are never retrieved.
- Memory verification fails closed without a named verifier, PASS verdict and at least one existing content-addressed evidence reference.
- Supersession requires the replacement memory to be verified first.
- Optional capability providers may be unavailable without pretending to be healthy or failing unrelated capabilities.

### Regression coverage
- Added focused V14 unit and CLI tests for capability fallback, L0/L1 hierarchy bounds, verified-memory retrieval, supersession, evidence fail-closed behavior and adaptive-context injection.


## [13.0.0-beta.3] - 2026-09-23

### Fixed
- Separated sensitive-domain detection from high-risk mutation detection so read-only requests that merely mention database, auth, payment, security, production or public API concepts no longer escalate to DEEP by keyword alone.
- Stripped explicit read-only negations such as `do not edit`, `without editing`, `không sửa` and `chỉ đọc` from mutation-risk matching so safety instructions do not become false mutation signals.
- Kept real sensitive mutations high-risk, including database/schema migrations, auth or permission changes, payment-flow changes, production deployment, secret/credential rotation, destructive Git/database actions and breaking public-API changes.
- Aligned V2 skill routing with the corrected risk semantics so FAST read-only domain inspection keeps direct domain skills without generic orchestration or change-impact overhead.
- Preserved the beta.2 adaptive `/ues-run` transport fix: the real user request drives FAST/STANDARD/DEEP admission, while `/ues-resume` remains explicitly durable.

### Regression coverage
- Added exact regression coverage for the reported Vietnamese read-only repository inspection that mentions `database`.
- Added coverage proving read-only auth/payment review is not high-risk while a real production database migration remains DEEP/high-risk.
- Added routing coverage proving read-only database inspection keeps the direct database skill but drops orchestrator/change-impact skills under FAST policy.

## [13.0.0-beta.2] - 2026-09-23

### Fixed
- Routed all 11 `/ues-*` commands through the stable V2 `session.prompt` path using router-managed prompt aliases, avoiding `UnsupportedContentType` failures from the native `session.command` transport while preserving compatible command behavior.
- Prevented `/ues-run` from duplicating the full `$ARGUMENTS` payload inside its task-policy example, reducing long-prompt amplification.
- Fixed OpenCode V2 local router loading on clean global configs by removing the unnecessary bare `@opencode/plugin` runtime import; `ues-router` now exports the plain `{ id, setup }` definition accepted by the V2 loader.
- Prevented OpenCode V2 UES router subprocesses (`where`, `ocskill`, Node shim execution and Git probes) from flashing transient CMD windows on Windows by routing them through a hidden-window spawn wrapper.
- Changed `/ues-run` from an unconditional long-horizon declaration into adaptive FAST / STANDARD / DEEP admission driven by the actual user request and task policy.
- Removed the synthetic `Explicit long-horizon engineering request.` policy input for `/ues-run`; only `/ues-resume` retains explicit durable-resume semantics.
- Added compact FAST and STANDARD V2 prompt envelopes so trivial or bounded work does not inherit `.ues-work`, plan-gate, subagent-dispatch and integration-gate overhead.
- Removed the V2 prompt-admission dependency on spawning the global `ocskill task-policy` shim. The router now classifies in-process using the same shared policy implementation as the CLI, so FAST/ STANDARD envelope selection does not depend on the OpenCode service PATH.
- Kept one task-policy implementation shared by the CLI and V2 router to prevent classification drift.

### Regression coverage
- Added V13 tests proving that `/ues-run Chỉ trả lời đúng một từ: OK` stays FAST, bounded fixes stay STANDARD, whole-repository work escalates to DEEP, and `/ues-resume` remains long-horizon.
- Added a contract test ensuring the bundled `/ues-run` template itself is adaptive rather than declaring every invocation long-horizon.

## [13.0.0-beta.1] - 2026-09-23

### Fixed
- Hardened V2 prompt aliases for ChatGPT-style pasted prompts: BOM/zero-width prefixes and whole-prompt markdown fences are normalized before alias detection.
- Bounded the text sent to `ocskill task-policy` so very large pasted prompts no longer risk Windows command-line length failures; the full user prompt still goes to the model while only a bounded head/tail classification view goes through the CLI.
- Routed skill classification from the actual user request instead of the expanded command template, reducing template-induced over-routing on long prompts.
- Kept installer result shape stable with `promptAliases: []` on foreign-state refusal.

### Regression coverage
- Added fenced-paste, BOM, 70k-character policy-input and oversized multiline `/ues-run` regression tests.

## [13.0.0-beta.0] - 2026-09-22

### Added
- Added native same-model parallel execution through `ues.dispatch_parallel` with bounded adaptive concurrency.
- Added event-driven DAG scheduling so newly unblocked tasks can start without waiting for an entire wave barrier.
- Added read/write resource leases, conservative unknown-scope serialization and shared-config writer serialization.
- Added inherited-root worktree snapshots so downstream tasks see already integrated predecessor changes without committing the user's root branch.
- Added transactional integration with sandbox rollback when receipt/completion fails after patch application.
- Added fresh same-model verifier sessions and agent-verifier receipts tied to the active run and current workspace fingerprint.
- Added global CLI help interception, structured `--json` errors, `work status .` workspace listing, UTF-8/UTF-16 auto-decoding, safe UTF-8 Git diff output and text normalization.

### Regression coverage
- Added V13 tests for CLI help parsing, structured errors, UTF-16 PowerShell-style diff decoding, event-driven same-model concurrency, resource conflict serialization and inherited-root rollback behavior.
- Added verifier-runtime regression coverage against forged/user-supplied PASS markers and malformed verdict lines.
- Added structured `verificationCommands` validation coverage for deterministic post-integration receipts.

### Fixed
- Fixed the V13 structured-verification regression test wiring so the current HEAD test suite can execute the new plan-schema assertions.
- Fixed npm 11+ lifecycle-script blocking in release smoke expectations: a plain global install may require the documented `ocskill install` resource-sync fallback, and CI now verifies that fallback instead of falsely requiring postinstall execution.
- Clarified OpenCode 1.x versus V2 capability boundaries and fenced canonical long-task state to `.ues-work/<slug>/`; legacy/manual `ues-work/` directories are no longer treated as official UES state.
- Added `repo-graph --compact` and switched initial long-run evidence gathering to compact hotspot/count summaries to reduce large-repository context/tool-output overhead.
- Made `ocskill install/status/doctor` surface the OpenCode 1.x versus V2 native-parallel boundary directly so users do not mistake V13 CLI availability for fresh-session parallel availability.
- Hardened migration from V12/manual Windows artifacts by auto-decoding UTF-8/UTF-16 `PLAN.json`, `STATE.json`, `SPEC.md` and dependency reports across the CLI/task engine and V2 parallel router.
- Added bounded `ocskill text-read` so OpenCode 1.x can recover known UTF text that its generic Read tool classifies as binary, without creating ad-hoc converted copies.
- Extended packed-install smoke and regressions to cover the UTF recovery command, UTF durable state discovery and legacy artifact context packs.
- Removed the stale clean-root-only restriction from native parallel dispatch. Existing dirty repository state is now treated as an inherited baseline, while isolated worktree delta integration, resource leases and rollback continue to protect user changes.
- Fixed inherited untracked-file handling so a parallel worker may safely edit an unchanged pre-existing untracked file, while a user edit that races after sandbox creation is still detected and rejected as a conflict.
- Aligned legacy smoke tests with V13 structured usage exit code 2 and typed verification evidence (`command-receipt-backed` / `independent-agent-receipt-backed`).
- Fixed `work status` receipt coverage accounting for the typed V13 evidence strengths and made inherited-untracked worktree regressions line-ending neutral on Windows.


## [12.0.0-beta.0] - 2026-09-22

### Beta
- Added empirical per-task-class model performance history and capability-preserving reranking with a minimum evidence threshold before reranking.
- Added context quality receipts for required-file recall and irrelevant-context ratio.
- Added hash-keyed plan snapshots with active-plan execution fencing.
- Added bounded decision policy for reversible local rulings versus human-gated destructive/external actions.
- Added deterministic repo-scale benchmark fixture generation and V12/repo-scale validation gates.
- Hardened release consistency checks to derive eval counts and validate aggregate workflow structure.
- Fixed missing empirical-history handling so models without benchmark history safely fall back to static capability routing.

### Verified locally on Windows
- 255 tests total: 253 passed, 0 failed, 2 platform-specific skips.
- Syntax, catalog validation, docs consistency, routing, V11/V12/repo-scale/live/long/polyglot validation: PASS.
- npm pack, packed-install smoke and plain one-command install/resource auto-sync smoke: PASS.
- Published prerelease intent: npm dist-tag `next`; V11 remains `latest` until V12 stable release gates are satisfied.


## [11.0.0] - 2026-09-22

### Released
- Promoted V11 perception-aware adaptive execution to stable after the full local CI gate passed on Windows with 234 tests total, 232 passed, 0 failed and 2 platform-specific skips.
- Stable npm installs use the default `latest` dist-tag, so users install with `npm install -g opencode-agent-skill`.
- Includes content-addressed Evidence Store, adaptive EvidenceBudget/context externalization, stable-prefix prompt telemetry, capability-aware model routing, visual geometry receipts, deterministic PNG diff/crop, responsive/design-token inspection, optional Playwright browser inspection, cost-aware dynamic workflow scheduling, 48 focused skills and 12 subagents.

### Verified
- Syntax: 178 JavaScript modules.
- Catalog: 48 skills, 11 commands and 12 subagents.
- Router: 129 cases, 294/294 required routes and 61/61 negative guards.
- V11 contracts: 13 tasks across 6 categories and 15 required runtime files.
- Live/long/polyglot fixture validation: 20 / 5 / 8 tasks.
- npm pack dry-run, packed-install smoke and plain one-command install/resource auto-sync smoke: PASS.

### Changed
- Package version is 11.0.0.
- V11 becomes the stable npm release line; V10 remains in Git history as the previous stable release.


### V11 dev.2
- Added project-local, fail-closed Playwright browser inspection that returns bounded semantic elements, bounding boxes, computed visual properties and a screenshot path while treating page content as untrusted evidence.
- Exposed browser inspection through CLI and the OpenCode V2 router without making Playwright a required package dependency.
- Fixed duplicate `ui_layout` router tool registration and aligned durable context packs with V11 context schema version 6.
- Extended V11 validation and regression coverage for the browser runtime.
- Package development version is 11.0.0-dev.2.

## [11.0.0-dev.1] - 2026-09-22

### Added
- Adaptive context engine that externalizes oversized source/test/reference excerpts into content-addressed evidence pointers while keeping bounded inline previews.
- Deterministic UI layout and design-token tools exposed to the OpenCode V2 runtime.
- Cost- and modality-aware workflow scheduling with inline thresholds, deterministic-first waves, independent LLM/vision concurrency and bounded wave cost.
- Repeated-stable prompt ratio telemetry and an optional fail-closed ablation gate for repeated input efficiency.
- Stronger V11 contract coverage for adaptive context, UI inspection and evidence externalization.

### Changed
- V11 router metadata now reports version 11.
- Task context packs transport large contextual evidence through `evidence:sha256` pointers and report externalized byte/ref counts.
- Capability-aware model routing fails closed when an enabled configured model set cannot satisfy required capabilities such as vision/browser.
- Package development version is 11.0.0-dev.1.

### Fixed
- V11 eval-report regression tests now account for expanded adaptive telemetry coverage instead of using the old V10-only telemetry shape.

## [11.0.0-dev.0] - 2026-09-22

### Added
- Content-addressed Evidence Store with bounded retrieval, deduplication and garbage collection.
- Adaptive Evidence Budget planning and context-manifest integration for evidence-efficient execution.
- Prompt stable-prefix/cache telemetry for repeated-input measurement.
- Capability registry and capability-aware model selection for coding, reasoning, tools, vision, browser, filesystem and long-context needs.
- Visual specification, geometry receipts, responsive viewport matrix, dependency-free PNG decode/diff/crop and bounded visual repair planning.
- Browser QA adapter with CLI-first verification planning, targeted semantic evidence and explicit untrusted-page security boundaries.
- Cost-aware dynamic workflow scheduler separating deterministic work from LLM/vision work.
- Skill-quality linting for entrypoint size, metadata and routing-description collision detection.
- Nine V11 skills: visual-fidelity, browser-qa, design-source, responsive-verification, component-visual-testing, browser-security, skill-authoring, skill-evaluation and dynamic-workflow.
- Two V11 subagents: visual-verifier and merge-arbiter.
- Optional Hermes sidecar workflow contract with evidence-pointer transport.
- V11 Control Center evidence-store/runtime telemetry and V11-specific tests/eval routing cases.

### Changed
- Model policy schema supports per-model capability metadata plus cost, latency and quality hints.
- Adaptive model resolution can select configured models by required task capabilities.
- OpenCode V2 router recognizes visual/browser/design/skill-workflow intents and keeps FAST routing selective.
- Package version is 11.0.0-dev.0 while npm latest remains V10 stable until V11 release gates pass.

## [10.0.0] - 2026-09-22

### Released
- Promoted V10 RC.2 to stable after the local full gate passed with 182 tests passing, 0 failing, 2 platform-specific skips, plus package and install smoke validation.
- Stable npm installs use the default `latest` dist-tag, so users install with `npm install -g opencode-agent-skill`.
- Includes adaptive context/routing, weak-model recovery, no-progress watchdog, duplicate/loop guards, bounded exploration output, durable compaction checkpoints, provider recovery and retryable lease recovery.

### Changed
- Package version is 10.0.0.
- V10 stable keeps FAST at 8k, STANDARD at 20k and DEEP at 48k while preserving configured executor capability and correctness-first verification gates.

## [10.0.0-rc.2] - 2026-09-22

### Added
- No-progress watchdog for fresh executor sessions with active-tool grace so legitimate long-running tools are not killed merely for being quiet.
- Duplicate exploration guard and loop detector for repeated read/grep/glob-style calls without new workspace/evidence progress.
- Runtime tool-output budgets for large grep/glob/read/repo-graph style outputs.
- Durable pre-compaction checkpoints containing current task, runId, plan hash, workspace fingerprint, evidence pointers and a structured next action.
- Post-compaction resume enforcement with automatic fresh-session recovery when the next action is not executed.
- Provider failure classification and recovery for no-token, timeout, rate-limit, upstream, quota, auth and context-overflow failures.
- Periodic lease supervisor that recovers expired running executors to an explicit retryable state.

### Changed
- Provider stalls retry once in a fresh session with the same model; repeated retryable provider failures use the configured escalation model/provider when available.
- Stale lease recovery now records `retryable` instead of overloading terminal/logical `failed`.
- Explicit `long/high-risk`, `high-risk`, and structured long/high-risk facts hard-override FAST/light routing to DEEP/heavy.
- Package version is 10.0.0-rc.2.
- npm tag releases publish prereleases under `next`; stable versions continue to use `latest`.

### Fixed
- A post-compaction session that only emits narrative text without executing the persisted next action is treated as stalled instead of silently completing.

## [10.0.0-rc.1] - 2026-09-22

### Added
- Initial-input token telemetry and aggregate reporting for baseline-vs-UES evaluation.
- Attempt-aware recovery policy with bounded context/skill escalation from initial execution to diagnosis and deep recovery.
- Policy-aware FAST runtime routing that prioritizes direct domain/debug/review skills over generic orchestration.
- Benchmark efficiency gates for initial input tokens and total tokens.
- Reference-vs-candidate ablation CLI that requires pass-rate preservation and measurable initial-context reduction.

### Changed
- FAST context budget is 8k and STANDARD is 20k; DEEP remains 48k to preserve high-risk/long-horizon capability.
- Always-loaded global engineering instructions are compressed while retaining exact-contract, evidence, verification, safety and durable-work invariants.
- Retry context expands only after failure; repeated failures add graph/critic evidence instead of repeating speculative patches.
- Adaptive model policy exposes recovery stage and does not silently downshift the configured/default executor tier for FAST tasks.
- OpenCode V2 router metadata is versioned for the V10 policy-aware path.
- Package version is 10.0.0-rc.1; npm publication/tagging is intentionally deferred until RC verification passes.

## [9.0.0] - 2026-09-22

### Added
- Persistent incremental source index with bounded syntax-aware symbol/reference evidence and deterministic cache reuse.
- Weak-model-oriented ACI commands for semantic search, exact text search, bounded file viewing and reference lookup.
- FAST / STANDARD / DEEP execution profiles with adaptive context budgets, skill caps and verification depth.
- Redacted operational trajectory JSONL for replay/debugging without recording hidden chain-of-thought.
- Optional Docker/Podman verification sandbox with network-off, dropped capabilities, no-new-privileges and resource bounds.
- Paired baseline-vs-UES confidence analysis with exact sign-test evidence, per-suite no-regression checks and speed limits.
- Fail-closed `npm run evals:matrix:gate -- --model provider/model` release benchmark gate.
- Regression tests for semantic index, ACI, trajectory redaction, sandbox arguments, benchmark confidence and stale lock takeover.

### Changed
- Context Manifest v4 consumes the incremental evidence index before broader graph expansion and keeps evidence labels explicit.
- Learning promotion now requires complete paired benchmark evidence, statistically supported uplift and no suite regression.
- OpenCode V2 dispatch records bounded redacted operational traces and adaptive execution-profile metadata.
- Hardened live benchmark fairness by making previously implicit hidden-grader contract details explicit in task prompts without weakening hidden graders.
- Clarified webhook stale/duplicate handling to require returning the exact original state reference, matching the hidden contract.
- Counterbalanced paired live-eval execution order across tasks and trials to reduce provider order/throttling bias.
- Focused small/FAST fixes now follow literal acceptance-contract discipline and avoid repo-wide discovery unless evidence requires it.
- OpenCode live-eval telemetry now reads native `part.tokens` / `tokens` payloads in addition to `usage` payloads.
- Extracted shared CLI parsing/read/truncation/error helpers into `lib/cli-utils.mjs` and added smoke/unit regression coverage.
- Preserved documented CLI edge semantics while removing ad-hoc option parsing and unifying bounded output clipping.
- Resolved README version drift and documented V9 capabilities.
- Package version is 9.0.0.

### Fixed
- State locks use unique ownership tokens, heartbeat refresh and rename-based stale takeover so an expired owner cannot delete a replacement lock.
- Generated `.ues-cache/` and `.ues-traces/` state no longer invalidates workspace verification fingerprints.
- Windows CLI/router execution no longer falls back to shell-based `.cmd/.bat` invocation for unrecognized shims.
- Windows doctor/OpenCode compatibility probing safely resolves extensionless Node-backed npm shims and fails closed instead of invoking `cmd.exe`.
- Live benchmark execution now uses the same shell-free Windows resolver as `doctor`, skips unsupported batch shims in favor of safe native executables, and normalizes shim paths cross-platform.
- Windows npm shim resolution can recover from non-standard `.cmd` formatting by resolving only an adjacent package's explicit `package.json` bin mapping, including extensionless Node launchers such as OpenCode.
- Windows shim resolution also accepts validated native PE targets declared by npm package metadata, covering `opencode-ai` installs whose `bin.opencode` points to `bin/opencode.exe`.


## [8.0.0] - 2026-09-20

### Added
- Structured plan and integration gate receipts bound to the current plan hash or workspace fingerprint, with gate receipts persisted in `EVIDENCE.json`.
- Strict long/high-risk task completion that requires a successful verification receipt for the active `runId` and the current workspace fingerprint.
- Append-only `EVENTS.jsonl` runtime journal for work initialization, plan import/approval, task start/heartbeat/session binding, verification receipts, failure/recovery, integration verification and finalization.
- Task-scoped stale recovery and OpenCode V2 runtime tools for bounded executor cancellation/recovery.
- Context manifest v3 with multilingual task terms, Git-change awareness, symbol hits, TF-IDF-style relevance scoring, related tests/instructions and adaptive centered excerpts.
- Conflict-aware Git worktree integration plus automatic isolation support for concurrent writing executors.
- Learning v2 with recurring failure clustering, explicit acceptance and shadow-benchmark promotion gates.
- UES benchmark matrix runner for baseline-vs-UES comparison across standard, long-horizon and polyglot suites.
- Eight polyglot benchmark tasks spanning Python, Java/Spring-style code, .NET, Next.js, React Native, SQL migration, monorepo boundaries and generated-contract discipline.
- Control Center runtime-event visibility, receipt inspection and stale-task recovery control.
- CodeQL, dependency review, Dependabot maintenance and release-tag/version consistency checks.

### Changed
- Fresh OpenCode V2 executor sessions now use bounded waits and `session.interrupt` on timeout, with capability probing and graceful degradation when optional hooks are unavailable.
- Process execution escalates Unix process-tree cancellation from SIGTERM to SIGKILL after a bounded grace period and always reports cancelled runs as nonzero.
- Router/task policy adds multilingual and framework-aware signals while preserving deterministic caps.
- Managed resource ownership now uses `managed-by: opencode-agent-skill` while automatically recognizing and migrating the former scoped marker.
- Package version is 8.0.0. Existing `opencode-agent-skill@7.7.0` users remain on the same package name and can update normally.

### Fixed
- Strict verification no longer accepts a receipt after the workspace changed.
- Sandbox cleanup refuses to delete non-UES branches and removes temporary UES branches after successful integration.
- Learning proposals cannot be promoted before explicit acceptance.
- Plain npm-install smoke now reports lifecycle-script auto-sync versus explicit `ocskill install` recovery accurately.

## [7.7.0] - 2026-09-20

### Added
- Crash-safe long-task leases with per-attempt `runId`, executor owner metadata, heartbeat timestamps, lease expiry, explicit heartbeat command and stale-task recovery.
- Structured verification receipts with command/args, exit code, timing, SHA-256 output digests, task/run fencing and before/after workspace fingerprints.
- Context intelligence manifests that add declared files, import neighbors, likely tests, repository instructions/manifests, bounded excerpts and accepted learnings to fresh executor handoffs.
- Adaptive task classification via `ocskill task-policy` and risk/complexity-aware model selection layered on top of attempt escalation.
- Read/write-aware safe-wave scheduling plus isolated Git worktree sandbox primitives for parallel write tasks.
- Evidence-gated learning loop over `.ues-evals` with deterministic proposals, explicit acceptance and relevant accepted lessons fed back into future context packs.
- Optional Hermes adapter commands that detect Hermes and emit bounded UES delegation prompts without embedding Hermes into the UES runtime.
- Zero-dependency local UES Control Center for durable work state, evidence, learning proposals and recent evaluation summaries.
- V2 runtime capability probing tool and fail-closed fresh-dispatch checks.

### Changed
- The public npm distribution name is the unscoped `opencode-agent-skill`, so users install it with `npm install -g opencode-agent-skill`.
- Live evaluation runs are asynchronous and observable: start messages, periodic heartbeats, hard timeout, idle timeout and Ctrl+C process-tree cancellation are supported.
- V2 fresh task dispatch refreshes durable task leases while the executor session runs and reports task policy/runId alongside model policy.
- Workspace fingerprints ignore UES runtime-only learning/dashboard/sandbox directories in addition to `.ues-work`.
- Package version is 7.7.0.

### Fixed
- Packed global-install smoke derives the package install path from package metadata instead of assuming the former scoped npm name.
- The installer accepts the former `@laivannha0202/opencode-agent-skill` state owner as legacy UES ownership and re-owns it as `opencode-agent-skill` during the next install.
- Live baseline/UES evaluation detects the OpenCode major version: OpenCode 1.x omits the V2-only `--standalone` flag, while OpenCode 2.x+ keeps it. Eval JSON records the detected OpenCode version/major for reproducibility.
- The V2 automatic router retains domain/impact skills and `ues-engineering-orchestrator` ahead of generic process skills when the configured skill cap is exceeded.

## [6.0.0] - 2026-09-19

### Added
- Durable long-horizon work engine under `.ues-work/<slug>/` with SPEC, machine-readable PLAN/STATE/EVIDENCE, task briefs and reports.
- Four long-horizon roles: `ues-codebase-mapper`, `ues-plan-checker`, editable `ues-executor`, and `ues-integration-verifier`.
- `/ues-run` and `/ues-resume` commands.
- Deterministic `repo-graph`, `review-scope`, `verification-plan`, `task-graph`, `context-pack`, and `ocskill work` commands.
- Dependency-safe DAG waves with conservative declared-file overlap serialization.
- Machine-enforced plan approval through `ocskill work approve-plan`.
- Machine-enforced integration verdict through `ocskill work verify-integration`.
- Workspace fingerprint gate that invalidates finalization when code changes after integration PASS.
- Per-work-item lock and atomic state/evidence writes for parallel-safe durable state updates.
- OpenCode V2 `ues.dispatch_task` runtime tool that creates a fresh executor session and applies configured attempt-based model escalation.
- Configurable light/standard/heavy model tiers and role mappings.
- V2 permission safety gate for forceful Git, publish, destructive file/database and deployment commands.
- 120-case V2 router trigger evaluation.
- Five long-horizon behavioral tasks, including a combined 15-source-file integration task.

### Changed
- Package version is 6.0.0 and release documentation now describes 39 skills, 11 commands and 10 subagents.
- Long-suite UES runs count as PASS only when both the hidden grader and durable orchestration state pass.
- Long-task completion now requires independent plan approval, per-task fresh evidence, integration PASS, and an unchanged post-verification workspace.
- `.ues-work/` is git-ignored because it is runtime execution state.
- V2 runtime context guidance now prefers fresh `ues.dispatch_task` execution for approved tasks.

### Fixed
- Prevented concurrent `STATE.json` / `EVIDENCE.json` lost updates during safe-wave completion.
- `ocskill model-policy` now resolves against the user's persisted model-tier configuration instead of the default empty policy.
- Safety detection now recognizes short-form `git push -f`.


## [4.0.0] - 2026-09-19

### Added
- OpenCode 1.x/2.x compatibility detection with managed V2-native agent permission frontmatter.
- Optional OpenCode V2 runtime skill router installed as a managed global plugin, with `ocskill router on|off|status --max N` controls.
- Dependency-free deterministic repository helpers: stack detection, test-command detection, repository map, impact search, evidence snapshot, and working-tree inspection.
- `ocskill inspect`, `ocskill impact`, `ocskill evidence`, `ocskill working-tree`, `ocskill detect-stack`, and `ocskill detect-tests`.
- Twenty executable hidden-graded live benchmark tasks across correctness, auth, contracts, data, payments, security, frontend state, dependency compatibility, and multi-file changes.
- Live benchmark authentication modes: isolated environment credentials by default and optional current OpenCode auth-file copy.
- Best-effort OpenCode JSONL telemetry for tool calls, loaded skills, subagents, tokens, cost, and changed workspace files.
- `ocskill eval-report` / `npm run evals:report` for baseline-vs-UES pass-rate and efficiency aggregation.
- Live-suite integrity validation and broad JavaScript syntax validation in `npm run ci`.
- Progressive-disclosure workflow references for 18 previously shallow domain/process skills.
- OpenCode compatibility and deterministic-tool documentation.

### Changed
- Static routing evaluation now contains 34 scenarios and requires every installed skill to be represented at least once.
- Packed-install smoke testing now forces the OpenCode V2 compatibility path, checks native permissions, validates the managed router plugin, and exercises the packed `ocskill inspect` command.
- Core workflow guidance now prefers deterministic evidence helpers before broad model-driven repository exploration.
- Installer state schema records the detected OpenCode major and managed plugin resources.
- Package contents now publish the complete `lib/`, `scripts/`, and `global-config/` trees required by V4.

### Fixed
- `ocskill update` now resolves the explicit npm `latest` dist-tag with `npm view package@latest version` and falls back to `npm dist-tag ls`, avoiding stale untagged package metadata such as the observed 2.1.0/3.0.0 mismatch.
- Managed V2 router resources are removed safely when uninstalling or re-syncing back to an OpenCode 1.x environment.


## [3.0.0] - 2026-09-19

### Added
- Live baseline-vs-UES behavioral evaluation harness with isolated OpenCode configs, executable fixtures, hidden graders, multi-trial support, and JSON traces.
- Independent `ues-critic` subagent and `/ues-critique` command for evidence-grounded falsification before completion.
- Evaluator/repair orchestration reference with bounded critic-repair-reverify cycles.
- Context-ledger guidance that separates confirmed facts, assumptions, rejected hypotheses, decisions, and fresh verification evidence.
- Structured output contracts for architecture, debugging, research, review, critic, and verification subagents.
- Trace schema documentation for live benchmark results.

### Changed
- Long-task state now preserves rejected hypotheses and evidence so resumed work does not repeat disproved approaches.
- Completion gates now require substantial/high-risk changes to resolve or explicitly surface evidence-backed blocking critic findings.
- Installer tests now require the expanded command/subagent catalog and progressive-disclosure references.
- Added a packed-install smoke test that installs the tarball into an isolated global npm prefix and verifies the package is a real copy rather than a source link/junction.
- Bumped the package release line to 3.0.0 for the intelligence-loop and behavioral-eval release.

### Fixed
- `ocskill update` now checks the published npm version first, refuses accidental downgrades, avoids reinstalling an equal version, performs newer package replacement with lifecycle scripts disabled, then explicitly re-syncs resources from the newly installed CLI.
- `ocskill update` and `ocskill remove` now run npm from the user home directory instead of from inside the package directory being replaced or removed.

## [2.1.0] - 2026-09-18

### Added
- Evidence-driven `engineering-orchestrator` skill with progressive-disclosure routing, verification, retry, and delegation references.
- `context-engineering`, `research-verification`, `change-impact-analysis`, `long-task-state`, and pragmatic `test-driven-development` process skills.
- Five optional read-only/analysis subagents: architect, debugger, researcher, reviewer, and verifier.
- Four new commands: `/ues-plan`, `/ues-debug`, `/ues-verify`, and `/ues-research`.
- Static routing eval contract and `npm run evals` / `ocskill eval`.
- Engineering design and research-source documentation.

### Changed
- Expanded the catalog from 33 to 39 skills and from 4 to 8 commands.
- Installer now copies complete skill directories so references/templates survive installation.
- Installer now manages namespaced OpenCode subagents and tracks them in state.
- Strengthened repository exploration, planning, dependency management, root-cause debugging, code review, and verification.
- `ocskill status` now compares package/resource versions and reports subagent synchronization.
- `ocskill update` explicitly re-syncs resources after npm update.
- `ocskill remove` explicitly cleans managed resources before npm uninstall.
- Removed the Windows `shell: true` execution path that produced Node deprecation warnings.

## [2.0.1] - 2026-09-18

### Fixed
- Added dedicated npm lifecycle entrypoints and more reliable global-install detection on Windows.

## [2.0.0] - 2026-09-18

### Changed
- Converted the repository into a standard global npm CLI package.
- Package name became `@laivannha0202/opencode-agent-skill`.
- Standardized development and CI on Node.js + npm.

### Added
- Global `ocskill` CLI.
- Managed state under the global OpenCode config.
- Idempotent skill/command synchronization.
- Managed-block integration with an existing global `AGENTS.md`.
- npm packaging validation and Node.js tests.
- GitHub Actions workflow for npm publishing.

## [1.0.0] - 2026-09-18

### Added
- Initial universal engineering skill collection.
- Automatic engineering workflow rules.
- Commands for fix, feature, review, and audit.
