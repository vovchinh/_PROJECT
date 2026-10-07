# Database facts

Historical migrations `001`–`012` are retained. Local additive migration `013_catalog_management.sql` adds `product_categories` with workspace-scoped parent FK, RLS and normalized code uniqueness. It adds nullable category, barcode, sale price and image URL to `products`, plus archive metadata. Existing product and variant IDs and all posted documents, FIFO lots and ledgers remain unchanged.

Catalog mutations use role-checked RPCs. Authenticated clients have SELECT on category rows under membership RLS; direct writes remain denied. Product delete checks receipts, movements, sales lines, lots, timeline, reservations, allocations, live tickets and related cart/print history. A delete removes only unused catalog metadata and records an audit event.

`013` has been tested locally on fresh and populated `001`–`012` databases. It has **not** been verified as applied to the user's Supabase project. The next migrations must be added after `013`; do not rerun historical files.
