---
name: auth-security
description: Implement and review authentication, authorization, sessions, tokens, passwords, permissions, roles, secrets, and security-sensitive APIs with server-side enforcement.
---

# Auth Security

Separate authentication (who) from authorization (may do what). Identify the trust boundary and enforce permissions on the server for every protected object/action; UI hiding is never authorization.

Inspect session/token creation, validation, rotation/revocation, expiry, password storage, cookies/CSRF/CORS, object-level access, redirects, secrets and error leakage as relevant to the stack.

Read [workflow.md](references/workflow.md) for threat questions, IDOR/object ownership, session/token invariants, web cookie controls, and negative verification.
