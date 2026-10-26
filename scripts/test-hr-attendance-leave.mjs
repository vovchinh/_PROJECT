// Disposable local PGlite checks. No cloud connection or customer data.
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const migrationNames = [
  '001_core',
  '002_operations',
  '003_sales_inventory',
  '004_catalog_variants_aliases',
  '005_customer_order_foundation',
  '006_inventory_reservations',
  '007_live_intake',
  '008_live_tickets_print',
  '009_live_operations',
  '010_tiktok_channel_flow',
  '011_tiktok_live_end',
  '012_live_runtime_telemetry',
  '013_catalog_management',
  '014_expense_categories',
  '015_document_corrections',
  '016_bank_statement_import',
  '017_hr_core',
  '018_hr_attendance_leave',
];
const users = {
  owner: '11111111-1111-4111-8111-111111111111',
  other: '22222222-2222-4222-8222-222222222222',
  manager: '33333333-3333-4333-8333-333333333333',
  staff: '44444444-4444-4444-8444-444444444444',
};
const db = new PGlite();
let passed = 0;
async function check(label, fn) {
  await fn();
  passed++;
  console.log('PASS', label);
}
async function asUser(id) {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id || '']);
  await db.exec('set role authenticated');
}
async function rpc(name, args) {
  const entries = Object.entries(args);
  const { rows } = await db.query(
    `select public.${name}(${entries.map(([key], i) => `${key}=>$${i + 1}`).join(',')}) result`,
    entries.map(([, value]) =>
      value !== null && typeof value === 'object' ? JSON.stringify(value) : value,
    ),
  );
  return rows[0].result;
}
const save = (name, w, payload, requestId = randomUUID()) =>
  rpc(name, {
    p_workspace_id: w,
    p_payload: payload,
    ...(name === 'save_hr_work_schedule' ? {} : { p_request_id: requestId }),
  });
const transition = (w, id, target, reason = '', requestId = randomUUID()) =>
  rpc('transition_hr_leave_request', {
    p_workspace_id: w,
    p_id: id,
    p_target: target,
    p_reason: reason,
    p_request_id: requestId,
  });
const listAttendance = (w, args = {}) =>
  rpc('list_hr_attendance', {
    p_workspace_id: w,
    p_month: '2026-10-01',
    p_employee_id: args.employeeId ?? null,
    p_department_id: args.departmentId ?? null,
    p_status: args.status ?? null,
    p_page: args.page ?? 1,
    p_page_size: args.pageSize ?? 25,
  });
const listLeave = (w, args = {}) =>
  rpc('list_hr_leave_requests', {
    p_workspace_id: w,
    p_status: args.status ?? null,
    p_employee_id: args.employeeId ?? null,
    p_page: args.page ?? 1,
    p_page_size: args.pageSize ?? 25,
  });

