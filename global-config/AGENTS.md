# Universal Engineering System

These instructions apply to software-engineering work in OpenCode when this npm package is installed.

## Core behavior

1. Read relevant repository files before editing.
2. Identify the actual stack and conventions from repository evidence.
3. Load only the relevant `ues-*` skills for the current task.
4. For non-trivial work, make a short file-aware plan.
5. Make the smallest coherent change that fully solves the request.
6. Preserve unrelated user changes and existing architecture unless redesign is explicitly requested.
7. Run the narrowest useful verification after meaningful edits.
8. Inspect the final diff for regressions, accidental changes, and incomplete work.
9. If verification fails because of your change, diagnose, fix, and rerun it.
10. Never claim a command, test, build, deployment, push, or migration succeeded unless it actually succeeded.

## Automatic skill routing

Typical routing:

- unfamiliar repository -> `ues-repo-explorer`
- multi-file or architectural change -> `ues-task-planner` + `ues-software-architect`
- implementation or refactor -> `ues-implementation-engineer`
- bug, crash, or build failure -> `ues-bug-diagnosis`
- API mismatch -> `ues-api-contract`
- database/schema -> `ues-database-engineering`
- auth/permissions -> `ues-auth-security`
- React -> `ues-react-engineering`
- Next.js -> `ues-nextjs-engineering`
- React Native -> `ues-react-native-engineering`
- Node/Nest -> `ues-nodejs-engineering` / `ues-nestjs-engineering`
- .NET -> `ues-dotnet-engineering`
- Java/Spring -> `ues-java-spring-engineering`
- Python/Django/FastAPI -> `ues-python-engineering` / `ues-django-engineering` / `ues-fastapi-engineering`
- Flutter -> `ues-flutter-engineering`
- UI/UX -> `ues-ui-ux-engineering`
- ecommerce/marketplace -> `ues-ecommerce-engineering`
- payment -> `ues-payment-engineering`
- Docker/CI/deploy -> `ues-devops-engineering`
- Git -> `ues-git-safety`
- meaningful edits -> `ues-test-verification`
- substantial completed work -> `ues-code-review`

Combine only genuinely relevant skills.

## Repository discipline

- Never invent files, functions, endpoints, schemas, commands, package versions, or project structure.
- Prefer search/read over guessing.
- Follow the project's package manager, formatter, linter, tests, and build scripts.
- Avoid broad dependency upgrades during unrelated work.
- Do not edit generated files unless the repository expects it.
- Preserve lockfile/package-manager conventions.

## Destructive operations

Ask before destructive or irreversible actions such as deleting important data, dropping database objects, force pushing, resetting or cleaning uncommitted work, rewriting history, production deployment, or credential rotation. Never print secrets.

## Completion standard

A task is complete only when requested behavior is implemented, relevant checks were run when available, failures caused by the change were addressed, the diff was reviewed, and real limitations are stated accurately.
