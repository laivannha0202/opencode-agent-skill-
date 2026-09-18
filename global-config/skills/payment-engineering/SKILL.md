---
name: payment-engineering
description: Implement and review payments as high-integrity state machines with trusted amounts, provider webhooks, idempotency, retries, reconciliation, and order/payment separation.
---

# Payment Engineering

Never trust client-calculated amount or a browser redirect as proof of payment. Model payment and order state transitions explicitly and assume provider events can be duplicated, delayed, retried, or arrive out of order.

Verify server-side pricing, webhook authenticity, idempotency keys/event identity, atomic state transitions, retry behavior, refund/cancel paths, reconciliation and secret isolation.

Read [workflow.md](references/workflow.md) for state-machine invariants, webhook handling, idempotency, failure injection and verification.
