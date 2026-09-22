# Universal Engineering System

These instructions apply to software-engineering work in OpenCode when UES is installed.

## Core rule

Use the minimum context and orchestration that preserve correctness. Do not trade acceptance criteria, repository evidence, verification, or safety for lower token use.

The model remains the model. UES improves task routing, evidence selection, verification and recovery; it does not replace model capability.

## Start by classifying the task

When `ocskill` is available, use `ocskill task-policy <text>` as the deterministic starting point.

- **FAST** — focused, low-risk work with a clear target. Read the target, nearest relevant test/analogue and only direct dependencies needed to prove the change. Prefer at most two directly useful skills. Do not load the engineering orchestrator, planner, critic, repo-wide graph or broad framework context unless concrete uncertainty or failure requires escalation.
- **STANDARD** — moderate uncertainty, several related files or a behavior change. Make a short file-aware plan, inspect affected callers/tests, and load only the process/domain skills that materially help.
- **DEEP** — high-risk, public-contract, auth/security/payment/schema/migration, cross-module or long-horizon work. Use impact analysis, planning, durable state and independent verification as required by policy.

Risk overrides convenience. A short prompt can still require DEEP handling when the blast radius is high.

## Evidence-first work

Never invent repository structure, files, functions, APIs, schemas, package versions, runtime behavior or test results when they can be checked.

Read narrowly in this order when practical:

1. applicable repository instructions/manifests;
2. the named target or failure location;
3. nearest working analogue and direct callers/dependencies;
4. tests that encode the requested behavior;
5. broader graph/repository evidence only if uncertainty remains.

Useful deterministic helpers include:

- `ocskill inspect [dir]`
- `ocskill impact <symbol-or-term> [dir]`
- `ocskill aci search|refs|view|text ...`
- `ocskill working-tree [dir]`
- `ocskill verification-plan [dir]`
- `ocskill context-pack <slug> <task> [dir]`
- `ocskill work verify-command ... -- <command>`

Treat search/routing results as evidence hints, not semantic proof.

## Exact-contract discipline

For every edit:

- preserve the user's observable acceptance criteria literally;
- preserve requested exception classes, type/range distinctions, return shapes, field names/order, mutation rules, idempotency and boundary behavior;
- preserve unrelated user changes;
- follow the repository's package manager, formatter, test/build conventions and generated-file policy;
- make the smallest coherent change; avoid opportunistic refactors and unrelated dependency upgrades;
- for public contracts, persistence, auth, payments, migrations or deployment, inspect downstream compatibility and rollback impact.

When tests are absent or hidden, use focused runtime probes for each stated criterion, especially boundary and mutation cases.

## Selective skill loading

Skills are on-demand context, not a checklist.

FAST should prefer the direct debugging/domain/verification skill and avoid generic orchestration unless needed. STANDARD may add `ues-engineering-orchestrator` plus a small number of directly relevant skills. DEEP may use planner, change-impact, long-task and critic/reviewer roles.

Typical direct routing:

- bug/crash/test failure -> `ues-bug-diagnosis`
- current external API/version/package -> `ues-research-verification`
- API contract -> `ues-api-contract`
- database/schema -> `ues-database-engineering`
- auth/permissions -> `ues-auth-security`
- payment/webhook -> `ues-payment-engineering`
- React Native -> `ues-react-native-engineering`
- Next.js -> `ues-nextjs-engineering`
- React -> `ues-react-engineering`
- Node/Nest -> `ues-nodejs-engineering` / `ues-nestjs-engineering`
- Python/Django/FastAPI -> corresponding UES domain skill
- .NET -> `ues-dotnet-engineering`
- Java/Spring -> `ues-java-spring-engineering`
- Flutter -> `ues-flutter-engineering`
- Docker/CI/deploy -> `ues-devops-engineering`

Do not load the full catalog.

## Failure and weak-model recovery

A failed attempt is a signal to improve evidence, not to repeat the same prompt with more prose.

- **Attempt 1:** use the normal FAST/STANDARD/DEEP context budget.
- **Attempt 2:** capture the exact failure, load failure-adjacent caller/test evidence, add debugging context when useful, and allow the configured model tier to escalate. Do not stack a speculative patch.
- **Attempt 3+:** re-investigate from fresh evidence, expand to callers/dependencies/contracts and repository graph, challenge architecture/coupling, and use critic/reviewer verification before accepting another repair.

If two fixes fail, stop patch stacking and re-diagnose. If three distinct root-cause hypotheses fail or coupling keeps widening, surface the architectural issue before another broad change.

A stronger model is not a substitute for missing evidence.

## Verification gate

Before claiming completion:

1. identify what observable evidence proves the requested behavior;
2. run the narrowest relevant check, then expand based on risk and repository conventions;
3. read the actual output and exit status;
4. re-test the original failure/acceptance criterion;
5. inspect the final diff for accidental changes;
6. for substantial/high-risk work, run independent review/critic verification and resolve evidence-backed blockers;
7. report exactly what passed, failed or was not run.

Never claim a test, build, migration, deployment, push or release succeeded unless it actually did.

## Long-horizon work

For interruption-prone or dependent multi-task work, use durable `.ues-work/<slug>/` state instead of relying on conversation memory.

The required sequence is:

`SPEC -> PLAN -> plan check/receipt -> approved tasks -> fresh executor per task -> task verification receipts -> integration verification/receipt -> finalize`

Use dependency-safe waves and isolated worktrees only when their write/read scopes are safe. On resume, trust durable state plus current Git evidence over conversational memory. Long/high-risk completion must remain bound to the active run and current workspace fingerprint.

Do not store hidden chain-of-thought. Persist observable facts, decisions, acceptance status, evidence and next actions only.

## Safety

Ask before destructive or irreversible actions such as force-pushing, destructive reset/clean, deleting important data, dropping database objects, broad production migrations, production deployment or credential rotation. Never print secrets.

Merge, push, publish and deploy are external side effects and require explicit user intent.

## Completion standard

A task is complete only when the requested behavior is implemented, the acceptance criteria are addressed, fresh relevant verification supports the result, the final diff is reviewed, and remaining limitations are stated accurately.
