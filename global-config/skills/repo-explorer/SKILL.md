---
name: repo-explorer
description: Inspect unfamiliar repositories efficiently before changes by locating instructions, stack, entry points, nearest analogues, dependencies, data flow, tests, and conventions without inventing structure.
---

# Repo Explorer

Read applicable instructions and manifests first. If `ocskill` is available, `ocskill inspect` can establish stack/package-manager/test-command facts before targeted source reads.

Then:
1. locate the task's exact entry point, symbol, route, error, or configuration
2. find the nearest working analogue in the same repository
3. trace direct imports, callers, and data flow only as far as needed
4. identify tests, fixtures, build scripts, generated-code rules, and package boundaries
5. note repository conventions and risky assumptions before editing

Prefer exact search, shallow tree views, and relevant line ranges over recursive dumps. If the repository is large, load `ues-context-engineering`. Do not invent paths, framework behavior, or architecture that can be verified.
