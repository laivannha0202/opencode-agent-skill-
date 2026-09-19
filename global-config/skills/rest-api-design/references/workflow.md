# REST API design workflow

Start from existing repository conventions and the consumer contract.

Model resources and operations first, then choose method/path/status semantics. Distinguish create vs replace vs partial update and make retryable writes idempotent when duplicate execution is unsafe.

Define:
- request validation and unknown-field policy
- success and error schemas
- pagination/filter/sort semantics and stable ordering
- null vs missing field behavior
- resource-level authorization
- concurrency/precondition behavior where lost updates matter
- versioning/deprecation strategy for breaking changes

Avoid exposing persistence layout directly when it makes compatibility brittle.

Verification should cover representative success, malformed input, unauthorized/not-found distinction where appropriate, pagination boundaries, duplicate/retry behavior and at least one real consumer or contract test for public changes.
