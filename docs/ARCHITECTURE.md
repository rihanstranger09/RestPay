# RestPay technical notes

## Decision precedence

`evaluatePolicy` is a pure function. It evaluates every rule so the receipt is complete, then resolves the final decision in this order:

1. Any `violated` reason → `blocked`.
2. Otherwise any `approval` reason → `needs_approval`.
3. Otherwise → `allowed`.

An empty rule set returns `blocked`. This makes rule ordering in the array irrelevant to safety while preserving a useful ordered explanation.

## Transaction state machine

```text
                    ┌───────────────┐
agent proposal ────►│ policy check  │
                    └───┬───┬───┬───┘
                        │   │   │
                    blocked │   └────────► pending_approval ──► denied
                        │   │                    │
                        │   │                    ▼ approve + re-check
                        │   │                 processing
                        │   ▼ allowed              │
                        └────►─────────────────────┘
                                                 │
                                                 ▼ create order
                                         awaiting_payment
                                           │           │
                                      cancel│           ▼ buyer approved
                                           │        processing
                                           ▼           │
                                      cancelled        ▼ final re-check
                                                 completed / blocked
```

`failed` represents a PayPal create failure. A capture API failure returns to `awaiting_payment` so the user can diagnose or retry; the idempotency key remains stable.

## Budget reservations

The spending context separates captured and reserved amounts, globally and for the purchase category:

- Captured: `completed`.
- Reserved: `pending_approval`, `awaiting_payment`, `processing`.
- Excluded: blocked, denied, cancelled, and failed transactions.

A transaction is excluded from its own re-check to avoid counting itself twice. Category-scoped monthly budgets use only matching-category amounts.

## PayPal trust boundary

The browser never receives the PayPal secret and never supplies an order amount. The server builds the order from the stored transaction and verified catalog purchase. Capture first fetches the order from PayPal and compares:

- order status (`APPROVED`, or `COMPLETED` for idempotent recovery),
- exact USD amount string,
- RestPay receipt reference.

The policy engine runs again after buyer approval and before capture. Buyer approval therefore proves payment intent, not policy compliance; both are required.

## Data and production evolution

The MVP uses an in-memory state snapshot persisted through serialized atomic JSON writes. This keeps a hackathon demo dependency-free. A production version should use PostgreSQL with row locks, unique PayPal order/capture IDs, durable idempotency records, authenticated users, encrypted secrets, and a worker for webhook retries. The pure policy engine and service boundaries are designed to survive that migration unchanged.
