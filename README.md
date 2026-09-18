# OpenCode Universal Engineering System V2

Model-agnostic global Agent Skills system for OpenCode. Designed to work with the built-in **Build** agent and whatever model you select.

## Included
- 33 reusable engineering skills
- 6 specialist subagents
- 4 commands: `/fix`, `/feature`, `/review`, `/audit`
- global `AGENTS.md` for automatic skill routing
- Windows global/project installers
- recommended OpenCode V2 config

## Recommended: install once for every project
Open PowerShell in this folder:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\install-global.ps1
```

It installs to:
```text
%USERPROFILE%\.config\opencode\
├── AGENTS.md
├── agents\
├── commands\
└── skills\
```

Restart OpenCode or start a new session. **Keep using the normal Build agent.**

Optional config (only auto-installs if you do not already have a global config):
```powershell
.\install-global.ps1 -InstallRecommendedConfig
```
If you already have `opencode.json(c)`, the installer does not overwrite it. Merge `opencode.recommended.jsonc` manually so providers/models/plugins are preserved.

## Automatic flow
```text
Build
  -> read repository
  -> identify stack/task
  -> load only relevant skills
  -> plan when needed
  -> implement
  -> verify
  -> review
  -> fix verification failures
  -> done
```

You normally do **not** need to name skills yourself.

## Model compatibility
No GPT/Claude model is hard-coded. Use Big Pickle or any other OpenCode-compatible model. Stronger models may follow the same workflows more effectively.

## Project overrides
Global rules apply everywhere. A repository can add its own `AGENTS.md` and `.opencode/skills/` for project-specific behavior; project definitions can override global ones with the same ID.

## GitHub
Suggested repository name: `opencode-universal-engineering-system`

Suggested first commit: `feat: add universal OpenCode engineering agent skills`
