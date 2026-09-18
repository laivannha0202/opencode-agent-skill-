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

A local `npm install` skips global OpenCode installation. Use a temporary config directory when testing the installer manually:

```powershell
$env:OPENCODE_CONFIG_DIR="$PWD\.tmp-opencode"
node .\bin\ocskill.mjs install
node .\bin\ocskill.mjs status
node .\bin\ocskill.mjs remove --lifecycle
```

## Skill rules

Each source skill lives at:

```text
global-config/skills/<skill-id>/SKILL.md
```

The source skill ID must match its directory. The npm installer exposes it globally with the `ues-` prefix to avoid overwriting unrelated user skills.

Every skill must include:

```yaml
---
name: skill-id
description: Clear explanation of what it does and when to use it.
---
```

Keep skills focused. Prefer composable skills over one giant prompt.

## Before committing

```bash
npm run validate
npm test
npm pack --dry-run
```

or simply:

```bash
npm run ci
```

Update `CHANGELOG.md` whenever package behavior changes.
