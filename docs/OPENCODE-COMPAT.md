# Legacy OpenCode compatibility

> Deprecated compatibility surface. The supported runtime in this repository is **Pi Agent**.

UES no longer depends on the OpenCode router for its core task policy, model routing, context construction, specialist dispatch, scheduling, verification, or benchmark path. The canonical runtime lives under `pi/` and `lib/`.

## Why these files still exist

A small compatibility layer is retained temporarily so older installations can be inspected or migrated without silently deleting user-managed resources. It is not loaded by the Pi package manifest and should not be used for new development.

Legacy-only surfaces include:

- `global-config/commands/`;
- `global-config/plugins/ues-router/`;
- OpenCode installer/router compatibility code in `lib/installer.mjs`, `lib/opencode-compat.mjs`, and `lib/router-config.mjs`;
- `scripts/eval-live.mjs`, which exists only for historical OpenCode benchmark comparison.

The old router policy file is now a compatibility shim that re-exports the canonical Pi-native `lib/task-policy.mjs`, preventing policy drift.

## Current Pi equivalents

| Legacy surface | Pi-native replacement |
|---|---|
| OpenCode router task admission | `lib/task-policy.mjs` + `ues_execute` |
| OpenCode dispatch | `ues_execute` / `ues_dispatch` |
| OpenCode model routing | `lib/model-policy.mjs` consumed directly by Pi dispatch |
| OpenCode prompt aliases | `pi/prompts/*.md` |
| OpenCode live eval | `ues eval-pi ...` / `scripts/eval-pi.mjs` |
| Manual writer worktree preparation | structured-plan safe-wave scheduler in `ues_execute` |

## Migration guidance

New installs should use Pi:

```cmd
npm install -g @earendil-works/pi-coding-agent
pi install git:github.com/laivannha0202/opencode-agent-skill-
pi
```

Use the UES-native CLI alias for deterministic operations:

```cmd
ues task-policy "fix a payment callback race" --json
ues models status --json
ues eval-pi --model provider/model --mode both
```

`ocskill` remains an alias during the migration window so existing scripts do not break immediately.

For an existing OpenCode installation that still needs the deprecated compatibility resources, synchronization is now explicit rather than an npm lifecycle side effect:

```cmd
ocskill install
```

The npm package intentionally has no `postinstall` or `preuninstall` compatibility hooks. Installing UES for Pi must not silently mutate OpenCode configuration.

## Removal rule

Do not add new features to the legacy OpenCode compatibility surface. New runtime features must land in Pi/`lib` first. Legacy files may be removed once migration coverage proves that no supported Pi command imports or packages them.
