# Current local verification — 11/10/2026

## Employee self-service access — local verification, 26/10/2026

Additive migration `026_employee_self_access.sql` introduces workspace role `employee` without granting generic ERP read. It permits QR/attendance self RPCs for a linked active employee and adds a self-only approved/paid payslip read model. React routes `employee` to **Chấm công của tôi** without calling the bulk ERP loader. Existing `staff` and `viewer` permissions remain broad. See [role guide](../ERP_ROLES_AND_SELF_SERVICE.md).

| Check | Local result |
| --- | --- |
| `npm run test:erp-access` | PASS: 001–026 migrations, membership, workspace isolation, own attendance/payslip, direct ERP denial, outsider denial and QR permission path |
| `npm run test:hr` | PASS: all seven HR PGlite suites |
| `npm run test` | PASS: Vitest 283/283 |
| `npm run check` | PASS: unit, DB, operations, foundation, Live, HR, new access test and production build |
| `npm run build` | PASS; existing large-chunk warning |
| `npm run test:e2e -- tests/e2e/hr-qr-visual.spec.js` | PASS 1/1; synthetic employee payslip rendered in mobile screenshot and inspected, without authenticated Supabase |
| `npm run format:check` | FAIL: repository-wide formatting debt; no bulk rewrite attempted |
| Staging/production Supabase, authenticated browser, physical QR scan | **Not checked** |

Owner must add the `employee` membership and link its Auth user ID to an active HR profile. Staff-level finance/sales access is **not** made least-privilege by `026`; domain-by-domain RLS/RPC restrictions remain required before claiming enterprise-wide RBAC.

The repository contains additive ERP migrations `013`–`016` and HR migrations `017`–`020`. Historical `001`–`003` were not edited. The real Supabase project's migration state is **not verified** by local tests.

| Area | Local evidence | Real cloud |
|---|---|---|
| HR employee/catalog | `test:hr-core` — 10 checks, PGlite | Not checked |
| HR attendance/leave | `test:hr-attendance-leave` — 12 checks, PGlite | Not checked |
| HR payroll/cash/privacy | `test:hr-payroll` — 16 checks, PGlite | Not checked |
| HR components | `test:hr-payroll-components` — 7 checks, PGlite | Not checked |
| HR UI | Desktop/mobile visual fixture E2E 1 test passed; screenshots viewed. Production Vite build passed. | Actual authenticated HR flow not checked |
| Existing V2 regression | `npm run check` passed: Vitest 262/262, database 25/25, operations 41/41, foundation/live suites, HR 45/45, and production build. `npm run test:e2e` passed 9/9 after narrowing an ambiguous legacy product-code selector. | Not checked |

Screenshots: `test-results/screenshots/hr-desktop-dashboard.png`, `hr-desktop-employees.png`, `hr-mobile-dashboard.png`, `hr-mobile-employees.png`, `hr-mobile-employee-form.png`. They use deterministic test-only data inside the actual React components. The desktop layout preserves ChiDi's current shell rather than replacing it with the dark sidebar from the reference. On mobile, HR sections are separated by tabs and the employee editor hides the list while open. An empty six-month salary chart shows an empty state rather than zero-value bars.

Known scope: payroll implements configured monthly/hourly contracts, confirmed work and paid leave, overtime, period-linked advances, and confirmed allowance/bonus/commission/other deductions. It does not infer tax/BHXH, holiday/weekend policies, commission from sales, bank transfer, or statutory P&L. The existing global cash report is not a full management P&L. Salary expense recognized on approval is available in HR reporting; it is not silently added to cash expense twice.

Apply and smoke-test `017` → `018` → `019` → `020` on the actual Supabase project only after review. See `docs/HR_PAYROLL_SETUP.md`.

## Techcombank statement import — local verification, 12/10/2026

The additive `021_pdf_bank_statement_guard.sql` and `022_pdf_bank_account_cctg_exclusion.sql` are local only; real Supabase application is unverified. PDF.js reads the verified TKTT grid locally and never uploads the original PDF. On the private eight-page sample, it retained **83 valid TKTT transactions**, structurally recognized **12 CCTG rows on pages 7–8**, excluded all CCTG data, and returned `parse_ready=true`. Unknown pages after CCTG still block staging. The user selects one existing workspace cash account; the verified server RPC pre-fills that account on staged rows without importing the PDF holder name or full bank number. The shared UI now exposes a paginated **Lịch sử nhập sao kê** for Excel and PDF. See [user instructions](../TECHCOMBANK_PDF_IMPORT.md).

