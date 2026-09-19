# Changelog

All notable changes to this project are documented here.

The project follows Semantic Versioning.

## [Unreleased]

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
