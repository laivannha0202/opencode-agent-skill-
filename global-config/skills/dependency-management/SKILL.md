---
name: dependency-management
description: Change dependencies safely by verifying package legitimacy, pinned/current compatibility, peer/runtime constraints, release guidance, lockfiles, supply-chain surface, and the smallest necessary version movement.
---

# Dependency Management

Identify package manager, lockfile, runtime/framework versions and the concrete reason a dependency change is needed.

Verify package identity and the intended version using registry/primary sources when current information matters. Prefer the smallest compatible movement, read migration guidance for behavior-changing upgrades, and avoid opportunistic dependency churn.

Read [workflow.md](references/workflow.md) for compatibility evidence, lockfile discipline, transitive/supply-chain impact and verification.
