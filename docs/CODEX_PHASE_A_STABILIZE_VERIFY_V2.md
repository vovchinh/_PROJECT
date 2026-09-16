# CODEX PROMPT — Phase A: Stabilize & Verify Existing ChiDi V2

You are working inside the EXISTING ChiDi ERP / ChiDiPos V2 repository.

The repository has already been audited. Use the audit findings as the current baseline.

IMPORTANT:
- V2 sales code exists.
- V2 has NOT yet been proven fully verified or deployed on the user's Supabase.
- Do not claim V2 is production-ready until verification below passes.
- Do not implement TikTok LIVE, Zalo, Live Sale Ticket, CHỐT & IN, print jobs, or other new commerce architecture yet.
- This task is ONLY Phase A: stabilize and verify the V2 baseline.

## Read first

Read:

1. `AGENTS.md`
2. `docs/architecture/V2_CURRENT_STATE.md`
3. `docs/architecture/V2_TARGET_GAP_ANALYSIS.md`
4. `docs/architecture/V2_MIGRATION_PLAN.md`
5. all existing Supabase migrations, especially 001 / 002 / 003
6. package.json
7. current sales implementation
8. current tests
9. current V2 docs / TASKS / VERIFICATION / CHANGELOG

Treat current repository code, migrations, actual schema, passing tests, and runtime evidence as the current source of truth.

## Non-negotiable migration rules

- DO NOT rerun, rewrite, or edit migration 001.
- DO NOT rerun, rewrite, or edit migration 002.
- DO NOT casually rerun, rewrite, reverse, or modify migration 003.
- First determine whether 003 is actually applied in the target Supabase environment.
- Preserve the exact currently-shipped 003 SQL/checksum.
- Any fixes after 003 must be made in a NEW reviewed migration.
- Do not drop existing sales lots, allocations, events, or ledger data.
- Do not reset production data.
- Do not restore an old database over newer sales transactions.

If 003 is not verifiably applied, report that clearly and use a safe verification plan before mutation.

## Phase A objectives

### A1. Establish real V2 baseline

Verify:

- exact application version;
- package version;
- migration state;
- whether 003 exists locally;
- whether 003 is applied in Supabase;
- current Auth state;
- workspace isolation;
- current sales RPC availability;
- current sales tables;
- current RLS policies;
- current inventory lots / allocations / events;
- current cloud environment readiness.

Create/update:

```text
docs/verification/V2_BASELINE_VERIFICATION.md
```

Include exact evidence, not assumptions.

---

### A2. Fix demonstrated demo/UI order-history contract mismatch

Audit finding:

`src/features/Sales.jsx` expects:

```text
event.event_date
event.reason
```

while demo sales history currently exposes:

```text
date
payload.reason
```

Fix the contract in the smallest compatible way.

Requirements:

- define one canonical event shape;
- keep demo/cloud repository outputs consistent;
- do not add UI-only ad-hoc field translation in multiple places;
- add regression tests proving meaningful date/reason render correctly;
- do not change business event meaning.

---

### A3. Implement and test the documented future-date rule

Existing documentation says new purchase posting and sales transitions cannot use a business date after Vietnam "today".

Current implementation does not fully enforce this.

Implement one authoritative business-date rule.

Requirements:

- calculate business "today" using `Asia/Ho_Chi_Minh`;
- server/database authoritative validation;
- browser validation may provide early UX feedback but is not sufficient;
- enforce on relevant purchase posting commands;
- enforce on relevant sales transitions;
- preserve legitimate historical dates;
- do not silently alter supplied dates;
- return a stable business error code;
- add domain tests;
- add SQL/database tests;
- add UI error handling test if applicable.

Also implement the documented future-lot warning if the current V2 UI/docs require it.

Do not invent a new rule beyond what current V2 documentation already specifies.

---

### A4. Add real V2 automated sales coverage

The audit found no automated V2 sales coverage.

Add coverage for migration 003 and V2 sales behavior.

At minimum test:

#### Draft / order lifecycle
- create draft;
- multi-line order;
- price and discount persistence;
- confirm;
- shipped;
- delivered;
- cancelled where legal;
- returns currently supported;
- illegal transitions rejected.

#### Immutable historical price behavior
After confirmation:
- changing current product/master price must not rewrite order line price/discount/line_total.

#### Workspace isolation
- Workspace A cannot read/write Workspace B sales data.

#### Role permissions
Verify actual current policy:
- staff may create/edit allowed drafts;
- posting/transition authority follows current owner/manager rules;
- viewer cannot mutate.

Do not broaden permissions while writing tests.

#### Idempotency
Test current transition idempotency behavior.

Document explicitly that draft creation currently uses unique business code rather than durable command-result idempotency.

Do NOT redesign draft creation in Phase A unless required to fix a proven bug.

---

### A5. Add true concurrency tests for inventory

The audit found locking logic but no two-connection test.

Use a real PostgreSQL/Supabase-compatible two-session test.

Test:

```text
available stock sufficient for only one competing reservation/order transition
```

Run two concurrent transactions.

Expected:

```text
one succeeds
one fails safely
no negative inventory
no duplicate allocation
no corrupted lot quantity
```

Test the actual V2 lock/allocation strategy.

Do not simulate concurrency only in JavaScript memory.

Record exact SQL/database behavior.

---

### A6. Upgrade cloud probe to verify migration 003 and sales behavior

Current cloud probe only establishes up to 002.

Extend read-only/safe verification so it can establish:

- 003-required tables/functions exist;
- expected schema shape exists;
- expected V2 sales RPCs exist;
- RLS/read behavior works for authenticated sessions where a safe test environment is available.

Do not read or print secret values.

Do not mutate production data merely to probe schema.

If an authenticated non-production test workspace is required for mutation verification, make that requirement explicit.

