# Current handoff — HRM & Payroll

## Employee-only access handoff — 26/10/2026

Local migration [`026`](../../supabase/migrations/026_employee_self_access.sql) adds `employee` as a workspace role, denies the old generic ERP RLS/RPC checks for that role, and permits QR/attendance self RPCs plus a new approved/paid self-payslip RPC. React skips the bulk ERP loader and shows the personal attendance page with work time and payslips. Owner adds membership, then HR links `auth_user_id` on the active employee profile; see [operator guide](../ERP_ROLES_AND_SELF_SERVICE.md).

`npm run test:erp-access`, `npm run test:hr`, `npm run test` and `npm run build` pass locally. Cloud migration/device testing has not been performed. Legacy `staff`/`viewer` retain broad operational read and staff draft permissions; the next security phase must inventory existing staff assignments and enforce finance/sales access at RLS and SECURITY DEFINER RPC boundaries before enabling role presets in UI.

The repository has local additive HR migrations `017_hr_core.sql`, `018_hr_attendance_leave.sql`, `019_hr_payroll.sql`, and `020_hr_payroll_components.sql`, React route `#/hr`, genuine Supabase RPC forms and focused PGlite tests. Earlier ERP migrations `013`–`016` are also present. Historical `001`–`003` were not changed. See [HR plan](../../plans/active/hr-payroll.md) and [setup](../HR_PAYROLL_SETUP.md).

Owner/manager alone may operate HR. Payroll uses explicit contract/period work units and OT factor. Approval recognizes gross expense in `hr_payroll_expenses` once; owner/manager settlement and period-linked advances post to the existing cash ledger but are profit-ineligible cash categories. Components require confirmed amounts/reasons, and commission requires a source reference. Tax/BHXH and bank transfer are not inferred.

Focused HR suites and desktop/mobile visual fixture pass locally. Check [current verification](../verification/CURRENT.md) for the final broad regression result. The actual Supabase migration state is unknown; do not claim real-cloud acceptance, rerun `001`–`003`, or auto-run SQL on production. After deployment, execute an authenticated owner/manager and staff/viewer smoke test using isolated trial data.

## Bank statement import handoff

PDF migrations `021` and `022` are additive and locally verified. The PDF sample yields 83 ordinary TKTT rows; 12 CCTG rows are excluded without persisting their content. The seller chooses an existing ERP cash account before staging; the server checks workspace and pre-fills pending rows. **Lịch sử nhập sao kê** replaces the old saved-file selector and opens both Excel/PDF batches for classification or review. See [PDF guide](../TECHCOMBANK_PDF_IMPORT.md) and [verification](../verification/CURRENT.md). Do not apply migrations on production automatically.

The real Techcombank Excel file was audited in [Excel plan](../plans/techcombank-excel-import.md). Excel-specific implementation was intentionally stopped after analysis. Its 65-column decoded layout is rejected by the current 50-column reader, and generic Excel staging still accepts whole raw rows. Implement a strict Excel adapter/server allowlist before importing that sample; do not treat the existing Excel regression tests as proof that it is safe for this layout.

## Recurring schedules and overtime handoff — 14/10/2026

Local migrations [`024`](../../supabase/migrations/024_hr_recurring_schedules.sql) and [`025`](../../supabase/migrations/025_hr_overtime_approval.sql) extend the existing HR/QR tables. `024` stores per-template **unpaid** break minutes, weekly rules and effective-dated assignments for up to 200 selected employees per request; it creates a bounded initial 45-day schedule, offers up to 60-day manager synchronization, and records one-day overrides with reason/audit. `025` records separate append-only overtime decisions, blocks payroll while confirmed overtime lacks a current decision, uses approved minutes rather than observed late checkout in payroll, and ensures nearby recurring shifts under a valid QR scan. The existing payroll expense and Thu Chi paths remain authoritative.

React now has **Ca làm việc** and **Duyệt tăng ca** tabs under HR; the attendance screen can edit one generated day through its override RPC. See [usage](../HR_RECURRING_SCHEDULES.md) and [local checks](../verification/CURRENT.md). The historical [recurring-schedule audit](../plans/recurring-shift-scheduling.md) is retained as a preimplementation record. Production/staging migration state, authenticated RLS behavior and real device scanning are **unverified**. Paid breaks, holidays, department defaults and adjustments to approved/paid payroll need separate policy and implementation; do not infer them from current code.
