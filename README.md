# OpenCode Universal Engineering System

A model-agnostic engineering workflow for OpenCode, distributed as a global npm package.

UES does not turn Big Pickle, GPT, Claude, Gemini, or another model into a different model. It improves the engineering harness around the selected model: context selection, skill routing, planning, root-cause debugging, research verification, impact analysis, testing, independent review, and evidence-based completion.

## What v2.1 installs

- **39 engineering skills**
- **8 slash commands**
- **5 optional read-only/analysis subagents**
- a managed global engineering workflow in OpenCode's `AGENTS.md`
- installation state used by `ocskill status` and safe uninstall

The core workflow is:

```text
understand
  -> select focused skills
  -> plan when risk justifies it
  -> implement
  -> verify with fresh evidence
  -> independent review when useful
  -> finish

verification failure
  -> root-cause diagnosis
  -> smallest evidence-backed fix
  -> re-verify
```

## Install

After the package is published to npm:

```cmd
npm install -g @laivannha0202/opencode-agent-skill
```

On npm versions/configurations that block lifecycle scripts, npm may install the `ocskill` CLI but skip automatic OpenCode synchronization. In that case run:

```cmd
ocskill install
```

If your npm supports the allow-scripts flag, you can explicitly allow the package lifecycle in the install command:

```cmd
npm install -g @laivannha0202/opencode-agent-skill --allow-scripts=@laivannha0202/opencode-agent-skill
```

Before npm publication, install the GitHub version with:

```cmd
npm install -g github:laivannha0202/opencode-agent-skill-
ocskill install
```

Then start a new OpenCode session.

## Check installation

```cmd
ocskill doctor
ocskill status
```

A synchronized v2.1 install reports package/resource versions plus:

```text
Skills: 39/39
Commands: 8/8
Subagents: 5/5
Workflow: OK
```

## Update

After npm publication:

```cmd
ocskill update
```

`ocskill update` updates the global npm package and then explicitly re-syncs OpenCode resources, so resource synchronization does not depend only on npm postinstall behavior.

You can also use npm directly and then sync:

```cmd
npm update -g @laivannha0202/opencode-agent-skill
ocskill install
```

## Uninstall

```cmd
ocskill remove
```

The command first removes only UES-managed OpenCode resources, then uninstalls the global npm package.

Note: run `ocskill remove` rather than relying on a direct `npm uninstall -g`. npm 7 and newer no longer
run `uninstall`/`preuninstall` lifecycle scripts, so a direct `npm uninstall -g` only removes the package
and leaves the managed OpenCode resources and `.ues/state.json` behind without any warning.

```cmd
npm uninstall -g @laivannha0202/opencode-agent-skill
```

## CLI

```text
ocskill install [--force]    install/re-sync managed OpenCode resources
ocskill status               compare package version and installed resource state
ocskill doctor               check Node, npm, OpenCode and resource synchronization
ocskill eval                 validate the bundled skill-routing evaluation contract
ocskill update               update npm package and explicitly re-sync resources
ocskill remove [--force]     remove managed resources and uninstall package
ocskill version              print package version
```

If `~/.config/opencode/.ues/state.json` is owned by another package, install and remove
refuse to touch it. Use `--force` to take ownership anyway: the existing state file is
backed up first (next to `.ues` for `remove --force`), then replaced or the managed
resources are removed. This is the deliberate override for migrations or stale ownership.

## Process skills added in v2.1

The package now includes dedicated process skills in addition to framework/domain skills:

- `ues-engineering-orchestrator` — scope classification, routing, verification, retry and delegation policy
- `ues-context-engineering` — compact context maps for large repositories
- `ues-research-verification` — current primary-source/API/package/version verification
- `ues-change-impact-analysis` — producer/consumer and blast-radius analysis
- `ues-long-task-state` — optional resumable state for long multi-session work
- `ues-test-driven-development` — pragmatic red-green-refactor when a useful harness exists

Existing debugging, planning, repository exploration, dependency, review, and verification skills were strengthened as well.

## Commands

```text
/ues-feature
/ues-fix
/ues-plan
/ues-debug
/ues-review
/ues-verify
/ues-research
/ues-audit
```

The analysis commands route to focused subagents where appropriate.

## Optional subagents

UES installs:

```text
ues-architect
ues-debugger
ues-researcher
ues-reviewer
ues-verifier
```

They are intended for independent analysis with isolated context. They should not replace the normal Build agent for ordinary implementation work, and their conclusions still require repository or command evidence.

## Automatic routing

Keep using OpenCode's normal **Build** agent with whichever model you choose.

For a non-trivial request, UES encourages Build to load a small focused set of process/domain skills rather than all 39. Examples:

```text
unfamiliar repo
  -> repo-explorer
  -> context-engineering only if the repo is large
  -> relevant domain skill

bug
  -> bug-diagnosis
  -> domain skill
  -> test-driven-development when practical
  -> test-verification

public API/schema/auth/payment change
  -> task-planner
  -> change-impact-analysis
  -> relevant domain skill
  -> test-verification
  -> code-review

uncertain current API/version
  -> research-verification
  -> dependency/framework skill
```

## Progressive disclosure

Detailed orchestration rules are split into supporting files under each skill's `references/` or `templates/` directory. OpenCode can load the main skill first and deeper material only when needed. The npm installer copies whole skill directories, not only `SKILL.md`.

## Evaluation

```cmd
npm run evals
```

The repository currently contains a static routing contract with representative engineering requests. It verifies catalog/routing consistency but is **not** a model benchmark and does not claim GPT-5.6-equivalent intelligence.

See [docs/EVALS.md](docs/EVALS.md).

## Development

Requirements:

- Node.js 20+
- npm
- Git

```cmd
git clone https://github.com/laivannha0202/opencode-agent-skill-.git
cd opencode-agent-skill-
npm install
npm run ci
```

`npm run ci` runs:

```text
skill/command/subagent validation
-> routing eval contract
-> Node tests
-> npm pack --dry-run
```

A local `npm install` deliberately skips global OpenCode installation.

## Research and design

The v2.1 architecture was informed by public patterns from Alibaba OpenCodeReview, Open GSD Core, Superpowers, Anthropic Agent Skills material, NVIDIA's public skills, Ruflo/Claude Flow, and OpenCode's own skills/agents/commands documentation.

UES does not vendor those projects. The design notes explain what was adopted and what was deliberately avoided:

- [Engineering design](docs/ENGINEERING-DESIGN.md)
- [Research sources](docs/RESEARCH-SOURCES.md)

## Publish to npm

The intended public package name is:

```text
@laivannha0202/opencode-agent-skill
```

Before first publication, the npm account or organization must own the `@laivannha0202` scope.

```cmd
npm login
npm whoami
npm run ci
npm publish --access public
```

The repository also includes a GitHub Actions npm publishing workflow using the `NPM_TOKEN` repository secret.

## Safety

- unrelated user skills, commands, subagents, and existing `AGENTS.md` content are preserved
- UES resources are namespaced with `ues-`
- reinstall/re-sync is idempotent
- unmanaged collisions are skipped rather than overwritten
- uninstall removes only resources marked and tracked as UES-managed
- destructive repository operations still require user approval
- external API/version claims should be verified instead of invented

## License

MIT
