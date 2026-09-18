# OpenCode Universal Engineering System

Universal engineering Agent Skills for OpenCode, packaged as a normal global npm CLI.

## Install

Once the package is published to npm, a new user installs everything with one command:

```powershell
npm install -g @laivannha0202/opencode-agent-skill
```

The npm `postinstall` automatically installs the managed OpenCode resources into:

```text
~/.config/opencode/
├── AGENTS.md
├── skills/
│   ├── ues-repo-explorer/
│   ├── ues-bug-diagnosis/
│   ├── ues-react-native-engineering/
│   └── ...
├── commands/
│   ├── ues-fix.md
│   ├── ues-feature.md
│   ├── ues-review.md
│   └── ues-audit.md
└── .ues/
    └── state.json
```

Restart OpenCode or open a new session after installation.

### Install directly from GitHub before npm publication

The repository can be tested immediately without publishing first:

```powershell
npm install -g github:laivannha0202/opencode-agent-skill-
```

That also exposes the `ocskill` command and runs the same installer.

## CLI

```powershell
ocskill status
ocskill doctor
ocskill install
ocskill update
ocskill remove
ocskill version
```

### What each command does

- `ocskill install` — installs or re-syncs this package's managed skills, commands and workflow.
- `ocskill status` — checks installed skill/command counts and the managed workflow.
- `ocskill doctor` — checks Node, npm, OpenCode and installation state.
- `ocskill update` — installs the latest npm release globally.
- `ocskill remove` — uninstalls the global npm package; npm's uninstall lifecycle removes only resources managed by this package.
- `ocskill version` — prints the package version.

## Normal npm lifecycle

Install:

```powershell
npm install -g @laivannha0202/opencode-agent-skill
```

Update:

```powershell
npm update -g @laivannha0202/opencode-agent-skill
```

or:

```powershell
ocskill update
```

Uninstall:

```powershell
npm uninstall -g @laivannha0202/opencode-agent-skill
```

The package uses safe managed markers and a state file. Uninstall removes only files created by this package and removes only its own managed block from an existing global `AGENTS.md`.

If npm lifecycle scripts are disabled with `--ignore-scripts`, run:

```powershell
ocskill install
```

manually after installation.

## OpenCode usage

Keep using the normal **Build** agent and whichever model you choose.

The global workflow instructs Build to select only relevant `ues-*` skills, for example:

```text
request
  -> inspect repository
  -> identify stack
  -> load relevant ues-* skills
  -> plan when needed
  -> implement
  -> verify
  -> review
  -> fix failures
  -> done
```

Available convenience commands:

```text
/ues-fix
/ues-feature
/ues-review
/ues-audit
```

The package does not change Big Pickle, GPT, Claude, Gemini, or any other model into another model. It provides reusable engineering workflows to the model selected in OpenCode.

## Included areas

The package currently includes 33 focused skills covering:

- repository exploration, planning, architecture and implementation
- debugging, testing, review and Git safety
- dependencies, APIs, databases, authentication and security
- performance, accessibility and UI/UX
- React, Next.js, React Native and other frontend/mobile stacks
- Node.js, NestJS, .NET, Java/Spring, Python, Django and FastAPI
- Flutter
- ecommerce, payments, file uploads and search
- Docker, CI/CD, DevOps and documentation

## Development

Requirements:

- Node.js 20+
- npm
- Git

Clone and test:

```powershell
git clone https://github.com/laivannha0202/opencode-agent-skill-.git
cd opencode-agent-skill-
npm install
npm run ci
```

Local `npm install` deliberately does **not** modify the user's global OpenCode configuration. Automatic resource installation only runs for a global npm install.

Useful scripts:

```powershell
npm run validate
npm test
npm run ci
npm pack --dry-run
```

## Publish to npm

The package name is:

```text
@laivannha0202/opencode-agent-skill
```

Before the first publish, the npm account or organization must own the `@laivannha0202` scope.

Manual first publish:

```powershell
npm login
npm run ci
npm publish --access public
```

The repository also contains `.github/workflows/publish.yml`. Add an npm automation token to the GitHub repository secret named `NPM_TOKEN`; after that a `v*` tag or manual Publish npm workflow can publish releases.

## Release flow

1. Change the version in `package.json`.
2. Update `CHANGELOG.md`.
3. Run `npm run ci`.
4. Commit to `main`.
5. Tag the release, for example `v2.0.0`.
6. Publish through GitHub Actions or `npm publish --access public`.

## Safety

- Existing unrelated global skills are not deleted.
- Existing command files with the same managed target name are not overwritten unless they contain this package's managed marker.
- Existing `AGENTS.md` content is preserved.
- Reinstall is idempotent.
- Uninstall removes only this package's managed resources.
- Set `OPENCODE_CONFIG_DIR` to test against an alternate OpenCode config directory.

## License

MIT
