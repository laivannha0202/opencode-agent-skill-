# Changelog

All notable changes to this project are documented here.

The project follows Semantic Versioning.

## [Unreleased]

### Changed
- The public npm distribution name is now the unscoped `opencode-agent-skill`, so users install it with `npm install -g opencode-agent-skill`.

### Fixed
- Packed global-install smoke derives the package install path from package metadata instead of assuming the former scoped npm name.
- The installer accepts the former `@laivannha0202/opencode-agent-skill` state owner as legacy UES ownership and re-owns it as `opencode-agent-skill` during the next install.

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
- Live evaluation runs are asynchronous and observable: start messages, periodic heartbeats, hard timeout, idle timeout and Ctrl+C process-tree cancellation are supported.
- V2 fresh task dispatch refreshes durable task leases while the executor session runs and reports task policy/runId alongside model policy.
- Workspace fingerprints ignore UES runtime-only learning/dashboard/sandbox directories in addition to `.ues-work`.
- Package version is 7.7.0.

### Fixed
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
