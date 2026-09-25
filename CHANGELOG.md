# Changelog

All notable changes to this project are documented here.

The project follows Semantic Versioning.

## [Unreleased]

## [14.2.0-beta.1] - 2026-09-25

### Added
- Added a persistent Pi RPC worker pool with fresh sessions between specialist runs, CLI fallback, bounded worker count, interactive steer forwarding and active-child abort support.
- Added a unified process-tree supervisor with hard/idle timeout, output caps, Windows/POSIX tree termination and bounded I/O drain.
- Added rolling streamed-output hang detection so split Jest open-handle warnings cannot evade the detector.
- Added role-aware adaptive context budgets, runtime context caching, workspace-fingerprint invalidation and cached dependency graphs.
- Added bounded micro-skill compilation so child agents receive selected domain/role rules without loading the full skill catalog.
- Added changed-file affected-test hints and fresh verification-receipt reuse at unchanged workspace fingerprints.
- Added a minimal child runtime extension for shell safety, verification-command timeout, tool-boundary receipts, full-output recovery and reversible compaction.
- Added selective JSON evidence retrieval with `#/json/pointer` and dotted selectors.
- Added personalized dependency-graph ranking to context selection.
- Added task-specific Playwright/Browser MCP subsets.
- Added confidence-bound empirical model routing and a larger default minimum sample threshold.
- Added automatic DEEP/long-horizon promotion to durable `.ues-work` state with plan, task and integration receipts.
- Added bounded operational trajectory events for controller/agent execution.
- Added shell segment analysis for compound destructive-command detection.
- Added baseline-contamination detection and a turbo benchmark promotion gate for quality non-regression plus efficiency improvement.

### Changed
- Test/lint/typecheck/build commands executed by child agents now receive policy-bounded default timeouts when no timeout was specified.
- Reusable child verification receipts now canonicalize safe simple shell commands into exact executable + argument keys, preventing unrelated checks from cross-reusing a PASS.
- POSIX process supervision now escalates against surviving descendants after the direct child exits, closing the inherited-pipe/open-handle gap that can otherwise keep test trees alive.
- Low/medium-risk verifiers can consume fresh executable-check receipts captured at the tool boundary; high-risk verification keeps independent fresh checking.
- Reusable executable-check receipts now require an unchanged verification state (`workspaceBefore === workspaceAfter === currentFingerprint`); checks that mutate repository state cannot seed a reusable PASS.
- Hot-path runtime caches now include regression/integrity guards for compiled micro-skills, affected-test caching and one-pass workspace snapshots.
- Runtime fingerprints now hash untracked file contents, avoid following untracked symlinks outside the repository, and fail closed when an untracked artifact is too large to fingerprint safely.
- Repository graph and affected-test scans now exclude all UES runtime/sandbox state while preserving legitimate source under `bin/`.
- CLI fallback children are tracked so interactive stop/cancel can terminate their process trees even when RPC steering is unavailable.
- Semantic snapshots are cached by trusted workspace fingerprint and shared across specialist context builds.
- Warm RPC workers are isolated by verification-timeout policy, and `auto` fallback is now startup-only: in-task RPC timeout/failure never triggers a blind second execution through CLI.
- Interactive stop/cancel now aborts the active RPC promise with exit-code-130 semantics; CLI fallback children remain tracked until termination is actually requested.
- Untracked workspace fingerprinting is bounded by both per-file and aggregate byte limits to avoid expensive cache-key scans on large local artifacts.
- Turbo benchmark promotion now requires explicit baseline-isolation evidence and explicit UES-controller telemetry for every paired UES arm.
- User stop/cancel is terminal across structured and ordinary retries: exit-code-130/aborted runs clean up state and are never promoted into another automatic attempt.
- User-aborted runs are excluded from model-performance learning so manual cancellation cannot poison future model routing.
- Semantic-index, dependency-graph and affected-test scanners coalesce concurrent identical builds, while the warm RPC worker map now uses true LRU refresh on reuse.
- Child output compaction runs before the result returns to the model and preserves recoverable Evidence Store references.
- Pi shell `fullOutputPath` is used when available so raw evidence is not limited to the already-truncated model-visible result.
- Browser MCP exposure is reduced from the discovered provider set to the subset relevant to the current browser/visual task.
- Model-performance reranking now uses a Wilson lower confidence bound instead of letting very small samples move weak-model selection.
- Verification-broker cache updates now use a cross-process lock so parallel child Pi workers cannot overwrite each other's reusable receipts; malformed/stale receipt metadata fails closed.
- RPC worker-cache eviction never terminates an active specialist just to satisfy the warm-worker limit; dead/idle workers are pruned safely and steer/abort control latency is bounded.
- The canonical local `npm run ci` release-consistency gate no longer depends on GitHub Actions workflow configuration.
- Source-integrity checks now protect the V14.2 regression suite and verification broker against accidental fragment/truncation overwrites.

### Safety
- Thinking level is not lowered by V14.2.
- Verifier, integration-verifier and visual-verifier gates remain in place.
- High-risk tasks disable child output compaction and receipt-reuse optimization by default.
- Child runtime independently blocks destructive shell commands even if the parent UES extension is not rediscovered inside the child.
- Non-Git runtime caches fail closed instead of reusing a root-only fingerprint.
- DEEP tasks refuse to report durable PASS when durable initialization or finalization cannot produce fresh receipts.

### Regression coverage
- Added V14.2 tests for adaptive context, micro-skills, affected tests, receipt freshness, process supervision, browser tool minimization, non-Git cache isolation, graph ranking, shell segment safety and selective evidence retrieval.
- Added benchmark tests for quality-parity efficiency promotion and controller false-PASS rejection.
- Extended Pi/package smoke contracts for the minimal child runtime, steering, process supervision, safety and full-output recovery.

## [14.1.0-beta.1] - 2026-09-24

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