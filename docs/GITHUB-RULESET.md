# GitHub Ruleset Readiness

This document records the recommended GitHub repository ruleset configuration for the `main` branch, to be activated only after CI Gate and Security Gate have each achieved at least one successful run.

## Recommended ruleset

- **Ruleset name:** `main-protection`
- **Target:** default branch / `main`
- **Enforcement:** Active

## Rules

1. **Restrict deletions** — block deleting the default branch or force-pushing over it.
2. **Block force pushes** — no `git push --force` or `git push -f` to `main`.
3. **Require pull request before merge** — all changes must go through a PR.
4. **Require conversation resolution** — PR reviewers must resolve all inline comments before merge.
5. **Require status checks** — PRs must have passing CI Gate and Security Gate checks before merge.
6. **Require branch up to date** — PR branches must be up to date with `main` before merge (applies when there are multiple contributors; can be relaxed for single-maintainer setups).
7. **Required check: CI Gate** — the aggregate CI check from `.github/workflows/ci.yml`.
8. **Required check: Security Gate** — the aggregate security check from `.github/workflows/security.yml`.

## Approval policy for single-maintainer repo

This repository currently has one maintainer. Setting `required approval = 1` would prevent the owner from merging their own PRs (they cannot approve their own PR). Therefore:

- **Required approval = 0** for now.
- When a collaborator or external reviewer is added, raise to `required approval = 1` to restore oversight.

## Classic branch protection vs ruleset

GitHub supports both classic branch protection rules and repository rulesets simultaneously. When both are configured:

- They can apply independently to different aspects of branch protection.
- Be cautious of duplicate or conflicting protections (e.g., two rules both requiring status checks but with different required lists).
- If migrating from classic protection to ruleset, remove the classic rule after confirming the ruleset is active and working.

## Activation prerequisite

Do not enable the ruleset until:

1. CI Gate has at least one successful run on `main`.
2. Security Gate has at least one successful run on `main` or a PR.

Without these prerequisites, the ruleset would block all merges immediately after activation, effectively locking the repository.

## Current status

- **CI Gate:** Added in `.github/workflows/ci.yml`. Awaiting first successful run.
- **Security Gate:** Added in `.github/workflows/security.yml`. Awaiting first successful run.
- **Ruleset:** NOT YET ACTIVATED. Will be configured via GitHub admin settings after both gates have successful runs.
