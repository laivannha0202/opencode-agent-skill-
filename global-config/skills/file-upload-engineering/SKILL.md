---
name: file-upload-engineering
description: "Implement file/image uploads safely: validation, storage, naming, URLs, cleanup, permissions, progress, and errors."
---

# File Upload Engineering

Validate type/size server-side, use safe object keys, enforce authorization/storage permissions, plan orphan cleanup and URL exposure, and handle client progress/errors. Do not trust extensions alone. Prevent path traversal and unrestricted executable uploads.

Read [workflow.md](references/workflow.md) when the task reaches domain-specific behavior, compatibility, failure, or verification boundaries.
