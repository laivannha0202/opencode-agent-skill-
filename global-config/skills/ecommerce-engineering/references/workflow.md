# Ecommerce / marketplace workflow

Model catalog, seller, inventory, cart, pricing, order and payment state as separate responsibilities with explicit ownership.

Check:
- money stored/calculated in integer minor units or another exact representation
- server-authoritative price, discounts, tax/shipping and inventory
- seller/tenant ownership on product and order operations
- stock reservation/release and oversell behavior under retries/concurrency
- order state transitions and cancellation/refund constraints
- image/media fallbacks and realistic loading/empty/error states
- provenance/traceability fields preserved across catalog and order records
- pagination/filter/sort contracts for large catalogs

Never trust client-submitted totals or paid status. Coordinate payment idempotency with order idempotency.

Verification should cover cart recalculation, stale price/stock, duplicate checkout, concurrent reservation, unauthorized seller access and order transition edge cases.
