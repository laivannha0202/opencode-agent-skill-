# Payment engineering workflow

Map order state and payment state separately. Define which transitions are legal and which source is authoritative.

For checkout:
- calculate currency/amount server-side from trusted product/order data
- bind provider intent/session to internal order/customer identifiers
- make creation/retry idempotent

For webhooks:
- verify provider signature using the raw/request representation required by the provider
- persist or otherwise deduplicate event identity
- handle duplicates and out-of-order delivery
- make state transitions conditional/atomic
- return retryable vs terminal responses intentionally

Never mark paid from a client success URL alone.

Verification should include success, decline/failure, duplicate webhook, out-of-order event, retry after timeout, wrong signature, amount mismatch and already-finalized order as applicable. For production-sensitive changes, include reconciliation/rollback strategy.
