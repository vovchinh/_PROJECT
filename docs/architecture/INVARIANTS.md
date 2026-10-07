# ERP invariants

1. Preserve `products.id` and `product_variants.id = products.id`; editing a SKU does not rewrite old purchase/sale snapshots or FIFO costs.
2. Referenced product/category records are archived instead of deleted. An active stock reservation blocks product archive, and new business use of an archived SKU is rejected by database triggers.
3. Draft receipt/cash documents may be edited. Posted documents and their movements are not edited directly; their reversal adds dated compensating effects with actor and reason.
4. `available = on_hand − reserved order allocations − active manual/live reservations`; a reservation is not a stock movement.
5. Cash movement does not imply accounting expense or sale revenue. Purchase cash and COD receipts must not inflate managerial profit.
6. Each sensitive mutation is scoped to the authenticated workspace and audited. Client-side filters or buttons never substitute for RPC authorization.
