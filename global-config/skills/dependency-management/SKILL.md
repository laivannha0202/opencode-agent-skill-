---
name: dependency-management
description: Change dependencies safely by verifying package legitimacy, current project/runtime compatibility, peer constraints, release guidance, lockfiles, and the smallest necessary version movement.
---

# Dependency Management

Identify the package manager, lockfile, runtime and framework versions, and why the dependency change is required.

Before adding or upgrading:
- verify the package actually exists using the appropriate registry or primary source
- confirm the intended version or range is compatible with the repository runtime and peers
- read relevant migration or release guidance for major or behavior-changing updates
- prefer the smallest version movement that solves the requirement

Update lockfiles through the repository's package manager. Avoid broad upgrades during unrelated fixes. Verify a clean install or resolve path plus the affected build and tests. Load `ues-research-verification` when API or version information may be current or uncertain.
