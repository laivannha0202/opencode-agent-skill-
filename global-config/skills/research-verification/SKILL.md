---
name: research-verification
description: Verify current external APIs, packages, versions, framework behavior, security guidance, and documentation with primary sources before coding when repository evidence is insufficient.
---

# Research Verification

Use this when an answer depends on information that may have changed outside the repository.

1. State the concrete uncertainty: API signature, package existence/version, compatibility, deprecation, platform behavior, security guidance, or release behavior.
2. Check repository-pinned versions and local types/docs first.
3. Prefer current primary sources: official documentation, package registry, release notes/changelog, or upstream source.
4. Confirm that documentation matches the version actually used by the repository.
5. Distinguish verified facts from inference. If primary evidence is unavailable, say so.
6. Never invent package names or versions. Before adding a new dependency, verify that it exists and is appropriate.
7. Record only the findings needed for the implementation; do not flood the coding context with unrelated research.

Read [source-hierarchy.md](references/source-hierarchy.md) when sources disagree.
