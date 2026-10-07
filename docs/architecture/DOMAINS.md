# ERP domains — current repository

- **Catalog:** `products.id` is the stable SKU identity. Migration `004` provides its one-to-one compatibility variant and aliases. Local migration `013` adds product categories, sale reference fields, archive and conditional delete.
- **Purchasing:** one `purchase_receipts` row represents one SKU. Draft edit, post and owner reversal exist in `001`/`003`; posted purchases produce purchase movements and FIFO lots.
- **Inventory:** on-hand is held in `inventory_lots`; order allocations and active inventory reservations reduce available quantity. Shipping/returns use `sales_events` and allocations. There is no general stock adjustment/warehouse-transfer writer in `001`–`013`.
- **Cash:** `cash_transactions` and immutable `cash_movements` implement draft, post and reversal. Category is currently legacy text; the dedicated category migration is E3.
- **Sales and Live:** V2 sales, reservations and live tickets remain independent of ERP catalog management. A live ticket is not recognized revenue.
- **Reporting:** `get_workspace_report` covers receipt/cash movements and `get_sales_state` covers V2 sales/FIFO. A dated management-profit report is E7.

See [active implementation plan](../../plans/active/erp-operations-enhancement.md) for gate status and rollback.
