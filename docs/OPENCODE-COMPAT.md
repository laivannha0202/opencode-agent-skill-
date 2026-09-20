# OpenCode compatibility

UES 6 ships one npm package for OpenCode 1.x and 2.x, while only enabling V2-native runtime features when V2 is detected.

## Detection

During resource sync, UES reads:

```text
opencode --version
```

Tests may override with:

```text
UES_OPENCODE_MAJOR=1
UES_OPENCODE_MAJOR=2
```

The detected major is recorded in the managed state.

## OpenCode 1.x

UES installs:

- 39 namespaced skills
- 11 namespaced commands
- 10 namespaced subagents using compatible V1 `permission` frontmatter
- managed global `AGENTS.md` block

The V2 runtime plugin is not installed.

Durable CLI state, task DAG, plan/integration gates and model-policy configuration remain available. V2-specific automatic fresh-session dispatch is unavailable.

## OpenCode 2.x

UES converts managed agent permission frontmatter to V2 ordered `permissions` and installs:

```text
<global-config>/plugins/ues-router/
```

The plugin provides:

- prompt-admission skill routing
- long-task context guardrails
- permission safety evaluation
- read-only durable-state/task-graph/context-pack tools
- `ues.dispatch_task` fresh executor runtime

`ues.dispatch_task` uses V2 session APIs to create a fresh session, select `ues-executor`, optionally switch to the configured model tier, prompt one approved task and wait for completion.

## Router control

```cmd
ocskill router status
ocskill router on
ocskill router on --max 3
ocskill router off
```

Default maximum is 4 selected skills; supported range is 1–6.

## Model routing

```cmd
ocskill models status
ocskill models on
ocskill models set standard provider/model
ocskill models set heavy provider/strong-model
```

Re-run `ocskill install` after changing static managed-agent model frontmatter. Runtime `ues.dispatch_task` also reads the current model policy for attempt-based executor escalation.

## Upgrading OpenCode

After moving between V1/V2 lines:

```cmd
ocskill install
ocskill status
```

Only UES-managed resources are rewritten/removed. Unrelated user plugins/resources are preserved.

## Primary references

- https://opencode.ai/v2/docs/build/plugins
- https://opencode.ai/v2/docs/build/plugins/migrate-v1
- https://opencode.ai/v2/docs/permissions
- https://opencode.ai/v2/docs/plugins
- https://opencode.ai/v2/docs/skills


## Capability probing

V7.7 keeps major-version handling for resource installation, but live execution no longer assumes that a major version guarantees a specific CLI flag. The eval harness probes `opencode run --help` and only uses `--standalone` when that capability is actually exposed. The V2 router likewise registers fresh-session dispatch only when the required session methods exist. This is intentionally more conservative than version-only branching.
