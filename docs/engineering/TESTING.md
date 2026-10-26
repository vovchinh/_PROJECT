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

## HR checks

- `npm run test:hr` — runs seven focused PGlite suites for migrations `017`–`020`, `023`, `024` and `025`: profiles/roles, overnight attendance and leave, contract payroll/cash, salary components, QR attendance, recurring schedules and separate overtime approval.
- `npm run test:hr-qr` — checks QR sites, effective-dated assignments, kiosk challenges, server-timed check-in/out, immutable events, retry, rate limiting, workspace isolation and existing manual attendance compatibility.
- `npm run test:hr-recurring` — checks weekly rules, explicit shift break minutes, effective dates, bulk assignment/overlap, finite materialization, preview, one-day override, request idempotency, access control and source history.
- `npm run test:hr-overtime` — checks manager overtime decisions, pending/rejected/partial approval, payroll calculation/approval gates and snapshots, QR just-in-time shift creation, retry, role and workspace isolation.
- `npm run test -- src/features/hr/hr-datetime.test.js src/features/hr/hr-attendance-form.test.js` — checks Vietnam wall-time conversion and inheritance of the per-shift unpaid break in a manual attendance draft.
- `npm run test:e2e -- tests/e2e/hr-recurring-visual.spec.js` — mounts the real recurring schedule and overtime components with local test data, exercises manager selection/preview/review dialogs on desktop and mobile, and saves screenshots. It does not confirm changes in Supabase.
- `npm run test:e2e -- --grep "QR kiosk"` — mounts the actual manager kiosk and employee attendance components with synthetic test-only RPC responses, checks desktop/mobile rendering and saves screenshots. It does not use a real camera or Supabase account.
- `npm run test:e2e -- --grep "HR desktop and mobile"` — mounts actual HR React components with a **test-only fixture** inside the existing shell, checks desktop/mobile rendering and screenshots. This does not submit data to Supabase.
- `npm run build` — Vite production bundle, including lazy HR chunk.
- `npm run check` — broad local regression; now includes `test:hr`.

Before enabling HR/QR/recurring schedules in the real workspace, separately verify in Supabase that migrations `017`–`020` and `023`–`026` applied in repository order, RLS is active, owner/manager can operate, staff/viewer cannot see PII/payroll, the `employee` role sees only its own attendance and approved payslip, and an internal salary payment produces exactly one linked cash posting per payslip. Exercise bulk assignment, QR-created shifts, overtime review and payroll coverage on isolated trial data. Test the kiosk and camera on actual devices. Local tests cannot attest to that deployment.

## Techcombank statement checks

- `npm run test -- src/lib/techcombank-pdf.test.js src/features/bank-import-pdf-payload.test.js` — local PDF parser, CCTG exclusion, privacy boundary and payload. The real PDF sample check runs only when the private ignored file exists locally; it asserts counts without printing statement values.
- `node scripts/test-pdf-bank-statement-security.mjs` — migration `021` privacy and existing ledger path.
- `node scripts/test-pdf-bank-account-cctg-exclusion.mjs` — migration `022` workspace account, excluded CCTG aggregate, roles, idempotency and exactly-once posting.
- `npm run test:bank-statement` — existing Excel staging regression. The supplied Techcombank Excel sample is **not** supported yet; see [audit](../plans/techcombank-excel-import.md).
- `npm run check` and `npm run test:e2e` — full local regression. Neither verifies the real Supabase project or the authenticated import history UI.
