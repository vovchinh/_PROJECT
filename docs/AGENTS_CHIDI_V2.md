# AGENTS.md — ChiDi ERP + ChiDiPos V2

## Mission

You are working inside the existing ChiDi ERP / ChiDiPos repository.

The repository is already running **V2**.

Your job is to evolve the current V2 system toward the new unified target architecture without rewriting the working application, without discarding existing migrations/data, and without regressing already-working flows.

## Sources of truth — priority order

When information conflicts, use this priority:

1. **Current V2 repository code that is actually running**
2. **Current database migrations/schema**
3. **Passing automated tests and verified runtime behavior**
4. **Current V2 documentation/changelog/verification notes**
5. `KIEN_TRUC_CHIDI_ERP_CHIDIPOS_V1_1_TARGET.md` as the target architecture
6. `KIEN_TRUC_ERP_CHIDI.md` as historical/baseline architecture
7. Older prompts, mockups, notes, and examples

Do NOT downgrade the project to V1.1 just because older architecture documents describe V1.1.

Before implementation, determine what V2 already contains.

## Non-destructive rule

Do not rewrite the project from scratch.

Do not:
- replace working V2 modules merely to match a newer diagram;
- rename/drop production tables without a migration/compatibility plan;
- delete old migrations;
- reset Supabase production data;
- silently change accounting/ledger semantics;
- convert the existing React JS codebase to TypeScript unless explicitly requested;
- introduce microservices only for architectural aesthetics;
- place service-role keys or third-party secrets in browser code;
- bypass RLS/RPC business constraints from React.

Prefer incremental migrations and compatibility layers.

## Existing platform principles to preserve

The unified product is:

```text
ChiDi Platform
├── ERP Core
│   ├── Workspace
│   ├── Members / permissions
│   ├── Procurement
│   ├── Cash
│   ├── Inventory / ledgers
│   ├── Audit
│   └── Reporting
│
└── ChiDiPos / Live Commerce
    ├── Catalog / variants / aliases
    ├── Customers / identities
    ├── TikTok LIVE
    ├── Comment parser
    ├── CHỐT & IN
    ├── Live Sale Ticket
    ├── Customer Basket / Cart
    ├── Zalo customer completion
    ├── Final Order
    ├── Fulfillment
    ├── Shipping
    ├── COD / return
    └── Commerce reports
```

PostgreSQL is the authoritative business-data source.

React is a client, not the authority for critical multi-table mutations.

Use PostgreSQL RPC / trusted server logic for authoritative transactions.

## Critical live-commerce invariants

These are non-negotiable:

1. `COMMENT != SALE`.
2. Parser result is only a suggestion.
3. Seller action **CHỐT & IN** is the business commit boundary.
4. `commit_live_sale_ticket()` must be atomic and idempotent.
5. A committed Live Sale Ticket is never hard-deleted; use `VOID`.
6. Reprint never creates another ticket, cart item, or reservation.
7. Printer failure never loses committed sale data.
8. Inventory cannot oversell under concurrency.
9. Comment spam does not reserve stock.
10. A reservation is not the same thing as an inventory movement.
11. Customer Cart is derived from active committed tickets/cart items, not raw comments.
12. Customer confirmation is required before conversion to Final Order where policy requires it.
13. One cart conversion must create at most one Final Order.
14. Final Order stores price/address snapshots.
15. TikTok LIVE identity, TikTok Shop buyer identity, Zalo UID, and phone are separate customer identities until explicitly matched.
16. Do not auto-merge customers merely by display name, username similarity, or avatar.
17. Shipping Label and Live Sale Ticket are separate documents/workflows.
18. `DELIVERED != COD_SETTLED`.
19. COD settlement cannot create revenue twice.
20. Realtime is for UX; database state is authoritative.
21. External webhooks are at-least-once and may be duplicated/out of order.
22. External mutations need idempotency/retry/reconciliation.
23. Every sensitive mutation must be auditable.
24. All tenant/workspace data must remain isolated.

