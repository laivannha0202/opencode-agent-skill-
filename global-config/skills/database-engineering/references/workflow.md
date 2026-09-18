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
