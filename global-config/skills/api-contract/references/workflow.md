# API contract workflow

Identify the contract source of truth: OpenAPI/schema/protobuf/generated types/server DTOs or repository convention. Do not create a second conflicting truth.

Before editing, map all known producers and consumers. Classify each field/change:
- additive optional
- additive required
- rename/remove
- type/nullability/enum change
- semantic change with same type
- status/error/pagination change

Backward compatibility depends on consumer behavior, not only type compatibility. A new enum value can break exhaustive clients; changing null to missing can break serializers; changing 404 to 200-empty can alter control flow.

Update generated clients through the repository's generator rather than hand-editing generated files.

Verification should cover provider validation/serialization and at least one real consumer or contract test. Test error/status shapes and boundary serialization, not only the success body.