## Target live-commerce flow

```text
TikTok LIVE
→ normalized comment
→ customer matching
→ deterministic parser
→ seller validates suggestion
→ CHỐT & IN
→ atomic DB commit
    ├── claim comment
    ├── campaign customer/STT
    ├── Live Sale Ticket
    ├── Cart Item
    ├── Inventory Reservation
    ├── Print Job
    ├── Audit
    └── Outbox event
→ physical bill
→ Customer Basket / Cart
→ Zalo/manual customer information
→ Cart Summary
→ Customer Confirmation
→ Final Order
→ Shipment
→ Shipping Label
→ Delivery
→ COD settlement / return
→ ERP reports
```

## Live Campaign model

Prefer:

```text
Live Campaign
├── Live Session A
├── Live Session B
└── Live Session C
```

The same customer can retain one operational customer number such as `#027` across sessions in the campaign.

That human-readable number is an operational aid, not the database primary key.

## Inventory model

Never use a mutable product `stock` field as the authoritative inventory model.

Target concepts:

```text
ON_HAND
RESERVED
AVAILABLE
IN_TRANSIT
DAMAGED
```

with:

```text
AVAILABLE = ON_HAND - ACTIVE_RESERVATIONS
```

Preserve and reconcile existing V2 stock/ledger behavior before adding generalized inventory tables.

Do not create negative available stock unless an explicit documented policy permits it.

## Customer identity model

Target entities:

```text
customers
customer_identities
customer_addresses
customer_tags
customer_merge_history
```

Identity examples:

```text
TIKTOK_LIVE_USER
TIKTOK_SHOP_BUYER
ZALO_UID
PHONE
EMAIL
```

Matching order:
1. stable external ID
2. verified phone
3. known channel buyer ID
4. explicit staff merge
5. fuzzy candidate suggestion only

## TikTok integration boundary

Keep these independent:

```text
TikTok Shop Adapter
CommentIngestionProvider
```

Core domain code must not depend on a single unofficial TikTok LIVE library.

Use normalized contracts.

Long-running TikTok comment connectivity may live in a dedicated worker/service because Edge Functions are not persistent LIVE WebSocket workers.

## Zalo integration boundary

Support both:

```text
Manual/Free flow
Integrated Zalo OA flow
```

The system must remain usable if Zalo API automation is unavailable.

Claim code example:

```text
CD27-K8
```

may link a Zalo conversation/UID to the existing customer/cart.

## Printing

Mobile-first operation is preferred.

Recommended runtime:

```text
Phone A: TikTok LIVE
Phone/Android Tablet B: ChiDiPos
Bluetooth/LAN printer: Live Sale Ticket
```

Printing must be behind a replaceable device bridge / print job contract.

Do not couple business commit to physical print success.

## Webhook / integration rules

Webhook entrypoint:

```text
verify
→ deduplicate
→ persist inbox
→ acknowledge quickly
→ process asynchronously
```

External side effects:

```text
DB transaction
→ outbox
→ worker
→ external provider
```

Do not call Zalo/TikTok/carrier APIs in the middle of the authoritative DB transaction.

## Security

Browser may have:
- Supabase public URL
- public/anon key

Browser must never have:
- service role key
- TikTok secret/access token
- Zalo secret
- carrier secret
- encryption master key

Every new workspace-scoped table needs RLS.

RLS alone does not replace business permission checks in sensitive RPCs.

## Development workflow

For every substantial task:

1. Inspect current V2 code/schema/tests first.
2. State what already exists.
3. Identify the gap against target architecture.
4. Propose the smallest safe increment.
5. List migrations and compatibility impact.
6. Implement.
7. Add/adjust tests.
8. Run verification.
9. Report rollback strategy.
10. Update docs.

Do not move to the next phase while critical tests fail.

## Mandatory pre-change audit

Before implementing the target architecture, inspect:

