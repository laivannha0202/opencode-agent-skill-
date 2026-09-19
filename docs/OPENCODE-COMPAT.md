# OpenCode compatibility

UES 4 supports both the installed OpenCode 1.x line and OpenCode 2.x with one npm package.

## Detection

During resource synchronization, UES reads `opencode --version`. Tests and controlled environments may override detection with:

```text
UES_OPENCODE_MAJOR=1
UES_OPENCODE_MAJOR=2
```

The detected major is recorded in `~/.config/opencode/.ues/state.json`.

## OpenCode 1.x

UES installs:

- namespaced skills under `skills/ues-*/`
- namespaced commands under `commands/ues-*.md`
- six subagents under `agents/ues-*.md` using the V1 `permission` frontmatter shape
- the managed UES block in global `AGENTS.md`

The V2 runtime router plugin is not installed.

## OpenCode 2.x

OpenCode 2 keeps file-based skills, commands and agent definitions compatible, while its native permission schema uses an ordered `permissions` list and its plugin API is different from V1.

UES therefore:

- installs the same skill and command resources
- converts the managed subagents to native V2 `permissions` frontmatter
- installs `plugins/ues-router/index.js` under the global OpenCode config
- creates `.ues/router.json` with `enabled: true` and `maxSkills: 4` when no router preference exists

The router uses the V2 prompt-admission hook to add a small focused set of relevant UES skill IDs. It does not load every skill and does not replace model judgment.

Control it with:

```cmd
ocskill router status
ocskill router off
ocskill router on
ocskill router on --max 3
```

Supported `--max` values are 1 through 6; the default is 4.

## Upgrading OpenCode

After upgrading from V1 to V2, run:

```cmd
ocskill install
ocskill status
```

The installer rewrites only UES-managed agent files into the appropriate syntax and adds/removes the managed router as required. Switching back to V1 removes the managed V2 router and restores V1 agent permission syntax without touching unrelated user plugins.

## Primary references

- https://opencode.ai/v2/docs/migrate-v1
- https://opencode.ai/v2/docs/permissions
- https://opencode.ai/v2/docs/plugins
- https://opencode.ai/v2/docs/build/plugins
- https://opencode.ai/v2/docs/skills
