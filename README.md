# OpenCode Universal Engineering System

A model-agnostic engineering harness for OpenCode, distributed as a global npm package.

UES does not turn one base model into another. It improves the selected model's engineering process with focused skill routing, deterministic repository evidence, planning, root-cause debugging, current-source research, impact analysis, tests, independent verification, adversarial criticism, bounded repair, and measurable behavioral evals.

## What V4 installs

- **39 engineering skills**
- **9 slash commands**
- **6 read-only/analysis subagents**
- a managed global engineering workflow in OpenCode's `AGENTS.md`
- managed install state under `.ues/`
- on **OpenCode 2.x**, a managed runtime router plugin that can preselect a small relevant skill set

The core loop is:

```text
understand
  -> deterministic evidence
  -> focused routing
  -> plan when risk warrants it
  -> implement
  -> verify with fresh evidence
  -> critic/reviewer when useful
  -> bounded repair
  -> finish
```

## Install

For npm versions with package-specific lifecycle approval:

```cmd
npm install -g @laivannha0202/opencode-agent-skill --allow-scripts=@laivannha0202/opencode-agent-skill
```

The approved `postinstall` copies the published package into npm's global package directory and synchronizes the managed UES resources into the user's OpenCode config.

On older npm versions:

```cmd
npm install -g @laivannha0202/opencode-agent-skill
```

If lifecycle scripts are blocked or intentionally skipped:

```cmd
ocskill install
```

Then start a new OpenCode session.

### Do not test a release with `npm install -g .`

A local global install may create a symlink/junction back to the source checkout. If that checkout is on a temporary or RAM disk, the global CLI can break after the source disappears.

Use a packed tarball for release-like testing:

```cmd
npm pack
npm install -g .\laivannha0202-opencode-agent-skill-4.0.0.tgz --allow-scripts=@laivannha0202/opencode-agent-skill
```

## Verify installation

```cmd
ocskill status
ocskill doctor
```

A synchronized install reports:

```text
Package version: 4.0.0
Resource version: 4.0.0
Sync: OK
Skills: 39/39
Commands: 9/9
Subagents: 6/6
Workflow: OK
```

On OpenCode 2.x it also reports the managed router plugin.

## CLI

```text
ocskill install [--force]    install/re-sync managed OpenCode resources
ocskill status               compare package/resource synchronization state
ocskill doctor               check Node, npm, OpenCode and UES resources
ocskill eval                 validate the static routing contract
ocskill eval-live [options]  run executable baseline-vs-UES behavioral evals
ocskill eval-report [paths]  aggregate pass-rate/tool/token/cost telemetry

ocskill inspect [dir]        deterministic repository/stack/test-command map
ocskill impact <query> [dir] bounded likely-impact search
ocskill evidence [dir]       collect stack, test-command and Git evidence
ocskill working-tree [dir]   report branch/HEAD/dirty state
ocskill detect-stack [dir]   report stack/package-manager evidence
ocskill detect-tests [dir]   report likely project-native verification commands

ocskill router status        show OpenCode V2 router state
ocskill router on|off        enable/disable automatic V2 routing
ocskill router on --max 3    set maximum automatically selected skills

ocskill update               update from npm latest and re-sync
ocskill remove [--force]     remove managed resources and uninstall package
ocskill version              print package version
```

## Deterministic evidence before model guessing

When `ocskill` is available, UES can cheaply establish repository facts before the model reads broadly:

```cmd
ocskill inspect .
ocskill impact calculateOrderTotal .
ocskill evidence .
ocskill working-tree .
```

The helpers use Node built-ins only, do not modify the target repository, skip common dependency/build directories, bound broad scans, and return JSON.

They are not semantic call-graph or language-server replacements; important matches still need exact code inspection.

See [Deterministic evidence tools](docs/DETERMINISTIC-TOOLS.md).

## OpenCode 1.x and 2.x

UES detects the OpenCode major during synchronization.

**OpenCode 1.x**
- installs existing V1-compatible agent permission frontmatter
- does not install the V2 router plugin

**OpenCode 2.x**
- installs native ordered `permissions` frontmatter for managed subagents
- installs `~/.config/opencode/plugins/ues-router/index.js`
- keeps router preferences in `.ues/router.json`
- uses the V2 prompt-admission hook to add at most a focused skill set

