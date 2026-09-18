---
name: api-contract
description: Keep frontend, backend, DTOs, schemas, generated clients, validation, status codes, serialization, pagination, and errors consistent end-to-end.
---

# Api Contract

Trace request -> validation -> handler/service -> persistence -> response -> client -> UI. Compare method/path, params/query/body, required/optional/nullability, enums, response shape, pagination, errors, date/number serialization. Use the repository source of truth. Do not hide mismatches with any/unsafe casts. Update dependent callers/types together.
