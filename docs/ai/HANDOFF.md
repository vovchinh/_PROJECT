# ERP operations handoff

Current branch contains local E1 plan and E2 catalog management migration `013`, UI and tests. No production Supabase schema change has been confirmed. Do not rerun `001`–`012` or claim real-cloud acceptance from PGlite/fixture checks.

Next gate is E3: add workspace expense categories around existing free-text `cash_transactions.category`, preserve the exact historical category and profit eligibility policy, and reconcile original `cash_movements` without editing them. Then implement E4–E8 in order, running focused checks at each gate and one full regression before completion. The [active plan](../../plans/active/erp-operations-enhancement.md) records compatibility and rollback.
