# Changelog

All notable changes to this project are documented here.

The project follows Semantic Versioning.

## [Unreleased]

### Added
- V14.1 introduces a quality-preserving performance fabric for model-visible UES output. Oversized deterministic CLI output is compacted into a bounded head/high-signal/tail preview while the byte-exact original is stored in Evidence Store behind a recovery reference.
- Capability Fabric now detects RTK, Caveman and Headroom CLIs as optional output-compaction providers. The built-in reversible UES compactor remains the default; external providers are never auto-installed or auto-enabled.
- Pi browser tools are now routed on demand: Playwright/Browser MCP tools are discovered from the host registry and exposed only to browser/visual child tasks; visual tasks gain a final read-only visual-verifier gate.

### Performance safety
- Child model thinking level is unchanged, independent verifier/integration-verifier gates are unchanged, and compaction fails open to raw output if Evidence Store is unavailable.
- The executor now follows a minimal-solution ladder without trading away validation, error handling, security, data integrity, accessibility, compatibility, tests, observability or explicit requirements.
- `ues hierarchy` is compact by default and exposes `--full` for complete file lists, reducing accidental context bloat while preserving an explicit lossless path.
- Dynamic Workflow now skips the executor only for deterministic tasks with an empty write scope; the read-only verifier still runs at the inherited thinking level and must PASS.
- External command capability probes are cached for 60 seconds so optional RTK/Caveman/Headroom discovery does not repeatedly spawn command lookup processes.

### Changed
- Durable `.ues-work` task contexts now recall the same evidence-verified V14 memory used by inline Pi execution and expose bounded selected/fallback provider hints from Capability Fabric.
- Finalized durable work now records a non-fatal evidence-backed episodic memory using the plan's declared file scope.
- Adaptive Pi context now exposes Capability Fabric provider selections so weaker models do not have to guess which healthy backend should satisfy a capability.

### Fixed
- Explicit file scope is authoritative when recording verified task memory, preventing unrelated pre-existing dirty files from contaminating future recall.
- Workspace fingerprints now ignore `.ues-memory/` state in both Git and non-Git workspaces, so memory writes cannot invalidate otherwise fresh verification evidence.

### Regression coverage
- Added durable-context parity coverage for verified memory, provider hints, finalization memory, explicit memory file scope, and non-Git memory fingerprint isolation.
- Added focused coverage proving backend tasks do not receive browser tools while E2E/visual tasks selectively receive detected Playwright MCP tools.

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