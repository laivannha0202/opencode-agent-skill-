---
name: api-contract
description: Keep frontend, backend, DTOs, schemas, generated clients, validation, status codes, serialization, pagination, and errors consistent end-to-end across producers and consumers.
---

# API Contract

Treat an API change as a producer/consumer contract, not only a handler edit.

Trace request -> validation -> handler/service -> persistence -> response serialization -> client/generated types -> UI/consumer. Compare method/path, params/query/body, required/optional/nullability, enums, status/error shapes, pagination and date/number serialization.

Read [workflow.md](references/workflow.md) for compatibility analysis, source-of-truth selection, generated clients, error semantics and contract verification.
