# Changelog

All notable changes to this project are documented here.

The project follows Semantic Versioning.

## [2.0.0] - 2026-09-18

### Changed
- Converted the repository into a standard global npm CLI package.
- Package name is now `@laivannha0202/opencode-agent-skill`.
- Replaced the beta runtime plugin implementation with a stable filesystem-based OpenCode Agent Skills installer.
- Standardized development and CI on Node.js + npm; Bun and Python are no longer required.

### Added
- Global `ocskill` CLI.
- One-command global installation through npm `postinstall`.
- Safe managed state at `~/.config/opencode/.ues/state.json`.
- Idempotent skill/command synchronization.
- Managed-block integration with an existing global `AGENTS.md`.
- Automatic cleanup through npm `preuninstall`.
- `ocskill status`, `doctor`, `install`, `update`, `remove`, and `version`.
- npm packaging validation and Node.js tests.
- GitHub Actions workflow for npm publishing.

## [1.0.0] - 2026-09-18

### Added
- Initial universal engineering skill collection.
- Automatic engineering workflow rules.
- Commands for fix, feature, review, and audit.
