# ERP test commands

Run with Node 22.12+ from the project root. Commands are defined in `package.json`.

- `npm run test:catalog-management` — migration `013`, populated upgrade, fresh install, roles/RLS, archive/delete, stock and hold safety.
- `npm run test:catalog` — existing compatibility SKU/variant/alias/FIFO regression.
- `npm run test:operations` — cash and dated receipt/cash report baseline.
- `npm run test:inventory` — FIFO and reservation baseline.
- `npm run test:e2e -- --grep "catalog categories"` — local browser catalog workflow.
- `npm run build` — production bundle.
- `npm run check` — broad local regression after all affected gates.

PGlite tests mock Auth/JWT locally. Browser cloud fixtures mock Supabase HTTP. Neither proves deployment to the real Supabase project.
