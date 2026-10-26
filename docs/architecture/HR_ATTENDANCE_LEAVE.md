# HR attendance and leave (migration 018)

Migration 018 adds daily shift assignments, attendance facts, leave requests and private histories. It depends on the employee and department records in migration 017. Apply it only after 001–017 have been applied and verified. It does not modify the cash ledger or calculate payroll.

## Attendance

Each `hr_work_schedules` row assigns one employee to one work date. `planned_start_at` and `planned_end_at` are absolute timestamps, so a shift may cross midnight. `planned_minutes` deducts the configured break. Saving attendance requires the matching schedule. Work attendance defaults to the scheduled break unless the manager supplies the actual break. The database calculates `work_minutes`, `late_minutes`, `early_leave_minutes` and `overtime_minutes` separately. Missing clocks stay visible in a draft with `work_minutes = null`; a work record cannot be confirmed until both clocks are present. Confirmed records can change only through `adjust_hr_attendance`, which requires a reason and records before and after snapshots. Schedule changes are blocked after any attendance exists for that schedule.

Attendance RPCs: `save_hr_work_schedule`, `list_hr_work_schedules`, `save_hr_attendance`, `confirm_hr_attendance`, `adjust_hr_attendance`, `list_hr_attendance`, and `get_hr_attendance_summary`. List RPCs return `{items,total,page,page_size}` with a maximum page size of 100. The summary counts confirmed presence and confirmed absence. It reports incomplete, unconfirmed and unrecorded schedules separately; an unrecorded schedule is not assumed to mean absence.

## Leave

`hr_leave_requests` supports day and hour quantities, the types annual/sick/unpaid/other, and the workflow draft → pending → approved/rejected/cancelled. Drafts can also be cancelled. Only drafts may be edited. Active requests for the same employee cannot overlap; hourly requests on the same date may be adjacent. A cancellation needs a reason. `hr_leave_transitions` records every transition. Leave attendance requires an approved request for the work date.

Leave RPCs: `save_hr_leave_request`, `transition_hr_leave_request`, and `list_hr_leave_requests`. These do not deduct salary or leave balances. Day quantities are entered by a manager and checked against the inclusive calendar span. Paid leave, holidays, weekends and hourly pay effects need an explicit payroll policy.

## Security and deployment

All five new tables use composite workspace foreign keys, row level security and manager/owner read policies. Authenticated users have no table write grants. RPCs enforce owner/manager roles; mutation RPCs also hold a shared workspace lock while checking roles to prevent a role change racing a write. General ERP audit entries contain no employee names, clock times or leave reasons. Attendance adjustment snapshots and leave transition reasons stay in manager-only tables. Creation and transitions use request IDs to guard retries.

Run `node scripts/test-hr-attendance-leave.mjs` against the disposable local PGlite database before deployment. Deploying to a real Supabase project requires normal migration review and explicit release action. A rollback must first stop clients using these RPCs, export any records created after deployment, then use a reviewed compensating migration; dropping tables would lose attendance and leave history.