| Check | Local result |
|---|---|
| PDF parser + payload (`npm run test -- src/lib/techcombank-pdf.test.js src/features/bank-import-pdf-payload.test.js`) | 16/16 PASS locally, including a conditional private-sample test |
| PDF privacy/RLS/ledger (`node scripts/test-pdf-bank-statement-security.mjs`) | 9/9 PASS, PGlite; includes pending cross-batch duplicate review |
| PDF account/CCTG migration (`node scripts/test-pdf-bank-account-cctg-exclusion.mjs`) | 6/6 PASS, PGlite; account workspace, role, allowlist, exclusion metadata and exactly-once cash posting |
| Existing Excel import (`npm run test:bank-statement`) | 12/12 PASS |
| Full repository (`npm run check`) | PASS: Vitest 278/278; DB 25/25; operations 41/41; foundation, live and HR suites; Vite build |
| Browser (`npm run test:e2e`) | 9/9 PASS; no authenticated PDF upload on real Supabase |
| Private PDF sample | Local parser PASS, 83 TKTT rows retained and 12 CCTG rows excluded; no sample content committed |

The real Excel sample was audited only. It has a 65-column decoded sheet and a separate CCTG table; the current generic Excel reader rejects the workbook before staging. The existing Excel staging still sends whole decoded rows, so it does **not** satisfy the new privacy allowlist for this sample. No Techcombank Excel adapter or Excel schema migration was implemented in this audit phase. See [Excel audit and mapping](../plans/techcombank-excel-import.md). Authenticated history/PDF UI on the actual Supabase project has not been browser-tested.

## QR attendance — local verification, 13/10/2026

Migration `023_hr_qr_attendance.sql` adds workspace-scoped attendance sites, effective-dated employee assignments, optional site binding on existing shifts, short-lived kiosk QR challenges and immutable check-in/out events. QR scans update the existing **draft** `hr_attendance`; manager confirmation and payroll remain on the existing path. No historical shift receives an inferred site. The new UI provides a manager kiosk/setup tab and an employee self-scan page. See [setup and usage](../HR_QR_ATTENDANCE.md).

| Check | Local result |
|---|---|
| `npm run test:hr-qr` | PASS 16/16 in PGlite, including expired/wrong-site QR, workspace/RLS, overnight shift, retry, rate limit, payroll after manager confirmation and legacy manual flow |
| `npm run check` | PASS: Vitest 278/278, DB 25/25, operations 41/41, foundation/live/HR suites, production build |
| `npm run test:e2e` | PASS 10/10, including QR kiosk and employee view component smoke on desktop/mobile with test-only API fixture |
| Real Supabase migration `023` and authenticated role/device smoke | **Not checked**; local PGlite does not prove cloud deployment, browser camera permissions or physical presence |

The QR screenshots in `test-results/screenshots/hr-qr-kiosk-desktop.png`, `hr-qr-kiosk-mobile.png`, and `hr-qr-employee-mobile.png` were viewed. These use synthetic component fixtures, not authenticated cloud data or a real camera. QR validity is 30 seconds, so a shared image can still be used while valid. Owner/manager must review attendance before payroll. Overtime approval as a separate policy and adjustments after an approved/paid payroll run are not supplied by migration `023`.

Repository-wide `npm run format:check` still reports 38 files, including shared/older modules. Bulk formatting of those files was left out of this feature work. Functional checks and the production build pass.
One intermediate full-check run hit a transient Windows `EPERM` while the unrelated Live Simulator renamed a temporary JSON file; its focused rerun and the final full `npm run check` both passed.

## Recurring schedules and overtime — local verification, 14/10/2026

Additive migration `024_hr_recurring_schedules.sql` supplies explicit shift templates, weekly rules, effective-dated bulk employee assignments, a bounded 45-day initial shift horizon, manager synchronization up to 60 days, one-day overrides and payroll coverage checks. Migration `025_hr_overtime_approval.sql` adds append-only manager overtime decisions, gates payroll calculation/approval on reviewed overtime, snapshots approved minutes and schedule provenance, and creates missing nearby recurring shifts only after a valid QR challenge. See [operator guide](../HR_RECURRING_SCHEDULES.md). Historical `001`–`003` were not changed.

| Check | Local result |
|---|---|
| `npm run test:hr-recurring` | PASS 18/18, PGlite, including effective-date employee filtering, one-day override audit/idempotency and protection against closing a schedule retroactively |
| `npm run test:hr-overtime` | PASS 9/9, PGlite, including partial/rejected overtime, payroll gate, QR just-in-time shift and cross-workspace protection |
| `npm run check` | PASS across unit, database, operations, foundation, Live, seven HR suites and production build; Vitest 283/283 |
| `npm run test:e2e -- tests/e2e/hr-recurring-visual.spec.js` | PASS 1/1 using a local visual fixture; desktop/mobile screenshots were opened and inspected. This does not prove an authenticated Supabase flow. |
| `npm run format:check` | FAIL on 37 pre-existing/unrelated files; the HR files changed in this work were formatted separately. |
| Real Supabase `024`/`025`, authenticated roles, device scan, reconciliation | **Not checked**; PGlite does not establish cloud behavior |

Per-template breaks are explicit **unpaid** minutes. Paid breaks, holiday rules, group-derived schedules, and automatic correction of already approved/paid payroll are not implemented. Payroll's existing read model fails for workspaces with over 500 contracts, and its screen fetches at most 500 employee labels; a paginated read model is needed before claiming support at that scale. An authenticated desktop/mobile workflow and real-device camera still need verification on Supabase staging.
