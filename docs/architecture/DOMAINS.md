# ERP domains — current repository

- **Catalog:** `products.id` is the stable SKU identity. Migration `004` provides its one-to-one compatibility variant and aliases. Local migration `013` adds product categories, sale reference fields, archive and conditional delete.
- **Purchasing:** one `purchase_receipts` row represents one SKU. Draft edit, post and owner reversal exist in `001`/`003`; posted purchases produce purchase movements and FIFO lots.
- **Inventory:** on-hand is held in `inventory_lots`; order allocations and active inventory reservations reduce available quantity. Shipping/returns use `sales_events` and allocations. There is no general stock adjustment/warehouse-transfer writer in `001`–`013`.
- **Cash:** `cash_transactions` and immutable `cash_movements` implement draft, post and reversal. Migration `014` adds workspace expense categories and posted classification snapshots; `016` adds statement import. HR advances and salary settlement reuse this ledger.
- **Sales and Live:** V2 sales, reservations and live tickets remain independent of ERP catalog management. A live ticket is not recognized revenue.
- **Reporting:** `get_workspace_report` covers receipt/cash movements and `get_sales_state` covers V2 sales/FIFO. The legacy report is cash flow, not a complete management P&L. HR salary recognition is stored separately from payout.
- **HR:** additive migrations `017`–`020` hold departments, positions, employee records, shifts, attendance, leave, contract policies, payroll snapshots, salary components and period-linked advances. Only owner/manager may read sensitive records; payroll approval recognizes gross cost once, while payment uses existing cash postings.

See [active implementation plan](../../plans/active/erp-operations-enhancement.md) for gate status and rollback.
