# CODEX BOOTSTRAP PROMPT — Integrate New ChiDi Architecture into Existing V2

You are entering an EXISTING ChiDi ERP / ChiDiPos repository that is already running V2.

Do not start by generating a new project.
Do not downgrade the repository to the V1.1 examples in historical documents.
Do not rewrite working modules just to make them look like the target architecture.

Your first responsibility is to understand the real V2 repository.

## Read first

Read, in this order:

1. `AGENTS.md`
2. `KIEN_TRUC_CHIDI_ERP_CHIDIPOS_V1_1_TARGET.md` if present
3. `KIEN_TRUC_ERP_CHIDI.md` if present
4. current V2 README / CHANGELOG / TASKS / VERIFICATION docs
5. all Supabase migrations
6. current tests
7. the current source tree

The current repository, schema, migrations, passing tests, and verified V2 behavior are the CURRENT STATE.

The architecture documents describe TARGET / HISTORICAL intent.

If they conflict, do not guess.
Document the conflict and preserve currently verified behavior unless the target architecture explicitly requires a migration and you can make it safely.

## Task 1 — Audit only, before implementation

Inspect the repository thoroughly.

Create these documents:

```text
docs/architecture/V2_CURRENT_STATE.md
docs/architecture/V2_TARGET_GAP_ANALYSIS.md
docs/architecture/V2_MIGRATION_PLAN.md
```

### V2_CURRENT_STATE.md

Document the real V2 state:

- app architecture;
- React structure;
- repository/data-access architecture;
- auth/session;
- workspaces;
- members/roles/permissions;
- RLS;
- RPCs;
- products;
- variants if already present;
- suppliers/purchases;
- inventory/stock;
- cash/finance;
- customers;
- orders;
- TikTok features if already present;
- Zalo features if already present;
- printing if already present;
- Edge Functions;
- queues/cron if any;
- tests;
- CI/CD;
- deployment;
- known technical debt.

Do not infer features that are not in code/schema/tests.

### V2_TARGET_GAP_ANALYSIS.md

Compare every relevant target capability against V2.

Use a table:

| Domain | Target capability | Current V2 evidence | Status | Gap | Risk | Recommended action |
|---|---|---|---|---|---|---|

Status must be one of:

```text
EXISTS_AND_COMPATIBLE
EXISTS_NEEDS_EXTENSION
EXISTS_CONFLICTS
MISSING
DEFER
```

At minimum cover:

- workspace / tenant isolation;
- roles / permissions;
- audit;
- catalog;
- variants;
- aliases;
- warehouse;
- stock ledger;
- reservations;
- customers;
- customer identities;
- addresses;
- orders;
- payments;
- live campaigns;
- live sessions;
- comments;
- parser;
- comment claim lock;
- Live Sale Ticket;
- Customer Basket number;
- Customer Cart;
- CHỐT & IN;
- print jobs;
- mobile printing;
- TikTok Shop adapter;
- TikTok LIVE provider;
- Zalo claim/link;
- customer confirmation;
- fulfillment;
- shipping labels;
- COD;
- returns;
- webhook inbox;
- outbox;
- reconciliation;
- reporting;
- backups;
- observability.

### V2_MIGRATION_PLAN.md

Build an incremental plan from the current V2 state.

For every step include:

- why needed;
- exact tables/files impacted;
- additive vs destructive migration;
- data backfill;
- compatibility strategy;
- RLS;
- indexes;
- RPCs;
- tests;
- rollback;
- acceptance criteria.

Prefer additive migrations.

Do not rename/drop existing V2 objects until compatibility is proven.

## Task 2 — Verify baseline

Before feature work, run the project's existing verification commands.

At minimum identify and run what applies:

```text
install/dependency check
lint
unit tests
database tests
integration tests
E2E tests
production build
```

Do not invent a command if the project uses a different one.
Read `package.json` and project scripts.

Record:
- command;
- result;
- failures;
- whether failure existed before changes.

## Task 3 — Recommend the FIRST safe implementation slice

After audit, choose the smallest implementation slice that advances the target architecture without destabilizing V2.

Do not automatically jump to TikTok LIVE.

Select based on actual V2 gaps/dependencies.

The preferred dependency direction is:

```text
V2 baseline
→ catalog/customer/inventory compatibility
→ reservation
→ live campaign/comment model
→ parser
→ CHỐT & IN transaction
→ print job
→ mobile print
→ Zalo customer completion
→ Final Order
→ fulfillment
→ COD
```

For the first slice provide:

1. exact scope;
2. schema delta;
3. code delta;
4. tests;
5. migration/backfill;
6. rollback;
7. acceptance criteria.

Then implement that slice unless it would require a destructive migration or unresolved business decision. In that case stop after the plan and clearly state the blocker.

## Target architecture rules to enforce

### Commerce

```text
COMMENT != SALE
PARSER != SALE
CHỐT & IN = COMMIT
```

`commit_live_sale_ticket()` is an authoritative transaction.

It should eventually atomically perform:

```text
verify permissions
verify active campaign/session
claim comment
resolve campaign customer/STT
resolve customer cart
lock inventory
check AVAILABLE
create Live Sale Ticket
create Cart Item
create Reservation
create Print Job
append Audit
append Outbox
mark comment COMMITTED
```

Do not implement this as independent browser inserts.

### Inventory

Do not make `products.stock` authoritative.

Target:

```text
ON_HAND
RESERVED
AVAILABLE
```

with:

```text
AVAILABLE = ON_HAND - ACTIVE_RESERVATIONS
```

Reconcile this with current V2 inventory instead of replacing it blindly.

### Printing

Physical print happens after the business commit.

If print fails:

```text
ticket remains committed
cart remains correct
reservation remains active
print job becomes failed
```

Reprint does not create another sale.

### Customers

Use stable identities.

TikTok LIVE user, TikTok Shop buyer, Zalo UID, and phone are not automatically identical.

### Orders

Customer Cart is not Final Order.

Convert only through an idempotent authoritative command.

### Finance

```text
DELIVERED != COD_SETTLED
```

Do not double count COD as revenue.

### Integrations

TikTok/Zalo/carriers are adapters.

Webhook:

```text
verify
→ deduplicate
→ persist inbox
→ ACK
→ async process
```

Side effects:

```text
transaction
→ outbox
→ worker
```

### Security

Every new workspace-scoped table requires RLS.

Secrets stay server-side.

## Change-management rules

- Keep existing React JS conventions unless there is a real reason otherwise.
- No full TypeScript migration.
- No giant refactor mixed with feature work.
- One migration concern per logical migration where practical.
- Add comments/docs for non-obvious business invariants.
- Preserve backwards compatibility during staged migration.
- Never delete production data as part of a convenience migration.
- If current V2 already implements a target feature differently but correctly, prefer adapting the target architecture to the working implementation rather than replacing it without benefit.

## At the end of this session

Return:

### A. V2 baseline summary
What the repo actually is today.

### B. Gap summary
Top 10 gaps against target architecture.

### C. Risk summary
Especially:
- production data;
- ledger/accounting;
- RLS;
- inventory;
- concurrency;
- external integrations.

### D. Changes made
Exact files/migrations.

### E. Verification
Commands and results.

### F. Next step
One next safe implementation slice only.

Do not claim the full architecture is implemented unless every required module and Definition of Done is actually satisfied.
