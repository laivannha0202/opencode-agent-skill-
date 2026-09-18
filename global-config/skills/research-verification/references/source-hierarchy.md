# Source hierarchy

For changing technical facts, prefer evidence in this order:

1. repository lockfiles, generated types, vendored API surfaces, and exact runtime errors for what the project currently uses
2. official documentation for the matching version
3. official registry metadata, release notes, changelog, migration guide
4. upstream source/tests for behavior not documented elsewhere
5. high-quality secondary material
6. community discussion for experience reports, clearly labeled as such

When sources disagree, check dates and versions before deciding they conflict. Do not silently apply documentation for a newer or older major version to the current project.
