# Deterministic evidence tools

UES 4 adds small dependency-free repository inspection tools. They reduce work that should not depend on model guessing.

## Repository map

```cmd
ocskill inspect .
```

Reports:
- detected stack/framework markers
- package manager
- important root files
- top-level entries
- workspace declarations
- project-native verification commands

## Stack and test commands

```cmd
ocskill detect-stack .
ocskill detect-tests .
```

These are useful when the repository is unfamiliar or the selected model is weak at environment discovery.

## Impact search

```cmd
ocskill impact calculateOrderTotal .
```

Searches a bounded set of source/config/document files while skipping common dependency/build directories. It returns matching paths and a few matching lines. It is a fast impact hint, not a semantic call graph; important consumers still need exact inspection.

## Evidence snapshot

```cmd
ocskill evidence .
```

Combines stack, likely verification commands, important files/workspaces and Git state into one machine-readable JSON snapshot.

## Working tree

```cmd
ocskill working-tree .
```

Reports Git branch, HEAD, clean/dirty state and porcelain changes without modifying the repository.

## Design constraints

The helpers:
- use Node built-ins only
- do not install dependencies
- do not modify the target repository
- bound file scanning and skip common dependency/build directories
- return JSON so agents and scripts can consume the evidence consistently

They complement repository-native symbol search, language servers, tests and build tools rather than replacing them.
