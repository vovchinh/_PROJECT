# ChiDi ERP context index

Read [AGENTS.md](../AGENTS.md) first. The current repository, migrations and passing tests supersede this index.

| Tag | Smallest relevant context |
|---|---|
| `@context:catalog` | `supabase/migrations/001_core.sql`, `004_catalog_variants_aliases.sql`, `013_catalog_management.sql`, `src/pages.jsx` Catalog, `src/forms.jsx` MasterForm, `scripts/test-catalog-management.mjs` |
| `@context:inventory` | `003_sales_inventory.sql`, `006_inventory_reservations.sql`, `src/features/Sales.jsx`, `scripts/test-inventory-foundation.mjs` |
| `@context:sales` | `003_sales_inventory.sql`, `005_customer_order_foundation.sql`, `006_inventory_reservations.sql`, `src/features/Sales.jsx` |
| `@context:database` | [DATABASE.md](../architecture/DATABASE.md), [INVARIANTS.md](../architecture/INVARIANTS.md), `supabase/migrations/` |
| `@context:verification` | [CURRENT.md](../verification/CURRENT.md), [TESTING.md](../engineering/TESTING.md), `package.json` |

The [active ERP plan](../../plans/active/erp-operations-enhancement.md) records current gates and remaining work. Open only the tag needed for the task.
