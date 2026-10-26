# ChiDi HRM & Payroll — implementation gates

## Repository and reference audit (Milestone 1)

- Read `docs/AGENTS.md`, `package.json`, React navigation/layout/components, migrations 001–016, workspace membership, cash posting/reversal and verification scripts. Existing V2 has no HR employee, attendance, leave, contract or payroll entities. Existing auth users are workspace users, not employee profiles.
- Reference `docs/design/references/chidi-hr-payroll.png` was inspected at original resolution. It shows a dark left navigation, pale blue content background, six compact KPIs, five shortcut cards, small payroll/department charts, an employee table beside a tabbed form and department/position cards, then attendance/leave/payroll/payslip/payment panels. Numeric values in the image are illustrative and must not enter application data.
- Keep the existing shell, breadcrumb, `Panel`, `Table`, `Modal`, `Badge`, forms and responsive sidebar. Add a focused HR route with blue/indigo scoped tokens. Use separate subviews on narrow screens; do not replicate the entire 10-panel collage on mobile.
- The existing cash ledger is the only cash ledger. Cash category `payroll` is currently noneligible in management expense totals, so payroll accrual and cash payment must be separated to avoid duplicate expense. Salary advance must carry an employee and explicitly selected payroll period.
- User policy: contract-specific monthly/hourly basis; standard work units and overtime factor configured per contract/period, never a universal 26-day divisor; payment may be posted by owner/manager as an internal cash confirmation, without pretending that a bank transfer occurred.

## Milestones and gates

| Gate | Deliverable | Exit evidence |
|---|---|---|
| M1 | Audit, image analysis, schema/UI plan | This document; baseline tests recorded |
| M2 | HR route, dashboard, employee list | Real RPC counts/search/filter/sort/page; desktop/mobile layout and test |
| M3 | Employee, department and position management | Workspace RLS, role tests, CRUD/archive, linked selects |
| M4 | Schedule/attendance and leave | Overnight/break/missing clock validation, leave state/overlap, audit tests |
| M5 | Contracts, components and calculation | Server-only calculation with explicit policy, deterministic fixtures and snapshot |
| M6 | Payslip review/approval | Immutable approved snapshots, role/transition/idempotency tests |
| M7 | Payment/advance and Thu Chi | Posted cash reuse, period-linked advance, one payment only, reconciliation |
| M8 | HR reports, responsive and hardening | Focused tests, one broad regression, production build, screenshots viewed |

## Schema and security shape

- Additive migrations 017 HR core, 018 attendance/leave, 019 payroll/payment, 020 explicit salary components. Never edit 001–003 or reset production data. Rollback is code rollback plus disabling access; applied schema and payroll records remain for audit, not destructive down-migrations.
- All HR tables use `workspace_id`, scoped FKs, RLS, useful indexes and audit. HR personal data and salary reads are owner/manager only. Employee profiles may have no `auth_user_id`; creating a profile never creates an Auth account.
- Draft attendance/leave and payroll mutations go through role-checked RPC. Approved payslip values are frozen. No tax/BHXH formulas, automatic leave deductions, sales commission or bank API are inferred.
- Cloud deployment is a separate action: run 017 → 018 → 019 → 020 in SQL Editor only after local tests and review. Local PGlite and browser tests are evidence for code, not proof that the user's Supabase project has been migrated.

## Current gate evidence (11/10/2026)

- M1–M3: repository and image audit recorded above; `017` and React route/dashboard/employee/catalog forms implemented. `test:hr-core` 10 checks passed.
- M4: `018` and schedule/attendance/leave UI implemented; `test:hr-attendance-leave` 12 checks passed.
- M5–M7: `019`/`020` and contract, period, salary component, payslip, approval, advance and existing-cash settlement UI implemented. `test:hr-payroll` 16 checks and `test:hr-payroll-components` 7 checks passed. Component changes reopen an unapproved period; approval snapshots gross expense and payment posts cash without adding expense again.
- M8: focused visual fixture E2E passed and desktop/mobile screenshots were viewed. `npm run check` passed (Vitest 262/262, database 25/25, operations 41/41, foundation/live, HR 45/45, production build). `npm run test:e2e` passed 9/9 after narrowing an ambiguous legacy test selector. Actual Supabase smoke test remains open. The actual project has **not** been migrated or cloud-verified here.
- Explicit exclusions: tax/BHXH, inferred commission, bank transfer API and statutory P&L. Existing global report is cash flow, so it is not represented as a complete salary-inclusive management P&L.
