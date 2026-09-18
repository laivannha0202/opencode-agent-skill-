# Dependency management workflow

Before adding/upgrading:
- confirm the package name is legitimate and maintained enough for the use case
- inspect repository runtime/framework constraints
- check peer dependencies, engines and platform/native requirements
- compare current -> target release notes/migration guide for breaking or behavior changes
- identify whether the change is direct or only needed transitively

Use the repository package manager to update manifests/lockfiles; do not hand-edit lock resolution unless the ecosystem requires it.

For major upgrades, map deprecated APIs and affected imports/config before changing the version. Keep unrelated packages stable.

Verification should include a clean/locked install or package-manager resolution check, affected tests/build/typecheck, and runtime smoke for behavior-sensitive upgrades. If a security advisory motivates the change, verify the fixed version range from a primary advisory/registry source rather than guessing.
