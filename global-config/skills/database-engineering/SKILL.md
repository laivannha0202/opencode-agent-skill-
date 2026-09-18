---
name: database-engineering
description: Design and modify schemas, migrations, indexes, queries, ORM models, transactions, and data integrity with compatibility, rollback, and existing-data safety.
---

# Database Engineering

Inspect the actual database/ORM, migration history, production-relevant query patterns, and existing data assumptions before editing.

Treat schema constraints, nullability/defaults, foreign keys/cascades, uniqueness, transactions, locking/concurrency, indexes, migration ordering, data backfill and rollback as explicit invariants. Do not infer migration safety from compilation.

Read [workflow.md](references/workflow.md) for expand/contract migrations, query/index analysis, transaction boundaries, data backfills, and verification.