- `package.json`
- source tree
- Supabase migrations
- Supabase functions
- repository/data-access layer
- auth/session handling
- workspace/member model
- RLS policies
- RPC functions
- inventory schema
- product schema
- customer/order code if already present
- tests
- CI
- V2 changelog/docs
- deployment configuration

Produce:
- `docs/architecture/V2_CURRENT_STATE.md`
- `docs/architecture/V2_TARGET_GAP_ANALYSIS.md`
- `docs/architecture/V2_MIGRATION_PLAN.md`

Do this before destructive or large structural changes.

## Gap classification

For every target feature mark one:

```text
EXISTS_AND_COMPATIBLE
EXISTS_NEEDS_EXTENSION
EXISTS_CONFLICTS
MISSING
DEFER
```

Also provide:
- current file/table/function;
- target;
- migration needed;
- data risk;
- rollback;
- tests.

## Suggested implementation sequence from current V2

Do not assume version numbers blindly. First map current V2.

Then generally implement in this dependency order:

### Phase A — V2 baseline stabilization
- verify current migrations;
- verify RLS;
- verify current ledger invariants;
- verify backup/restore;
- verify real cloud environment;
- create target gap analysis.

### Phase B — Commerce foundation
- product variants;
- product aliases;
- customers;
- customer identities;
- customer addresses;
- generalized inventory compatibility;
- reservations;
- order/payment skeletons.

### Phase C — TikTok Live + CHỐT & IN
- live campaigns;
- live sessions;
- normalized comments;
- parser;
- claim lock;
- Live Sale Ticket;
- Customer Cart;
- reservations;
- print jobs;
- CHỐT & IN RPC;
- realtime;
- mobile operation;
- printer bridge.

### Phase D — Zalo + finalization
- claim code;
- Zalo identity;
- customer information;
- cart summary;
- deposit;
- confirmation;
- cart-to-order conversion.

### Phase E — Fulfillment
- shipments;
- packages;
- carrier adapters;
- tracking;
- shipping label;
- return workflow.

### Phase F — COD / commerce finance
- expected COD;
- settlement;
- settlement lines;
- bank matching;
- shipping fees;
- return costs;
- gross-profit reporting.

### Phase G — hardening
- webhook inbox;
- outbox;
- retries;
- dead-letter;
- reconciliation;
- monitoring;
- load/concurrency tests;
- security review;
- backup/restore drill.

## Tests that are mandatory when the relevant feature exists

### Workspace isolation
User A cannot access Workspace B.

### Idempotency
Retry the same `CHỐT & IN` request:
- one ticket;
- one cart item;
- one reservation;
- one business print job.

### Same comment / two staff
Only one staff can claim/commit.

### Stock contention
`AVAILABLE = 1`.
Two simultaneous commits.
Only one succeeds.

### Printer failure
Ticket/cart/reservation remain correct.
Reprint does not duplicate sale.

### Cart conversion
Two devices convert the same cart.
Only one Final Order exists.

### Webhook duplication
Duplicate webhook causes no duplicate business effect.

### COD
Bank settlement does not duplicate order revenue.

## Required response format for implementation work

Always return:

1. Current V2 findings
2. Gap vs target
3. Implementation plan
4. Files changed
5. Migrations
6. RLS changes
7. RPC / server logic
8. UI changes
9. Integration changes
10. Tests
11. Commands run + results
12. Data migration/reconciliation
13. Rollback plan
14. Known limitations
15. Recommended next safe step

## Definition of Done

A phase is not complete until:

```text
[ ] existing V2 tests still pass
[ ] clean migration from scratch passes
[ ] upgrade migration from actual V2 schema passes
[ ] RLS tests pass
[ ] cross-workspace tests pass
[ ] business invariants pass
[ ] idempotency passes
[ ] relevant concurrency tests pass
[ ] build passes
[ ] no frontend secret exposure
[ ] real-device/printer test performed where applicable
[ ] docs updated
[ ] rollback documented
[ ] known limitations documented
```
