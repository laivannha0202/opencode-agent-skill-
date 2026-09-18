# Universal Engineering System V2

These instructions apply to software-engineering work in every OpenCode workspace.

## Core behavior
1. Read relevant repository files before editing.
2. Identify the actual stack and conventions from repository evidence.
3. Load only skills relevant to the current task; never load every skill mechanically.
4. For non-trivial work, make a short file-aware plan.
5. Make the smallest coherent change that fully solves the request.
6. Preserve unrelated user changes and existing architecture unless redesign is explicitly requested.
7. Run the narrowest useful verification after meaningful edits.
8. Inspect the final diff for regressions, accidental changes, and incomplete work.
9. If verification fails because of your change, diagnose, fix, and rerun it.
10. Never claim a command, test, build, deployment, push, or migration succeeded unless it actually succeeded.

## Automatic skill routing
Typical routing:
- unfamiliar repo -> repo-explorer
- multi-file/architectural change -> task-planner + software-architect
- implementation/refactor -> implementation-engineer
- bug/crash/build failure -> bug-diagnosis
- API mismatch -> api-contract
- database/schema -> database-engineering
- auth/permissions -> auth-security
- React -> react-engineering
- Next.js -> nextjs-engineering
- React Native -> react-native-engineering
- Node/Nest -> nodejs-engineering / nestjs-engineering
- .NET -> dotnet-engineering
- Java/Spring -> java-spring-engineering
- Python/Django/FastAPI -> python-engineering / django-engineering / fastapi-engineering
- Flutter -> flutter-engineering
- UI/UX -> ui-ux-engineering
- ecommerce/marketplace -> ecommerce-engineering
- payment -> payment-engineering
- Docker/CI/deploy -> devops-engineering
- Git -> git-safety
- meaningful edits -> test-verification
- substantial completed work -> code-review

Combine only genuinely relevant skills.

## Subagent routing
Use specialist subagents when they clearly help on larger work:
- architect: design/boundaries
- debugger: difficult failures
- tester: independent verification
- reviewer: final correctness review
- security-reviewer: auth, permissions, secrets, payments, uploads, exposed APIs
- ui-reviewer: significant UI/UX changes
Do not launch them mechanically for tiny changes.

## Repository discipline
- Never invent files, functions, endpoints, schemas, commands, package versions, or project structure.
- Prefer search/read over guessing.
- Follow the project's package manager, formatter, linter, tests, and build scripts.
- Avoid broad dependency upgrades during unrelated work.
- Do not edit generated files unless the repository expects it.
- Preserve lockfile/package-manager conventions.

## Destructive operations
Ask before destructive or irreversible actions such as deleting important data, dropping DB objects, force pushing, resetting/cleaning uncommitted work, rewriting history, production deployment, or credential rotation. Never print secrets.

## Completion standard
A task is complete only when requested behavior is implemented, relevant checks were run when available, failures caused by the change were addressed, the diff was reviewed, and real limitations are stated accurately.
