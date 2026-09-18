# Auth/security workflow

Map: credential/session source -> authentication middleware -> identity -> authorization policy -> protected resource/action.

Ask:
- Can an unauthenticated caller reach the action?
- Can an authenticated user change an identifier and access another user's object (IDOR)?
- Is role/tenant/resource ownership checked at the server boundary that performs the action?
- Are token/session expiry, revocation, rotation and replay properties consistent with the design?
- For cookie auth, are Secure/HttpOnly/SameSite and CSRF protections appropriate to the request model?
- Are CORS and redirect allowlists narrowly scoped?
- Are password hashes using the project's approved adaptive algorithm/settings?
- Can logs/errors expose credentials, tokens or sensitive data?

Verification must include negative cases: missing auth, wrong role/tenant/owner, expired/revoked session/token and malformed input where relevant. Do not weaken controls to make tests or local development pass.
