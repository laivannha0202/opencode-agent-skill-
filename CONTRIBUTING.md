# Contributing

## Requirements

- Node.js 20+
- npm
- Git

## Development

```bash
git clone https://github.com/laivannha0202/opencode-agent-skill-.git
cd opencode-agent-skill-
npm install
npm run ci
```

A local `npm install` skips global OpenCode installation.

## Skill rules

Each source skill lives at:

```text
global-config/skills/<skill-id>/SKILL.md
```

The source skill ID must match its directory. The installer exposes it globally with the `ues-` prefix.

Every skill needs frontmatter with at least `name` and `description`.

Keep the main `SKILL.md` focused. Put deep procedures, tables, and templates under the skill's own `references/`, `templates/`, or `scripts/` directory and link to them from `SKILL.md` only where useful.

## Commands and subagents

Commands live under `global-config/commands/`.

Subagents live under `global-config/agents/`, must use `mode: subagent`, and should default to read-only/analysis behavior unless a strong reason requires editing.

## Routing evals

When adding or renaming process skills, update `evals/routing.json`.

```bash
npm run evals
```

The routing suite is a static catalog contract, not a model-quality benchmark.

## Before committing

```bash
npm run ci
```

This validates skills/commands/subagents and local references, validates routing scenarios, runs Node tests, and checks the npm tarball.

Update `CHANGELOG.md` whenever package behavior changes.
