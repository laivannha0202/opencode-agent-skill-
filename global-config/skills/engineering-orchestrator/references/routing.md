# Routing guide

Choose the smallest set of skills that changes the quality of the work.

## Scope

**Small**
- one local concern
- low-risk behavior
- known conventions and quick verification

Work inline. Exploration and a domain skill may be enough.

**Standard**
- behavior change
- two to five related files
- moderate uncertainty
- focused API/data-flow impact

Use a short plan, one process skill, relevant domain skill, and verification.

**Complex**
- public contracts, persistence, auth/security, payments, migrations
- cross-package/cross-service work
- major dependency change
- many files or difficult rollback
- task likely to span sessions

Add planning, impact analysis, research/architecture, and long-task state when useful.

## Process-first examples

- bug -> bug-diagnosis -> domain skill -> test-verification
- feature -> task-planner -> implementation/domain -> test-verification
- unfamiliar repo -> repo-explorer -> context-engineering if large -> domain skill
- API/version uncertainty -> research-verification before dependency/framework edits
- release readiness -> code-review + test-verification + git-safety

Avoid loading overlapping skills just because they exist. More context is not automatically better context.
