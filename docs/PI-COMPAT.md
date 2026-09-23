# Pi Agent runtime

Repository này hiện đóng gói UES cho **Pi Agent**.

## Requirements

- Node.js 22.19+
- Git
- `@earendil-works/pi-coding-agent`

## Install

```cmd
npm install -g @earendil-works/pi-coding-agent
pi install git:github.com/laivannha0202/opencode-agent-skill-
pi list
pi
```

Project-local:

```cmd
pi install git:github.com/laivannha0202/opencode-agent-skill- -l
```

Hoặc từ checkout local:

```cmd
pi install .
```

## Resources loaded by Pi

`package.json` exposes:

- extension: `./pi/extensions/ues.ts`
- skills: `./global-config/skills`
- prompts: `./pi/prompts/*.md`

The packaged runtime also contains `global-config/agents/`, `bin/ocskill.mjs`, and `lib/` because the Pi extension uses them for specialist child-agent execution and deterministic UES operations.

## Tools

### ues_cli

Runs bundled `ocskill` functionality directly, without requiring a separate global `ocskill` installation.

Typical uses:

- task policy;
- repository inspection;
- dependency/task graph;
- durable `.ues-work/` state;
- evidence and receipts;
- verification and recovery;
- worktree isolation.

### ues_execute

Runs the high-level deterministic controller for end-to-end engineering work.

The controller applies task policy, adaptive context, model-tier routing, optional diagnosis/plan gating, implementation, verifier/integration-verifier gates, bounded retries, and model-performance telemetry. This is the preferred entry point for weak models because the parent model no longer has to remember the orchestration protocol.

### ues_dispatch


Runs bundled specialist roles in isolated child Pi processes. Each child receives routed model selection plus a bounded adaptive context pack before execution.

Supported execution patterns:

- single;
- chain;
- bounded parallel.

Parallel writer agents require distinct explicit cwd/worktrees. Read-only agents may share the same repository.

## Prompts

```text
/ues-run
/ues-plan
/ues-feature
/ues-fix
/ues-debug
/ues-review
/ues-verify
/ues-audit
/ues-research
/ues-critique
/ues-resume
```

## Safety

The extension intercepts risky `bash`/`powershell` calls and applies the UES destructive-command guard. Interactive Pi can ask for confirmation; non-interactive risky execution fails closed.

## Validation

Run from the repository:

```cmd
npm ci --ignore-scripts
npm test
npm run syntax
npm run smoke:pi
npm run smoke:package
npm pack --dry-run
```

The npm package manifest is Pi-only: it does not run lifecycle setup for another coding-agent host.


## Model routing

Runtime model routing is configured with `ocskill models ...` and is consumed directly by Pi child-agent dispatch. Set `UES_CONFIG_DIR` to override the UES config root. If a native UES policy does not exist, the runtime can read an existing legacy OpenCode model policy for migration compatibility.

## Package closure

`npm run smoke:package` inspects the actual npm pack file list, verifies required Pi/runtime files are present, checks relative module imports do not point outside the published package, and smoke-runs the deterministic task policy. This guards against the previous class of errors where Git installs worked but npm publication omitted a core dependency.
