# Git safety workflow

Before changing history or staging, inspect branch, status, relevant diff and upstream relationship.

Rules:
- preserve uncommitted user work; never use reset --hard, clean, checkout/restore of user changes, force push or history rewrite without explicit intent
- stage only task-related paths and inspect the staged diff before committing
- do not commit secrets, generated noise or large binaries accidentally
- prefer new commits over rewriting shared history
- when resolving conflicts, understand both sides before choosing content
- distinguish local success from remote success; verify push/PR state instead of assuming it

For release/tag work, confirm the exact commit being tagged and version consistency first. For branch deletion, verify the work is merged or otherwise recoverable.

Verification should include git status, the final diff/staged diff, current branch/HEAD and remote result when a remote operation was actually requested.