try {
  await db.exec(`create role anon;create role authenticated;create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
    $$;
    grant usage on schema auth to authenticated,anon;
    grant execute on function auth.uid() to authenticated,anon;`);
  for (const [name, id] of Object.entries(users)) {
    await db.query('insert into auth.users values($1,$2,now())', [
      id,
      `${name}@hr-attendance.example.test`,
    ]);
  }
  for (const name of migrationNames) {
    await db.exec(
      await readFile(new URL(`../supabase/migrations/${name}.sql`, import.meta.url), 'utf8'),
    );
  }
  await check('clean 001--018 migrations create HR attendance and leave schema', async () => {
    const { rows } = await db.query(
      "select to_regclass('public.hr_attendance') a,to_regclass('public.hr_leave_requests') l",
    );
    assert.equal(rows[0].a, 'hr_attendance');
    assert.equal(rows[0].l, 'hr_leave_requests');
  });

  await asUser(users.owner);
  const w = (await rpc('bootstrap_workspace', { p_name: 'Synthetic Attendance A' })).id;
  await asUser(users.other);
  const otherW = (await rpc('bootstrap_workspace', { p_name: 'Synthetic Attendance B' })).id;
  await asUser(users.owner);
  await rpc('add_workspace_member', {
    p_workspace_id: w,
    p_email: 'manager@hr-attendance.example.test',
    p_role: 'manager',
  });
  await rpc('add_workspace_member', {
    p_workspace_id: w,
    p_email: 'staff@hr-attendance.example.test',
    p_role: 'staff',
  });
  const d = await rpc('save_hr_department', {
    p_workspace_id: w,
    p_payload: { code: 'OPS', name: 'Operations' },
  });
  const e = await rpc('save_hr_employee', {
    p_workspace_id: w,
    p_payload: {
      code: 'NV001',
      full_name: 'Synthetic Employee',
      department_id: d.id,
      hire_date: '2026-01-01',
    },
  });
  const shift = await save('save_hr_work_schedule', w, {
    employee_id: e.id,
    work_date: '2026-10-01',
    planned_start_at: '2026-10-01T22:00:00+07:00',
    planned_end_at: '2026-10-02T06:00:00+07:00',
    break_minutes: 30,
    late_grace_minutes: 5,
    early_grace_minutes: 5,
    shift_name: 'Night',
  });
  await check('overnight assignment stores actual instants and planned minutes', async () => {
    assert.equal(shift.planned_minutes, 450);
    assert.equal(
      (
        await rpc('list_hr_work_schedules', {
          p_workspace_id: w,
          p_month: '2026-10-01',
          p_employee_id: null,
          p_page: 1,
          p_page_size: 25,
        })
      ).total,
      1,
    );
    await assert.rejects(
      () =>
        save('save_hr_work_schedule', w, {
          employee_id: e.id,
          work_date: '2026-10-01',
          planned_start_at: '2026-10-01T22:00:00+07:00',
          planned_end_at: '2026-10-02T06:00:00+07:00',
        }),
      /duplicate key/,
    );
  });

  const missing = await save('save_hr_attendance', w, {
    schedule_id: shift.id,
    clock_in_at: '2026-10-01T22:10:00+07:00',
    clock_out_at: null,
    kind: 'work',
  });
  await check('missing check-out remains distinct incomplete draft', async () => {
    assert.equal(missing.work_minutes, null);
    assert.equal(missing.break_minutes, 30);
    assert.equal(missing.late_minutes, 5);
    assert.equal((await listAttendance(w, { status: 'incomplete' })).total, 1);
    const summary = await rpc('get_hr_attendance_summary', {
      p_workspace_id: w,
      p_date: '2026-10-01',
    });
    assert.equal(summary.present_count, 0);
    assert.equal(summary.absent_count, 0);
    assert.equal(summary.incomplete_count, 1);
    assert.equal(summary.unrecorded_count, 0);
    await assert.rejects(
      () =>
        rpc('confirm_hr_attendance', {
          p_workspace_id: w,
          p_id: missing.id,
          p_request_id: randomUUID(),
        }),
      /HR_ATTENDANCE_INCOMPLETE/,
    );
  });
  const complete = await save('save_hr_attendance', w, {
    id: missing.id,
    schedule_id: shift.id,
    kind: 'work',
    clock_in_at: '2026-10-01T22:10:00+07:00',
    clock_out_at: '2026-10-02T06:30:00+07:00',
    break_minutes: 30,
  });
  await check('night shift facts: work, late, overtime stay separate', async () => {
    assert.equal(complete.work_minutes, 470);
    assert.equal(complete.late_minutes, 5);
    assert.equal(complete.early_leave_minutes, 0);
    assert.equal(complete.overtime_minutes, 30);
    assert.equal((await listAttendance(w, { departmentId: d.id, status: 'overtime' })).total, 1);
    assert.equal((await listAttendance(w, { pageSize: 1 })).items.length, 1);
  });
  const confirmRequest = randomUUID();
  await rpc('confirm_hr_attendance', {
    p_workspace_id: w,
    p_id: missing.id,
    p_request_id: confirmRequest,
  });
  await check(
    'confirmed attendance is locked and confirmation retries are idempotent',
    async () => {
      const retry = await rpc('confirm_hr_attendance', {
        p_workspace_id: w,
        p_id: missing.id,
        p_request_id: confirmRequest,
      });
      assert.equal(retry.status, 'confirmed');
      const summary = await rpc('get_hr_attendance_summary', {
        p_workspace_id: w,
        p_date: '2026-10-01',
      });
      assert.equal(summary.present_count, 1);
      assert.equal(summary.absent_count, 0);
      await assert.rejects(
        () =>
          save('save_hr_attendance', w, {
            id: missing.id,
            schedule_id: shift.id,
            kind: 'work',
            clock_in_at: '2026-10-01T22:00:00+07:00',
            clock_out_at: '2026-10-02T06:00:00+07:00',
          }),
        /HR_ATTENDANCE_LOCKED/,
      );
      await assert.rejects(
        () =>
          save('save_hr_work_schedule', w, {
            id: shift.id,
            employee_id: e.id,
            work_date: '2026-10-01',
            planned_start_at: '2026-10-01T22:00:00+07:00',
            planned_end_at: '2026-10-02T06:00:00+07:00',
          }),
        /HR_SCHEDULE_IN_USE/,
      );
    },
  );
  const adjustmentRequest = randomUUID();
  const adjusted = await rpc('adjust_hr_attendance', {
    p_workspace_id: w,
    p_id: missing.id,
    p_payload: { clock_out_at: '2026-10-02T05:30:00+07:00' },
    p_reason: 'Verified correct clock-out from device log',
    p_request_id: adjustmentRequest,
  });
  await check(
    'confirmed adjustment updates early departure with private immutable audit',
    async () => {
      assert.equal(adjusted.early_leave_minutes, 25);
      assert.equal(adjusted.overtime_minutes, 0);
      assert.equal(adjusted.work_minutes, 410);
      const retry = await rpc('adjust_hr_attendance', {
        p_workspace_id: w,
        p_id: missing.id,
        p_payload: { clock_out_at: '2026-10-02T05:30:00+07:00' },
        p_reason: 'Verified correct clock-out from device log',
        p_request_id: adjustmentRequest,
      });
      assert.equal(retry.work_minutes, 410);
      await assert.rejects(
        () =>
          rpc('adjust_hr_attendance', {
            p_workspace_id: w,
            p_id: missing.id,
            p_payload: { clock_out_at: '2026-10-02T05:00:00+07:00' },
            p_reason: 'Verified correct clock-out from device log',
            p_request_id: adjustmentRequest,
          }),
        /HR_IDEMPOTENCY/,
      );
      await db.exec('reset role');
      const { rows } = await db.query(
        'select before_snapshot,after_snapshot,reason from public.hr_attendance_adjustments where attendance_id=$1',
        [missing.id],
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0].before_snapshot.overtime_minutes, 30);
      assert.equal(rows[0].after_snapshot.early_leave_minutes, 25);
      await assert.rejects(
        () =>
          db.query('update public.hr_attendance_adjustments set reason=$1 where attendance_id=$2', [
            'Altered reason',
            missing.id,
          ]),
        /HR_HISTORY_IMMUTABLE/,
      );
      await asUser(users.owner);
    },
  );

  const leavePayload = {
    employee_id: e.id,
    leave_type: 'annual',
    start_date: '2026-10-03',
    end_date: '2026-10-04',
    duration_unit: 'day',
    quantity: 2,
    reason: 'Personal leave',
  };
  const leaveRequest = randomUUID();
  const leave = await save('save_hr_leave_request', w, leavePayload, leaveRequest);
  await check('leave create is idempotent and overlap is rejected', async () => {
    assert.equal((await save('save_hr_leave_request', w, leavePayload, leaveRequest)).id, leave.id);
    await assert.rejects(
      () =>
        save('save_hr_leave_request', w, {
          ...leavePayload,
          start_date: '2026-10-04',
          end_date: '2026-10-05',
        }),
      /HR_LEAVE_OVERLAP/,
    );
    await assert.rejects(
      () =>
        save('save_hr_leave_request', w, {
          ...leavePayload,
          start_date: '2026-10-05',
          end_date: '2026-10-04',
        }),
      /check constraint/,
    );
  });
  await check(
    'DRAFT -> PENDING -> APPROVED, invalid transitions and approved edit denied',
    async () => {
      assert.equal((await transition(w, leave.id, 'pending')).status, 'pending');
      const request = randomUUID();
      assert.equal((await transition(w, leave.id, 'approved', '', request)).status, 'approved');
      assert.equal((await transition(w, leave.id, 'approved', '', request)).status, 'approved');
      await assert.rejects(
        () => transition(w, leave.id, 'rejected', 'Rejected after approval'),
        /HR_LEAVE_TRANSITION/,
      );
      await assert.rejects(
        () => save('save_hr_leave_request', w, { ...leavePayload, id: leave.id }),
        /HR_LEAVE_LOCKED/,
      );
      assert.equal((await listLeave(w, { status: 'approved' })).total, 1);
    },
  );
  const hourly = await save('save_hr_leave_request', w, {
    employee_id: e.id,
    leave_type: 'sick',
    start_date: '2026-10-05',
    end_date: '2026-10-05',
    duration_unit: 'hour',
    start_time: '08:00',
    end_time: '10:00',
    quantity: 2,
    reason: 'Medical appointment',
  });
  await check(
    'hourly leave checks time overlap and cancelled requests free the interval',
    async () => {
      await assert.rejects(
        () =>
          save('save_hr_leave_request', w, {
            employee_id: e.id,
            leave_type: 'other',
            start_date: '2026-10-05',
            end_date: '2026-10-05',
            duration_unit: 'hour',
            start_time: '09:00',
            end_time: '11:00',
            quantity: 2,
          }),
        /HR_LEAVE_OVERLAP/,
      );
      const adjacent = await save('save_hr_leave_request', w, {
        employee_id: e.id,
        leave_type: 'other',
        start_date: '2026-10-05',
        end_date: '2026-10-05',
        duration_unit: 'hour',
        start_time: '10:00',
        end_time: '11:00',
        quantity: 1,
      });
      assert.equal(adjacent.status, 'draft');
      assert.equal(
        (await transition(w, hourly.id, 'cancelled', 'Appointment cancelled')).status,
        'cancelled',
      );
      const replacement = await save('save_hr_leave_request', w, {
        employee_id: e.id,
        leave_type: 'sick',
        start_date: '2026-10-05',
        end_date: '2026-10-05',
        duration_unit: 'hour',
        start_time: '08:00',
        end_time: '10:00',
        quantity: 2,
      });
      assert.ok(replacement.id);
      await assert.rejects(() => transition(w, adjacent.id, 'approved'), /HR_LEAVE_TRANSITION/);
    },
  );

  await check('pending leave can be rejected or cancelled with a recorded reason', async () => {
    const rejected = await save('save_hr_leave_request', w, {
      employee_id: e.id,
      leave_type: 'other',
      start_date: '2026-10-06',
      end_date: '2026-10-06',
      duration_unit: 'day',
      quantity: 1,
    });
    await transition(w, rejected.id, 'pending');
    assert.equal(
      (await transition(w, rejected.id, 'rejected', 'Not enough staffing')).status,
      'rejected',
    );
    const cancelled = await save('save_hr_leave_request', w, {
      employee_id: e.id,
      leave_type: 'other',
      start_date: '2026-10-07',
      end_date: '2026-10-07',
      duration_unit: 'day',
      quantity: 1,
    });
    await transition(w, cancelled.id, 'pending');
    assert.equal(
      (await transition(w, cancelled.id, 'cancelled', 'Employee withdrew request')).status,
      'cancelled',
    );
    assert.equal((await listLeave(w, { status: 'rejected' })).total, 1);
  });

  await check('dashboard distinguishes unrecorded shifts from confirmed absence', async () => {
    const dayShift = await save('save_hr_work_schedule', w, {
      employee_id: e.id,
      work_date: '2026-10-02',
      planned_start_at: '2026-10-02T08:00:00+07:00',
      planned_end_at: '2026-10-02T17:00:00+07:00',
      break_minutes: 60,
    });
    const before = await rpc('get_hr_attendance_summary', {
      p_workspace_id: w,
      p_date: '2026-10-02',
    });
    assert.equal(before.unrecorded_count, 1);
    assert.equal(before.absent_count, 0);
    const absent = await save('save_hr_attendance', w, {
      schedule_id: dayShift.id,
      kind: 'absent',
    });
    await rpc('confirm_hr_attendance', {
      p_workspace_id: w,
      p_id: absent.id,
      p_request_id: randomUUID(),
    });
    const after = await rpc('get_hr_attendance_summary', {
      p_workspace_id: w,
      p_date: '2026-10-02',
    });
    assert.equal(after.unrecorded_count, 0);
    assert.equal(after.absent_count, 1);
    assert.equal(after.present_count, 0);
    assert.equal(absent.break_minutes, 0);
  });

  await check('RLS, RPC permissions, workspace FK and direct write denial', async () => {
    await asUser(users.manager);
    assert.equal((await listAttendance(w)).total, 2);
    assert.equal((await listLeave(w)).total, 6);
    await asUser(users.staff);
    assert.equal((await db.query('select count(*)::int n from public.hr_attendance')).rows[0].n, 0);
    assert.equal(
      (await db.query('select count(*)::int n from public.hr_leave_requests')).rows[0].n,
      0,
    );
    await assert.rejects(() => listAttendance(w), /permission|quy/i);
    await assert.rejects(() => save('save_hr_leave_request', w, leavePayload), /permission|quy/i);
    await assert.rejects(
      () =>
        db.query(
          'insert into public.hr_leave_requests(workspace_id,employee_id,leave_type,start_date,end_date,duration_unit,quantity,created_request_id,create_hash,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [
            w,
            e.id,
            'annual',
            '2026-10-10',
            '2026-10-10',
            'day',
            1,
            randomUUID(),
            'hash',
            users.staff,
          ],
        ),
      /permission denied/i,
    );
    await asUser(users.other);
    assert.equal((await db.query('select count(*)::int n from public.hr_attendance')).rows[0].n, 0);
    await assert.rejects(() => listLeave(w), /permission|quy/i);
    await assert.rejects(
      () =>
        save('save_hr_work_schedule', otherW, {
          employee_id: e.id,
          work_date: '2026-10-07',
          planned_start_at: '2026-10-07T08:00:00+07:00',
          planned_end_at: '2026-10-07T17:00:00+07:00',
        }),
      /HR_EMPLOYEE/,
    );
    await asUser(users.owner);
    await assert.rejects(() => listLeave(w, { pageSize: 101 }), /HR_PAGE/);
  });
  console.log(`HR attendance and leave database: ${passed} checks passed.`);
} finally {
  await db.close();
}
