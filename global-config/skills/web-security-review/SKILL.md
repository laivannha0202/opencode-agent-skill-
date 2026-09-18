---
name: web-security-review
description: Review web applications for reachable, evidence-backed security risks including injection, XSS, broken access control, CSRF, SSRF, traversal, unsafe uploads, secrets, deserialization, and dangerous execution.
---

# Web Security Review

Prioritize exploitability and concrete data/control flow. Start from attacker-controlled inputs and trace them to sensitive sinks or authorization decisions. Do not report a vulnerability from a risky-looking function name alone.

Read [workflow.md](references/workflow.md) for source-to-sink analysis, access-control review, SSRF/upload/path checks, false-positive discipline and security verification.
