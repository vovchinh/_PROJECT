# Database facts

Historical migrations `001`–`012` are retained. Local additive migration `013_catalog_management.sql` adds `product_categories` with workspace-scoped parent FK, RLS and normalized code uniqueness. It adds nullable category, barcode, sale price and image URL to `products`, plus archive metadata. Existing product and variant IDs and all posted documents, FIFO lots and ledgers remain unchanged.

Catalog mutations use role-checked RPCs. Authenticated clients have SELECT on category rows under membership RLS; direct writes remain denied. Product delete checks receipts, movements, sales lines, lots, timeline, reservations, allocations, live tickets and related cart/print history. A delete removes only unused catalog metadata and records an audit event.

`013` has been tested locally on fresh and populated `001`–`012` databases. Later additive migrations `014`–`016` implement expense categorization, document corrections and bank-statement import. No production application of these migrations is inferred from local tests.

## HR additions (017–020)

`017` creates workspace-scoped departments, positions and employee profiles. `018` creates absolute-time work schedules, attendance and leave workflow. `019` creates contract rules, periods, immutable payslip lines, salary advances and salary expense recognition. `020` adds confirmed allowance/bonus/commission/other-deduction inputs and extends server payroll calculation; every approved line retains its source snapshot. Existing `cash_transactions`/`cash_movements` remain the only cash ledger.

All HR tables use workspace FKs, owner/manager RLS and read-only grants to authenticated clients; mutations use checked RPCs and audit. The salary component request table is private. `019` redacts cash results in the legacy SECURITY DEFINER report for staff/viewers once HR cash exists, while leaving stock data visible. HR cash reversal is blocked after the voucher is linked to an advance or paid payslip. Tests `test:hr-core`, `test:hr-attendance-leave`, `test:hr-payroll`, `test:hr-payroll-components` apply the migrations to disposable PGlite instances.

The files are **not** evidence that the user's Supabase production database has been migrated. Apply `017` → `018` → `019` → `020` once, after reviewing the target project; do not rerun `001`–`003`.
