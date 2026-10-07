# ChiDi ERP operations enhancement — active plan

## E1. Verified starting point (07/10/2026)

Source of truth: migrations `001`–`012`, current React/Javascript code and local tests. The requested `docs/ai/CONTEXT_INDEX.md` and named context files do not exist in this checkout; inspect the corresponding migration, source and verification files directly. Do not change historical migrations `001`–`003`, product UUIDs, posted ledger rows, FIFO cost or tenant authorization.

| Area | Current behavior | Safe increment |
|---|---|---|
| Catalog | `products` is the stable SKU. `004` maps every SKU to one compatibility variant and offers styles/aliases. No category, archive or conditional delete. | `013`: additive product metadata/categories; scoped RPC mutations and impact check; preserve `product_variants.id = products.id`. |
| Purchase | One `purchase_receipts` row is one SKU, with generated total. `create_purchase(id)` edits draft; `post_purchase` creates movement and FIFO lot; `reverse_document` checks consumption/holds. | Add draft cancellation/deletion and a linked correction draft only after reversal. No invented multi-line receipt semantics. |
| Inventory | `stock_movements` records purchase post/reversal; `inventory_lots` records purchase/return; `sales_allocations` and `inventory_reservations` are separate holds. | Show authoritative on-hand/reserved/available and drilldown. A generic stock adjustment requires its own safe ledger design and remains gated until independently modeled/tested. |
| Cash | `cash_transactions.category` is free text constrained at posting by the old allowlist. Drafts are editable; posted cash has owner-only reversal and immutable `cash_movements`. | Add workspace categories with exact-value legacy mapping and a review list for unknowns; never reinterpret historical categories. Draft deletion and linked correction only through RPC. |
| Reporting | `get_workspace_report` summarizes receipts/cash; `get_sales_state` summarizes sales/FIFO. Neither is a dated management profit report. | Combine dated `sales_events` revenue/COGS effects and eligible posted cash movement effects by Vietnam business date. Reversals must remain visible by movement date. Clearly label managerial profit, not statutory P&L. |
| Lists | Primary ERP pages load and search entire workspace arrays in React; no bounded historical query. | Add bounded, workspace-scoped filtered/keyset reads for growing documents and relevant catalog/inventory views before claiming scale readiness. Keep existing screens. |

## Delivery gates

1. **E2 — Catalog safety.** New migration only. Product archive does not change historical purchases, variants, lots or tickets. Hard delete is allowed only with no business reference, stock, hold or historical audit requirement; return stable impact codes. Category delete only when unreferenced; no orphaned products. Add local PostgreSQL tests for tenant isolation, RLS, audit, products in each historical path and concurrent delete vs write. Gate: focused DB tests + existing catalog test + build pass.
2. **E3 — Expense categories.** Extend legacy free-text rather than replacing it. Backfill exact known values, retain original text and mark unknown/unmapped; preserve old operating-expense policy for legacy entries. Category changes are prospective and auditable. Gate: mapping reconciliation + role/RLS tests + cash posting regression.
3. **E4 — Corrections.** Draft receipt/cash edit exists. Add scoped draft delete and posted replacement reference workflow; replay-safe request IDs. Existing `reverse_document` remains the only ledger reversal. Any stock adjustment capability needs separate formal invariants before writer UI. Gate: post/reverse retry and stock/cash reconciliation tests.
4. **E5 — Search and lists.** Shared small toolbar, Vietnamese empty/result/clear states, bounded server query with whitelisted sort/filter, stable cursor/pagination. Gate: filter/sort/pagination tests in database and UI.
5. **E6 — Inventory UI.** On-hand/held/available by SKU/warehouse from existing authoritative read models; lot/movement/source details and low-stock thresholds once defined. Do not show unsupported damaged/incoming quantities as facts. Gate: inventory/FIFO/reservation regression.
6. **E7 — Expense and management profit.** Document KPI formulas, inclusion statuses, dates/timezone and source drilldowns. Exclude capital, owner withdrawals, purchase payment and COD receipt. Preserve legacy payroll exclusion unless new posting-time policy is introduced. Gate: deterministic 10m sales − 6m COGS − 1m eligible OPEX = 3m operating profit, returns and reversal timing tests.
7. **E8 — Hardening.** Review RLS/ACL, authorization, concurrency, idempotency and limits. Run focused tests after each gate and one full `npm run check` at end; run Playwright/build where affected. Cloud checks require an authenticated workspace and are recorded as unavailable until actually executed.

## Compatibility, evidence and rollback

- Each new workspace table gets `workspace_id`, scoped foreign keys, RLS and useful indexes. Browser writes go through role-checked RPCs; actor comes from `auth.uid()`.
- Keep old category text, product IDs, document statuses, posted movements, FIFO lots and audits. Do not manufacture legacy supplier/category/date/account facts.
- Upgrade path: run each new migration once after `012`; test clean `001`–latest and upgrade with existing documents/lots/holds/tickets. Capture counts and exception rows before/after migration.
- Rollback strategy: stop new UI/RPC calls and redeploy the prior frontend; preserve additive tables and columns until a reviewed data migration can undo them. Never delete posted facts to roll back a feature.

## Verification ledger

- E1 baseline: `npm run test:catalog` → 40 PASS (07/10/2026).
- E2: `npm run test:catalog-management` → 12 PASS (populated upgrade, fresh install, stock/hold safety, RLS/roles, isolation, audit); `npm run test:catalog` → 40 PASS; focused demo E2E → 1 PASS; `npm run build` → PASS (07/10/2026). Migration `013` is local and still needs application on the real Supabase project.
- E3–E8: pending their gates; do not mark cloud, printer or TikTok checks PASS based on local fixtures.
