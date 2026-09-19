# FastAPI workflow

Confirm Python, FastAPI, Pydantic and server/runtime versions because validation and serialization behavior can differ materially.

Trace route -> dependency graph -> request model -> service/data layer -> response model. Keep validation at explicit boundaries and avoid leaking ORM/internal objects accidentally.

For async routes, identify blocking database/filesystem/network calls and move or replace them appropriately. Ensure dependency lifetimes clean up sessions/resources reliably.

For auth, enforce identity and resource authorization through dependencies or service checks that cannot be bypassed by alternate routes.

Preserve status codes, error schemas and OpenAPI-visible contracts. Be deliberate about response_model filtering and nullable/default semantics.

Verification should include focused pytest/integration checks, invalid-input and unauthorized cases, OpenAPI/schema diff when contracts change, and startup/lifespan behavior when dependencies or resources changed.