After upgrading OpenCode from V1 to V2, run:

```cmd
ocskill install
```

See [OpenCode compatibility](docs/OPENCODE-COMPAT.md).

## Skill routing

UES deliberately avoids loading all 39 skills.

Typical routes:

```text
unfamiliar repository
  -> repo-explorer
  -> context-engineering only when useful
  -> domain skill

bug/regression
  -> bug-diagnosis
  -> domain skill
  -> test-driven-development when practical
  -> test-verification

public API/schema/auth/payment change
  -> engineering-orchestrator
  -> change-impact-analysis / task-planner as warranted
  -> domain skill
  -> test-verification
  -> reviewer/critic for high risk

uncertain current dependency/API
  -> research-verification
  -> relevant framework/dependency skill
```

On OpenCode 2.x, the managed router can preselect a maximum number of relevant skills from the incoming prompt. Router selection is a hint, not evidence or authority.

## Progressive disclosure

The main `SKILL.md` files stay compact. Deeper domain behavior lives under each skill's `references/` or `templates/` directory and is loaded only when needed.

V4 deepens previously short workflows for accessibility, DevOps, Django, documentation, .NET, ecommerce, FastAPI, uploads, Flutter, Git safety, implementation, Java/Spring, NestJS, performance, Python, REST API design, architecture, and UI/UX.

## Subagents

UES installs:

```text
ues-architect
ues-debugger
ues-researcher
ues-reviewer
ues-critic
ues-verifier
```

They are selective read-only/analysis helpers. The parent Build agent remains responsible for implementation, integration and final completion claims.

## Evaluation

Static routing validation now has **34 scenarios covering every skill**:

```cmd
npm run evals
```

The executable live suite has **20 hidden-graded tasks**:

```cmd
npm run evals:live:validate
ocskill eval-live --model provider/model --trials 3
```

Default live runs fully isolate OpenCode config/home/data and use environment credentials. To copy only the current OpenCode auth file into the isolated runs:

```cmd
ocskill eval-live --model provider/model --auth current --trials 3
```

Aggregate results:

```cmd
ocskill eval-report .ues-evals
```

Traces include correctness, duration, workspace changes, and best-effort tool/skill/subagent/token/cost telemetry. They do not collect hidden chain-of-thought.

See [Evaluation](docs/EVALS.md) and [Trace schema](docs/TRACE-SCHEMA.md).

## Update

```cmd
ocskill update
```

V4 resolves the explicit npm `latest` dist-tag, falls back to `npm dist-tag ls` if needed, refuses downgrades, skips equal-version replacement, and re-syncs resources explicitly after a real update.

## Uninstall

```cmd
ocskill remove
```

Use `ocskill remove` rather than direct npm uninstall when you also want managed OpenCode resources cleaned up.

## Development

Requirements: Node.js 20+, npm, Git.

```cmd
git clone https://github.com/laivannha0202/opencode-agent-skill-.git
cd opencode-agent-skill-
npm install
npm run ci
```

V4 CI runs:

```text
JavaScript syntax checks
-> skill/command/subagent validation
-> 34-scenario full-catalog routing contract
-> 20-task hidden-grader integrity validation
-> Node unit/integration tests
-> npm pack --dry-run
-> packed one-command install smoke using the OpenCode V2 path
```

A local `npm install` deliberately skips global OpenCode setup.

## Safety

- UES-managed resources use the `ues-` namespace
- unmanaged collisions are preserved instead of overwritten
- installer state ownership is checked before install/remove
- re-sync is idempotent and removes only stale managed resources
- V2 router files are managed and removed safely when no longer applicable
- destructive repository operations still require explicit user intent
- current external API/version claims should be verified rather than invented
- benchmark traces record observable outcomes, not hidden reasoning

## Documentation

- [Engineering design](docs/ENGINEERING-DESIGN.md)
- [OpenCode compatibility](docs/OPENCODE-COMPAT.md)
- [Deterministic evidence tools](docs/DETERMINISTIC-TOOLS.md)
- [Evaluation](docs/EVALS.md)
- [Trace schema](docs/TRACE-SCHEMA.md)
- [npm publishing](docs/NPM-PUBLISH.md)
- [Research sources](docs/RESEARCH-SOURCES.md)

## License

MIT
