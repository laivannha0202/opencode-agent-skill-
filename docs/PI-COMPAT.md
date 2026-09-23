# Pi Agent compatibility

UES can be loaded by Pi as a package while keeping the existing OpenCode integration intact.

## Requirements

- Node.js 22.19 or newer for the current Pi coding agent.
- Pi: `@earendil-works/pi-coding-agent`.
- Git for git-based package installation.

UES itself still keeps `node >=20` compatibility for OpenCode. The higher Node requirement applies when running through current Pi.

## Install the conversion branch

On Windows PowerShell or Command Prompt:

```text
npm install -g @earendil-works/pi-coding-agent
pi --version
pi install git:github.com/laivannha0202/opencode-agent-skill-@feat/pi-agent-port
pi list
pi
```

If you already cloned this repository and checked out the conversion branch, you can install the local checkout instead:

```text
pi install .
```

After this branch is merged to `main`, install without the branch suffix:

```text
pi install git:github.com/laivannha0202/opencode-agent-skill-
```

## What Pi loads

The package manifest exposes:

- `global-config/skills/` as Pi skills;
- `pi/prompts/*.md` as slash prompt templates;
- `pi/extensions/ues.ts` as the Pi runtime adapter.

Useful Pi commands include:

```text
/ues-run <task>
/ues-plan <task>
/ues-feature <task>
/ues-fix <bug>
/ues-debug <failure>
/ues-review <scope>
/ues-verify <claim>
/ues-audit <scope>
/ues-research <question>
/ues-critique <proposal>
/ues-resume <slug>
```

The extension also registers two model-callable tools:

- `ues_cli`: runs the bundled `ocskill` CLI directly through Node, so UES does not depend on `ocskill` being globally present on PATH.
- `ues_dispatch`: runs bundled UES specialist agents in isolated child Pi processes. It supports single, parallel, and chain execution and inherits the active Pi model/thinking level.

## Safety and parallel writers

The adapter preserves the UES destructive-command guard for Pi `bash` and `powershell` calls.

Read-only agents may run in parallel against the same repository. Writer agents are intentionally stricter: a parallel writer must receive an explicit working directory, and writer working directories must be distinct. Use Git worktrees or other isolated task directories. If isolation is not available, run writer tasks serially.

This prevents two Pi child processes from editing the same files concurrently.

## Compatibility notes

Most UES functionality is runtime-independent and is reused directly on Pi:

- task policy and routing;
- deterministic repository inspection;
- durable `.ues-work/` state;
- evidence and verification receipts;
- recovery/resume;
- skills and domain instructions;
- fresh specialist contexts.

The OpenCode V2 plugin API itself is not loaded in Pi. Pi uses `ues_dispatch` instead of OpenCode's native `ues.dispatch_task` / `ues.dispatch_parallel`.

The initial Pi adapter deliberately does not pretend to provide automatic transactional integration for multiple writers sharing one root checkout. Use serial writers or distinct worktrees until task integration is explicitly coordinated by the UES workflow.

## OpenCode remains supported

Installing UES through Pi does not run the OpenCode global resource installer. A normal global npm installation for OpenCode continues to use the existing setup path.

This allows one repository/package to support both hosts without maintaining two separate copies of the UES engine.
