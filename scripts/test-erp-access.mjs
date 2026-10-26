// Disposable PGlite access checks; no production data or remote database.
import { PGlite } from '@electric-sql/pglite';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const db = new PGlite();
const users = Object.fromEntries(
  ['owner', 'staff', 'employee', 'newHire', 'outsider'].map((name) => [name, randomUUID()]),
);
let actor = null;
async function rows(sql, values = []) {
  return (await db.query(sql, values)).rows;
}
async function asUser(id) {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
  await db.exec('set role authenticated');
  actor = id;
}
async function admin(sql, values = []) {
  const resume = actor;
  await db.exec('reset role');
  try {
    return (await db.query(sql, values)).rows;
  } finally {
    if (resume) await asUser(resume);
  }
}
async function rpc(name, args) {
  const entries = Object.entries(args);
  const result = await rows(
    `select public.${name}(${entries.map(([key], i) => `${key}=>$${i + 1}`).join(',')}) result`,
    entries.map(([, value]) =>
      value !== null && typeof value === 'object' ? JSON.stringify(value) : value,
    ),
  );
  return result[0].result;
}

try {
  await db.exec(`create role anon;create role authenticated;create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
    $$;
    grant usage on schema auth to authenticated,anon;
    grant execute on function auth.uid() to authenticated,anon;`);
  for (const [name, id] of Object.entries(users))
    await db.query('insert into auth.users values($1,$2,now())', [
      id,
      `${name}@access.example.test`,
    ]);
  const names = (await readdir(new URL('../supabase/migrations/', import.meta.url)))
    .filter((name) => /^\d{3}_.*\.sql$/.test(name) && Number(name.slice(0, 3)) <= 26)
    .sort();
  for (const name of names) {
    try {
      await db.exec(
        await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'),
      );
    } catch (error) {
      throw new Error(`Migration ${name}: ${error.message}`, { cause: error });
    }
  }
  console.log('PASS migrations through 026');
  await asUser(users.owner);
  const workspace = (await rpc('bootstrap_workspace', { p_name: 'Access test workspace' })).id;
  await admin('insert into public.products(workspace_id,code,name) values($1,$2,$3)', [
    workspace,
    'PRIVATE-1',
    'Synthetic private product',
  ]);
  await admin(
    'insert into public.workspace_members(workspace_id,user_id,role) values($1,$2,$3),($1,$4,$5)',
    [workspace, users.staff, 'staff', users.employee, 'employee'],
  );
  const added = await rpc('add_workspace_member', {
    p_workspace_id: workspace,
    p_email: 'newHire@access.example.test',
    p_role: 'employee',
  });
  assert.equal(added.role, 'employee');
  const employee = await rpc('save_hr_employee', {
    p_workspace_id: workspace,
    p_payload: {
      code: 'SELF-1',
      full_name: 'Synthetic Employee',
      employee_type: 'part_time',
      auth_user_id: users.employee,
      hire_date: '2026-01-01',
    },
  });
  const otherEmployee = await rpc('save_hr_employee', {
    p_workspace_id: workspace,
    p_payload: {
      code: 'SELF-2',
      full_name: 'Synthetic Other Employee',
      auth_user_id: users.staff,
      hire_date: '2026-01-01',
    },
  });
  await rpc('save_hr_work_schedule', {
    p_workspace_id: workspace,
    p_payload: {
      employee_id: employee.id,
      work_date: '2026-10-02',
      planned_start_at: '2026-10-02T06:00:00Z',
      planned_end_at: '2026-10-02T10:00:00Z',
      break_minutes: 0,
    },
  });
  await rpc('save_hr_work_schedule', {
    p_workspace_id: workspace,
    p_payload: {
      employee_id: otherEmployee.id,
      work_date: '2026-10-03',
      planned_start_at: '2026-10-03T06:00:00Z',
      planned_end_at: '2026-10-03T10:00:00Z',
      break_minutes: 0,
    },
  });
  const contract = await rpc('save_payroll_contract', {
    p_payload: {
      workspace_id: workspace,
      employee_id: employee.id,
      effective_from: '2026-10-01',
      pay_basis: 'hourly',
      rate_vnd: 100000,
      standard_day_minutes: 240,
      overtime_multiplier: 1.5,
    },
  });
  const otherContract = await rpc('save_payroll_contract', {
    p_payload: {
      workspace_id: workspace,
      employee_id: otherEmployee.id,
      effective_from: '2026-10-01',
      pay_basis: 'hourly',
      rate_vnd: 200000,
      standard_day_minutes: 480,
      overtime_multiplier: 1.5,
    },
  });
  const period = await rpc('save_payroll_period', {
    p_payload: {
      workspace_id: workspace,
      period_start: '2026-10-01',
      period_end: '2026-10-31',
    },
  });
  for (const [entry, payContract, pay] of [
    [employee, contract, 400000],
    [otherEmployee, otherContract, 800000],
  ])
    await admin(
      `insert into public.hr_payroll_lines(workspace_id,period_id,employee_id,contract_id,
      pay_basis,rate_vnd,overtime_multiplier,regular_minutes,paid_leave_minutes,overtime_minutes,
      base_pay,overtime_pay,gross_pay,advance_deduction,net_pay,source_snapshot)
      values($1,$2,$3,$4,'hourly',$5,1.5,240,0,0,$6,0,$6,0,$6,'{}'::jsonb)`,
      [workspace, period.id, entry.id, payContract.id, payContract.rate_vnd, pay],
    );
  await admin(
    "update public.hr_payroll_periods set status='APPROVED',approved_at=now(),approved_by=$2 where id=$1",
    [period.id, users.owner],
  );
  const draftPeriod = await rpc('save_payroll_period', {
    p_payload: {
      workspace_id: workspace,
      period_start: '2026-11-01',
      period_end: '2026-11-30',
    },
  });
  await admin(
    `insert into public.hr_payroll_lines(workspace_id,period_id,employee_id,contract_id,
    pay_basis,rate_vnd,overtime_multiplier,regular_minutes,paid_leave_minutes,overtime_minutes,
    base_pay,overtime_pay,gross_pay,advance_deduction,net_pay,source_snapshot)
    values($1,$2,$3,$4,'hourly',100000,1.5,240,0,0,400000,0,400000,0,400000,'{}'::jsonb)`,
    [workspace, draftPeriod.id, employee.id, contract.id],
  );
  await asUser(users.employee);
  assert.equal(
    (await rows('select role from public.workspace_members where workspace_id=$1', [workspace]))[0]
      .role,
    'employee',
  );
  assert.equal(
    (await rows('select count(*)::int n from public.workspaces where id=$1', [workspace]))[0].n,
    1,
  );
  assert.equal(
    (
      await rows('select count(*)::int n from public.products where workspace_id=$1', [workspace])
    )[0].n,
    0,
  );
  assert.equal(
    (
      await rows('select count(*)::int n from public.cash_accounts where workspace_id=$1', [
        workspace,
      ])
    )[0].n,
    0,
  );
  assert.equal(
    (
      await rows('select count(*)::int n from public.audit_events where workspace_id=$1', [
        workspace,
      ])
    )[0].n,
    0,
  );
  await assert.rejects(() =>
    rpc('create_cash', {
      p_payload: {
        workspace_id: workspace,
        direction: 'out',
        amount: '1000',
        transaction_date: '2026-10-02',
        description: 'Forbidden employee draft',
      },
    }),
  );
  await assert.rejects(() => rpc('get_sales_state', { p_workspace_id: workspace }));
  await assert.rejects(() =>
    rpc('get_workspace_report', {
      p_workspace_id: workspace,
      p_from: '2026-10-01',
      p_to: '2026-10-31',
    }),
  );
  await assert.rejects(
    () => rpc('get_my_hr_attendance', { p_workspace_id: randomUUID(), p_month: '2026-10-01' }),
    /HR_SELF_FORBIDDEN/,
  );
  const payslips = await rpc('get_my_hr_payslips', { p_workspace_id: workspace });
  assert.equal(payslips.items.length, 1);
  assert.equal(payslips.items[0].net_pay, '400000');
  assert.equal(payslips.items[0].source_snapshot, undefined);
  assert.equal(
    (
      await rows('select count(*)::int n from public.hr_payroll_lines where workspace_id=$1', [
        workspace,
      ])
    )[0].n,
    0,
  );
  const attendance = await rpc('get_my_hr_attendance', {
    p_workspace_id: workspace,
    p_month: '2026-10-01',
  });
  assert.equal(attendance.items.length, 1);
  assert.equal(attendance.items[0].work_date, '2026-10-02');
  const rejectedScan = await rpc('scan_hr_qr', {
    p_workspace_id: workspace,
    p_token: randomUUID(),
    p_action: 'check_in',
    p_request_id: randomUUID(),
  });
  assert.equal(rejectedScan.error, 'HR_QR_CHALLENGE_EXPIRED');
  await asUser(users.newHire);
  await assert.rejects(
    () => rpc('get_my_hr_payslips', { p_workspace_id: workspace }),
    /HR_QR_EMPLOYEE/,
  );
  await asUser(users.outsider);
  assert.equal(
    (await rows('select count(*)::int n from public.workspaces where id=$1', [workspace]))[0].n,
    0,
  );
  await assert.rejects(
    () => rpc('get_my_hr_payslips', { p_workspace_id: workspace }),
    /HR_SELF_FORBIDDEN/,
  );
  console.log('PASS employee workspace metadata, ERP isolation, self-service, outsider denial');
} finally {
  await db.close();
}
