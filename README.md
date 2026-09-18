# OpenCode Universal Engineering System

A model-agnostic engineering workflow plugin for **OpenCode V2**.

It registers a reusable catalog of engineering skills, adds namespaced workflow commands, and injects a disciplined engineering workflow into the built-in **Build** agent. The selected model remains your choice.

## Install

Install globally from GitHub:

```bash
opencode plugin add github:laivannha0202/opencode-agent-skill-
```

Then verify:

```bash
opencode plugin list
opencode plugin check
```

OpenCode manages the plugin in its global configuration. No manual copying into `.config/opencode` is required.

## Update

Check whether package plugins have updates:

```bash
opencode plugin check
```

Update this plugin:

```bash
opencode plugin update github:laivannha0202/opencode-agent-skill-
```

Or update every outdated package plugin:

```bash
opencode plugin update
```

## Remove

```bash
opencode plugin remove github:laivannha0202/opencode-agent-skill-
```

Because skills, commands, and Build workflow changes are registered by the plugin at runtime, removing the plugin removes those registrations as well. The plugin does not copy its assets into each project.

## What it adds

### Engineering skills

The package ships focused skills for areas such as:

- repository exploration and planning
- implementation and debugging
- testing and code review
- Git safety
- API and database work
- authentication and security
- React, Next.js, React Native, Vue, Angular
- Node.js, NestJS, .NET, Java/Spring
- Python, Django, FastAPI, Flutter
- UI/UX and accessibility
- ecommerce, payments, uploads, search
- Docker, CI/CD, DevOps and documentation

Skills are registered with OpenCode and can be autoinvoked when relevant. Existing project/user skills with the same ID are respected rather than overwritten.

### Commands

The plugin registers namespaced commands to avoid collisions:

```text
/ues-fix
/ues-feature
/ues-review
/ues-audit
```

### Build workflow

By default the plugin augments the built-in `build` agent with a workflow that encourages:

```text
read repository
→ identify stack and constraints
→ load only relevant skills
→ plan non-trivial work
→ implement
→ verify
→ review
→ fix verification failures
→ finish
```

It does **not** replace your selected model and does not pretend one model is another.

## Configuration

OpenCode supports plugin options. Example:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "github:laivannha0202/opencode-agent-skill-",
      "options": {
        "injectBuildWorkflow": true,
        "commandPrefix": "ues",
        "agents": ["build"]
      }
    }
  ]
}
```

Options:

- `injectBuildWorkflow`: set to `false` to register skills/commands without augmenting agent context.
- `commandPrefix`: command prefix; defaults to `ues`.
- `agents`: agent IDs that receive the engineering workflow; defaults to `["build"]`.

## Development

Requirements:

- OpenCode V2
- Bun
- Git

```bash
git clone https://github.com/laivannha0202/opencode-agent-skill-.git
cd opencode-agent-skill-
bun install
bun run ci
```

Validate packaged assets:

```bash
bun run validate
```

Run tests and type checking:

```bash
bun run ci
```

## Release process

This repository uses Semantic Versioning.

1. Update `CHANGELOG.md`.
2. Update `version` in `package.json`.
3. Run `bun run ci`.
4. Merge through a pull request.
5. Tag the release, for example `v1.0.0`.
6. Users on an unpinned Git source can check/update through the OpenCode plugin CLI.

## Repository layout

```text
.
├── src/
│   ├── index.ts
│   └── assets.ts
├── global-config/
│   ├── AGENTS.md
│   ├── commands/
│   └── skills/
├── test/
├── .github/workflows/
├── package.json
├── tsconfig.json
├── CHANGELOG.md
├── CONTRIBUTING.md
└── LICENSE
```

## License

MIT