---

### A7. Reconcile version and documentation drift

Current audit found:

- application displays V2.0;
- package.json remains 1.1.0;
- TASKS.md contains stale V2 status;
- setup docs say testing pending;
- docs build excludes V2/new architecture docs.

Resolve version/documentation inconsistency without rewriting historical changelog truth.

Update as appropriate:

- package.json version;
- visible app version source;
- TASKS.md;
- CHANGELOG.md;
- VERIFICATION.md;
- V2 setup docs;
- docs generation/build script.

Prefer one canonical version constant/source where practical.

Document:

```text
V2 code present
V2 baseline verification status
migration 003 status
remaining blockers
```

Do not mark verification complete unless tests actually pass.

---

### A8. Make receipt-only vs current-stock reporting unmistakable

Current V1 baseline reports are receipt-only.
V2 current stock incorporates sales/FIFO behavior.

Do not silently redefine old reports.

Requirements:

- preserve existing receipt-only semantics;
- clearly label receipt-only report;
- clearly label current/available stock where shown;
- document source tables/definitions;
- add UI copy or help text where confusion is likely;
- tests must ensure the reports are not accidentally conflated.

---

### A9. Fix demo/cloud audit parity where safe

Audit finding:

Cloud 003 RPCs append audit/sales events, but demo sales methods do not append shared `audit_events`.

Bring demo behavior closer to cloud contract where doing so is safe and does not fake server permissions.

Requirements:

- preserve distinction between demo and authoritative cloud security;
- use consistent event/audit shape;
- add tests;
- document any unavoidable differences.

Do not pretend the demo proves RLS or concurrency.

---

### A10. Add historical identity/snapshot risk to the migration plan

Do not implement the full customer identity/address architecture in Phase A.

But update architecture/migration documentation to preserve this rule:

For new confirmed/finalized orders in the future, historical customer/order identity must be captured as snapshots rather than resolved only from mutable master data.

Existing historical rows that lack snapshots must never be backfilled as if reconstructed values were original historical facts.

If any small additive schema preparation is truly necessary now, explain why before implementing it.

Otherwise defer implementation to Phase B2.

---

### A11. Backup / restore drill

Perform or prepare a real documented restore drill for the V2 database.

Requirements:

- backup method;
- exact command/process;
- safe target for restore test;
- restore verification;
- row/count/business invariant checks;
- measured RPO/RTO observations where possible.

Do not call backup "verified" unless restore succeeds.

Do not overwrite production.

Create/update:

```text
docs/runbooks/BACKUP_RESTORE_V2.md
```

---

## Actor identity rule

The audit identified an important target-architecture correction:

Do not trust browser-supplied:

```text
actor_id
```

for authoritative mutations.

Actor identity must come from:

```text
auth.uid()
```

or another verified server identity.

Audit all current/new RPCs touched in Phase A.

If an RPC currently accepts an actor field only for display/context, separate that from authoritative actor identity.

Do not perform a broad API rewrite unless needed for security correctness.

---

## Do NOT implement in Phase A

Do NOT add:

```text
TikTok LIVE listener
TikTok Shop adapter
Live Campaign
Live Session
Comment ingestion
Parser
Comment claim
Live Sale Ticket
CHỐT & IN
Customer Basket
Customer Cart
Print jobs
Mobile printer bridge
Zalo
Shipping provider APIs
COD settlement
Webhook inbox for external commerce
Full outbox worker
SaaS billing
```

Exception:
If a minimal reliability primitive is REQUIRED to fix existing V2 correctness, explain it first and keep it narrowly scoped.

---

## Verification requirements

Run the real commands defined by this repository.

At minimum cover where available:

```text
lint
unit tests
database tests
operations tests
Playwright/E2E
production build
cloud/read-only probe
```

Do not invent script names.
Read `package.json`.

For every command report:

```text
command
exit result
pass/fail count
relevant warnings
whether failure existed before your change
```

---

## Required deliverables

Update or create:

```text
docs/verification/V2_BASELINE_VERIFICATION.md
docs/runbooks/BACKUP_RESTORE_V2.md
```

Update:

```text
docs/architecture/V2_CURRENT_STATE.md
docs/architecture/V2_TARGET_GAP_ANALYSIS.md
docs/architecture/V2_MIGRATION_PLAN.md
```

if findings changed.

Return a final report with:

1. Baseline state before changes
2. Exact defects fixed
3. Files changed
4. New migration(s), if any
5. Why each migration is safe
6. RLS/security impact
7. Tests added
8. Concurrency test result
9. Cloud 003 verification result
10. Version/docs reconciliation
11. Backup/restore result
12. Remaining V2 blockers
13. Rollback plan
14. Recommended next phase

## Phase A Definition of Done

Do NOT mark Phase A complete until all applicable checks pass:

```text
[ ] V2 sales tests exist and pass
[ ] demo/UI event contract is aligned
[ ] documented future-date rule is enforced and tested
[ ] 003 application state is established
[ ] cloud probe understands V2/003
[ ] two-session stock contention test passes
[ ] workspace/RLS sales tests pass
[ ] version/docs are internally consistent
[ ] receipt-only vs current-stock reporting is clear
[ ] demo/cloud audit contract mismatch is addressed/documented
[ ] authoritative actor source is secure for touched RPCs
[ ] production build passes
[ ] backup restore has been proven or explicitly remains a blocker
[ ] no 001/002/003 history was rewritten
[ ] no production data was reset
```

If any item cannot be completed due to missing credentials, environment access, or a required real cloud session:

- do not fabricate success;
- mark the item BLOCKED;
- state exactly what evidence is missing;
- complete all safe local work;
- provide the exact verification command/step required from the user.

Only after Phase A passes should you recommend moving to Phase B1.
