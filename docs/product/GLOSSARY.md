# Management glossary

- **SKU:** one row in `products`; its UUID remains stable for all historical references.
- **Compatibility variant:** one-to-one row in `product_variants` mapped to a SKU; legacy attributes may remain `needs_review`.
- **Archive:** makes a master record unavailable for new use while retaining history.
- **Draft:** business document not yet posted to stock/cash ledgers.
- **Post:** commits a receipt/cash document and creates its authoritative movement.
- **Reverse:** posts a compensating movement, leaving the original document in the audit chain.
- **On hand / reserved / available:** physical lot balance / active holds / balance usable for a new reservation.
- **Management profit:** dated net sales less FIFO COGS and eligible operating expense; not a statutory financial statement.
