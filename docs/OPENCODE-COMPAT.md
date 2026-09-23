# OpenCode compatibility

V13 ships one npm package for OpenCode 1.x and 2.x. CLI/state/verification features remain available on both lines, while V2-native fresh-session and parallel runtime features are enabled only when the required V2 capabilities are detected.

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

- 48 namespaced skills
- 11 namespaced commands
- 12 namespaced subagents using compatible V1 `permission` frontmatter
- managed global `AGENTS.md` block

The V2 runtime plugin is not installed.

Durable CLI state, task DAG, plan/integration gates, Windows UTF text recovery and model-policy configuration remain available. `ues.dispatch_task` and `ues.dispatch_parallel` are unavailable because those tools live in the V2 router plugin.

## OpenCode 2.x

UES converts managed agent permission frontmatter to V2 ordered `permissions` and installs:

```text
<global-config>/plugins/ues-router/
```

V13 also installs the 11 UES slash-command templates inside the managed router as V2 **prompt aliases** instead of registering them as native global custom commands. Typing `/ues-run ...`, `/ues-fix ...`, and the other `/ues-*` aliases therefore travels through `session.prompt`; the router expands the same bundled command contract before routing skills. This is a compatibility workaround for V2 custom-command transport failures such as `UnsupportedContentType` from the `session.command` path. Re-syncing with `ocskill install` removes stale UES-managed native command files from older installs.

The plugin provides:

- prompt-admission skill routing
- long-task context guardrails
- permission safety evaluation when that hook exists
- durable-state/task-graph/context-pack tools
- `ues.dispatch_task` bounded fresh executor runtime
- `ues.cancel_task` and `ues.recover_task` when session interruption is supported
- `ues.dispatch_parallel` when the full fresh-dispatch surface is present; it runs independent approved tasks in isolated same-model sessions, verifies each task independently, and serializes integration

`ues.dispatch_task` uses V2 session APIs to create a fresh session rooted at the selected execution directory, bind its session ID to the task lease, select `ues-executor`, optionally switch model tier, prompt one approved task, heartbeat while waiting, and interrupt on timeout. Concurrent writing tasks can be isolated in Git worktrees.

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


## V8 capability probing

Version detection remains useful for install-time compatibility, but V8 runtime dispatch does not assume that a major version proves the availability of every session API.

The managed V2 plugin probes for:

- session creation
- prompting
- waiting
- interruption
- context retrieval
- agent switching
- model switching
- session hooks
- permission hooks

`ues.capabilities` exposes the observed surface. Fresh dispatch fails closed when the minimum create/prompt/wait/interrupt/context/switch-agent surface is unavailable. Optional context/prompt/permission hooks degrade safely instead of preventing the plugin from loading.


## V13 parallel compatibility

`ues.dispatch_parallel` is capability-gated, not version-string-gated. It requires the complete fresh-dispatch surface reported by `ues.capabilities`: session create, prompt, wait, interrupt, context retrieval and agent switching. If any required API is missing, V13 fails closed and the durable CLI workflow remains usable in serial mode.

OpenCode 1.x users can still use V13 CLI hardening, durable `.ues-work/<slug>/` state, receipts, task graphs and Windows text normalization. To use native multi-session parallel execution, use a runtime that exposes the V2 fresh-session APIs.
