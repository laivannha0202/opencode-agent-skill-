# V12 Weak-Model Intelligence Foundation

Status: beta prerelease (`12.0.0-beta.0`, npm dist-tag `next`). V11 (`11.0.0`) remains the stable `latest` release until V12 earns stable-release evidence.

## Goal

V12 focuses on making weaker coding models more reliable on large repositories by improving measured context quality, empirical model routing, plan identity, bounded autonomous decisions, and repo-scale evaluation. It does not claim that orchestration makes one base model equivalent to a stronger model.

## Foundations

- Empirical model performance: observed pass rate, retries, token use and latency can rerank capability-eligible models by task class.
- Context quality receipts: adaptive context reports required-file recall and irrelevant-context ratio.
- Plan-scoped snapshots: every imported plan gets a SHA-256 keyed snapshot and active-plan fence before execution.
- Decision policy: reversible local engineering choices can be auto-resolvable; publish/deploy/destructive/product decisions remain human-gated.
- Repo-scale contract suite: deterministic generation of a 300-module monorepo fixture for larger-repository validation.

## Release policy

V12 is not stable merely because unit tests pass. Promotion requires healthy GitHub CI/Security gates, repo-scale validation, real weak-model baseline-vs-UES trials, no regression in existing suites, measured context recall, sufficient empirical routing samples, and Windows/Linux package/install smoke evidence.

## Beta install

```cmd
npm install -g opencode-agent-skill@next
ocskill install
ocskill doctor
```
