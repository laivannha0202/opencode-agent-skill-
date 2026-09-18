---
name: context-engineering
description: Control context in large or unfamiliar repositories by building a compact evidence map, reading only relevant interfaces and analogues, and avoiding repeated low-value file loading.
---

# Context Engineering

Build a working set instead of reading the repository indiscriminately.

1. Read applicable instructions and manifests.
2. Locate the task entry point and exact symbols/errors involved.
3. Find the nearest working analogue before inventing a new pattern.
4. Trace only direct callers, dependencies, contracts, tests, and configuration needed to explain the behavior.
5. Summarize findings as paths, interfaces, constraints, and open questions before expanding scope.
6. Prefer targeted search and line ranges over whole-tree dumps.
7. Reuse established findings; do not reread large unchanged files without a reason.

For monorepos or deep dependency graphs, read [large-repo.md](references/large-repo.md).
