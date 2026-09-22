# V13 Parallel Weak-Model Runtime

Status: beta prerelease (`13.0.0-beta.0`).

## Goal

V13 reduces wall-clock time for large engineering work by letting multiple fresh sessions of the **same configured model** execute independent approved tasks concurrently without sharing mutable context.

## Runtime contract

- `ues.dispatch_parallel` defaults to one shared model for every worker and verifier.
- The root must be a Git repository. A pre-existing dirty working tree is allowed: V13 snapshots that baseline into each sandbox and integrates only the task delta, so valid inherited/user changes are preserved.
- Writers execute in isolated Git worktrees.
- Resource leases serialize overlapping files, unknown scope and shared configuration surfaces.
- The scheduler is event-driven: when one task is independently verified, transactionally integrated and completed, newly unblocked dependencies may start immediately.
- Initial and downstream sandboxes inherit the current dirty root through an internal snapshot commit on the sandbox branch; the user's root branch is never auto-committed.
- A fresh `ues-verifier` session using the same model must return PASS before integration.
- Integration is serialized. If receipt/completion fails after patch application, V13 reverses that task patch before marking the run failed.
- No parallel worker pushes, publishes or deploys.

## Same-model execution

One model is sufficient. Parallelism means multiple isolated sessions, not multiple model families:

```text
provider/weak-model
  ├─ fresh session A
  ├─ fresh session B
  ├─ fresh session C
  └─ fresh verifier sessions
```

If no explicit model is supplied, the configured executor model is shared. If no configured model is selected, all sessions keep the OpenCode default model.

## Runtime compatibility

V13 keeps CLI, durable state, receipts, task graphs and Windows text hardening available on OpenCode 1.x. Native `ues.dispatch_task` and `ues.dispatch_parallel` require the V2 router plugin plus the fresh-session capability surface. The router checks capabilities at runtime and fails closed if create/prompt/wait/interrupt/context/switch-agent are incomplete.

When npm blocks lifecycle scripts (common with stricter npm 11+ `allowScripts` policy), install still leaves the CLI available; run `ocskill install` to perform the documented resource sync explicitly.

## CLI hardening

V13 parses `--help` before positional arguments, so commands such as these are safe:

```cmd
ocskill work init --help
ocskill work status --help
ocskill work gate-receipt --help
```

`ocskill work status .` now lists durable workspaces instead of treating `.` as a slug.

For machine callers, append `--json` to receive structured errors.

On Windows, prefer:

```cmd
ocskill diff . --out dirty.diff
```

This writes UTF-8 directly and avoids PowerShell 5 redirection producing UTF-16 text that generic readers may classify as binary. On OpenCode 1.x, where the V2 `ues.text_read` tool is unavailable, read known text safely without creating a converted copy:

```cmd
ocskill text-read .ues-work/<slug>/PLAN.json --json
```

Existing UTF-8/UTF-16 text can be normalized with:

```cmd
ocskill normalize-text dirty.diff
```

## Release evidence

V13 remains beta until parallel execution demonstrates measurable wall-clock improvement without reducing correctness, and Windows/Linux CI proves help parsing, encoding, dirty-baseline worktree inheritance, rollback, verifier receipts and package installation.
