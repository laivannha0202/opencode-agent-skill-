# Contributing

## Requirements

- OpenCode V2
- Bun
- Git

## Development

```bash
git clone https://github.com/laivannha0202/opencode-agent-skill-.git
cd opencode-agent-skill-
bun install
bun run ci
```

## Skill rules

Each skill lives at:

```text
global-config/skills/<skill-id>/SKILL.md
```

The skill ID must match its directory and use lowercase letters, numbers, and single hyphens.

Every skill must include YAML frontmatter with at least:

```yaml
---
name: skill-id
description: Clear explanation of when the skill should be used.
---
```

Keep skills focused. Prefer several composable skills over one giant prompt.

## Pull requests

1. Create a branch.
2. Make the smallest coherent change.
3. Run `bun run ci`.
4. Update `CHANGELOG.md` when behavior changes.
5. Open a pull request describing behavior and verification.
