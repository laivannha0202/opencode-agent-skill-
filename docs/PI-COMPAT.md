# Pi compatibility

UES V13 can be installed as a Pi package without removing its existing OpenCode integration.

## Install Pi

Use the current Pi package:

```cmd
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

Authenticate Pi with `/login` or the provider environment variables you normally use.

## Install UES into Pi

From GitHub:

```cmd
pi install git:github.com/laivannha0202/opencode-agent-skill-
```

For a project-local install:

```cmd
pi install -l git:github.com/laivannha0202/opencode-agent-skill-
```

From npm after a release containing the Pi adapter:

```cmd
pi install npm:opencode-agent-skill
```

Run `pi list` to verify package discovery. Start a new Pi session after installation.

## What Pi loads

The package manifest exposes:

- `pi/extensions/ues-adapter.ts` — UES safety gate and fresh-agent tool;
- `global-config/skills/` — the existing UES Agent Skills catalog, loaded directly by Pi;
- `pi/prompts/` — Pi-native `/ues-*` prompt templates.

Useful commands include:

```text
/ues-run <task>
/ues-plan <task>
/ues-fix <issue>
/ues-debug <failure>
/ues-review [scope]
/ues-verify [scope]
/ues-research <question>
/ues-resume <slug>
/ues-audit [scope]
/ues-critique <target>
/ues-feature <feature>
/ues-doctor
```

## Fresh child agents

The adapter registers `ues_fresh_agent`. It launches a separate `pi -p --no-session` process, giving the child a fresh context.

Use `read-only` for research, code review, planning, or independent verification. Use `write` only for one narrowly scoped implementation task. Child agents cannot recursively call `ues_fresh_agent`.

The durable UES state, receipts, repository inspection, evidence store, and `ocskill` CLI remain the same as the OpenCode integration.

## Safety

The Pi adapter intercepts risky `bash` tool calls including force-push/history rewrite, package publication, recursive destructive file deletion, destructive database commands, and deployment/apply commands.

In interactive Pi sessions the user is asked to allow the command once. In non-interactive child/print sessions such commands are blocked by default.

## Compatibility boundary

OpenCode's native V13 router APIs such as `ues.dispatch_task` and `ues.dispatch_parallel` are OpenCode-specific and are not called from Pi. Pi uses the `ues_fresh_agent` process-isolation adapter instead.

This preserves the core UES workflow while avoiding fake compatibility with OpenCode-only session APIs.
