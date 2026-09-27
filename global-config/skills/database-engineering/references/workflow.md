# Database engineering workflow

## Schema change
Map old readers/writers and new readers/writers. For live systems prefer compatible expand -> backfill -> switch -> contract sequencing when one-step migration could break mixed versions.

Check existing rows before adding NOT NULL/unique/foreign-key constraints. Separate schema migration from expensive data backfill when operational risk warrants it.

## Queries and indexes
Use real filter/join/order patterns. An index should support an observed query shape; avoid speculative indexes. Watch N+1 ORM access, full-table scans, unbounded result sets and lock amplification.

## Transactions
Define the invariant and the smallest atomic boundary. Consider retries, unique conflicts, lost updates, isolation behavior and external side effects that cannot roll back with the database.

## Verification
Validate migration up/down strategy when supported, run affected data tests, and inspect generated SQL/schema diff. For risky changes use representative existing data or a dry run. Confirm old/new application compatibility when rollout can overlap.


## Fixture/demo cleanup safety

Treat cleanup of test/demo records as a data migration, not a UI concern.

- refuse production targets and never silently fall back from a test database to a development database;
- dry-run before deletion and report the exact candidate IDs/keys plus pre-cleanup counts;
- match deterministic markers or audited source provenance, never a broad substring that could include legitimate records;
- preserve canonical seed/demo records and real user history;
- delete in dependency-safe FK order and use a transaction/rollback boundary when the stack supports it;
- report post-cleanup counts and run the cleanup a second time to prove idempotency;
- verify public/API data after cleanup. Frontend filtering is not cleanup evidence.

Only claim `DB_CLEAN_PASS` when fresh data-layer evidence proves the cleanup candidates, counts, canonical preservation, public-data result, and zero-change second pass.
