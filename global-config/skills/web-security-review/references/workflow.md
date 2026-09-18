# Web security review workflow

For each candidate issue identify:
1. attacker-controlled source
2. transformations/validation
3. sensitive sink or authorization decision
4. preconditions and reachable path
5. concrete impact
6. existing mitigation that may break the exploit chain

High-value checks:
- SQL/command/template injection
- stored/reflected/DOM XSS with actual escaping context
- broken object/function-level authorization and tenant isolation
- CSRF for credential-bearing browser requests where applicable
- SSRF including redirect/DNS/private-network controls
- path traversal and archive extraction
- upload type/content/storage/execution controls
- secret/token leakage
- unsafe deserialization or dynamic code execution

Separate confirmed findings from hardening opportunities. Verification should use safe tests that demonstrate the violated security invariant without harming external systems. Recheck negative authorization and malicious-input cases after a fix.
