// Disposable PGlite integration checks. No network, environment or customer data.
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const names = [
  '001_core','002_operations','003_sales_inventory','004_catalog_variants_aliases',
  '005_customer_order_foundation','006_inventory_reservations','007_live_intake',
  '008_live_tickets_print','009_live_operations','010_tiktok_channel_flow',
  '011_tiktok_live_end','012_live_runtime_telemetry','013_catalog_management',
  '014_expense_categories','015_document_corrections','016_bank_statement_import',
  '017_hr_core','018_hr_attendance_leave','019_hr_payroll',
];
const users = {
  owner: '11111111-1111-4111-8111-111111111111',
  manager: '22222222-2222-4222-8222-222222222222',
  staff: '33333333-3333-4333-8333-333333333333',
  other: '44444444-4444-4444-8444-444444444444',
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
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id ?? '']);
  await db.exec('set role authenticated');
}
async function rows(sql, params = []) {
  return (await db.query(sql, params)).rows;
}
async function rpc(name, args) {
  const entries = Object.entries(args);
  const result = await rows(`select public.${name}(${entries.map(([key], i) => `${key}=>$${i + 1}`).join(',')}) result`,
    entries.map(([, value]) => value !== null && typeof value === 'object' ? JSON.stringify(value) : value));
  return result[0].result;
}
async function count(table, where = 'true', params = []) {
  await db.exec('reset role');
  return Number((await rows(`select count(*) n from ${table} where ${where}`, params))[0].n);
}
async function expectError(fn, pattern) {
  await assert.rejects(fn, pattern);
}

try {
  await db.exec(`create role anon;create role authenticated;create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to authenticated,anon;grant execute on function auth.uid() to authenticated,anon;`);
  for (const [name, id] of Object.entries(users)) {
    await db.query('insert into auth.users values($1,$2,now())', [id, `${name}@payroll.example.test`]);
  }
  for (const name of names) {
    await db.exec(await readFile(new URL(`../supabase/migrations/${name}.sql`, import.meta.url), 'utf8'));
  }
  await check('001–019 migrations apply cleanly', async () => {
    assert.equal((await rows("select to_regclass('public.hr_payroll_lines') value"))[0].value, 'hr_payroll_lines');
  });

  await asUser(users.owner);
  const w = (await rpc('bootstrap_workspace', { p_name: 'Synthetic payroll workspace' })).id;
  const account = (await rows("select id,code,name from public.cash_accounts where workspace_id=$1 and code='CASH'", [w]))[0];
  await rpc('save_master', { p_kind: 'cash_accounts', p_payload: {
    workspace_id: w, ...account, opening_confirmed: true, opening_date: '2026-08-01', opening_balance: 0,
  }});
  await db.exec('reset role');
  await db.query('insert into public.workspace_members(workspace_id,user_id,role) values($1,$2,$3),($1,$4,$5)',
    [w, users.manager, 'manager', users.staff, 'staff']);
  await asUser(users.other);
  const otherW = (await rpc('bootstrap_workspace', { p_name: 'Other synthetic workspace' })).id;
  await asUser(users.owner);
  const monthly = await rpc('save_hr_employee', { p_workspace_id: w, p_payload: {
    code: 'M01', full_name: 'Monthly Synthetic', hire_date: '2026-01-01',
  }});
  const hourly = await rpc('save_hr_employee', { p_workspace_id: w, p_payload: {
    code: 'H01', full_name: 'Hourly Synthetic', hire_date: '2026-01-01', employee_type: 'part_time',
  }});
  const monthlyContract = await rpc('save_payroll_contract', { p_payload: {
    workspace_id: w, employee_id: monthly.id, effective_from: '2026-08-01',
    pay_basis: 'monthly', rate_vnd: 6000000, standard_day_minutes: 480,
    standard_month_minutes: 1200, overtime_multiplier: 2, paid_leave_types: ['annual'],
  }});
  await rpc('save_payroll_contract', { p_payload: {
    workspace_id: w, employee_id: hourly.id, effective_from: '2026-08-01',
    pay_basis: 'hourly', rate_vnd: 120000, standard_day_minutes: 480,
    overtime_multiplier: 1.5,
  }});
  const period = await rpc('save_payroll_period', { p_payload: {
    workspace_id: w, period_start: '2026-08-01', period_end: '2026-08-31',
    standard_minutes_override: 960, overtime_multiplier_override: 1.5,
  }});
  await check('staff retain the complete legacy report before HR cash is posted', async () => {
    await asUser(users.staff);
    const before = await rpc('get_workspace_report', { p_workspace_id: w,
      p_from: '2026-08-01', p_to: '2026-09-30' });
    assert.equal(before.cash_restricted, undefined);
    assert.equal(typeof before.overview.cash_out, 'string');
    await asUser(users.owner);
  });
  await check('advance cannot post without an effective contract for the selected period', async () => {
    const withoutContract = await rpc('save_hr_employee', { p_workspace_id: w, p_payload: {
      code: 'NO-CONTRACT', full_name: 'Uncontracted Synthetic', hire_date: '2026-01-01',
    }});
    await expectError(() => rpc('create_salary_advance', {
      p_workspace_id: w, p_employee_id: withoutContract.id, p_period_id: period.id,
      p_account_id: account.id, p_amount: 10000, p_transaction_date: '2026-08-15',
      p_request_id: randomUUID(),
    }), /HR_ADVANCE_CONTRACT/);
  });
  await check('contract and period require explicit time and overtime rules', async () => {
    assert.equal(monthlyContract.standard_month_minutes, 1200);
    await expectError(() => rpc('save_payroll_contract', { p_payload: {
      workspace_id: w, employee_id: monthly.id, effective_from: '2026-09-01',
      pay_basis: 'monthly', rate_vnd: 6000000, standard_day_minutes: 480,
      overtime_multiplier: 1.5,
    }}), /HR_CONTRACT_RULES/);
    await expectError(() => rpc('save_payroll_period', { p_payload: {
      workspace_id: w, period_start: '2026-08-15', period_end: '2026-09-15',
    }}), /HR_PERIOD_OVERLAP/);
  });

  const scheduleMonthly = await rpc('save_hr_work_schedule', { p_workspace_id: w, p_payload: {
    employee_id: monthly.id, work_date: '2026-08-10',
    planned_start_at: '2026-08-10T09:00:00Z', planned_end_at: '2026-08-10T17:00:00Z',
  }});
  const attendanceMonthly = await rpc('save_hr_attendance', { p_workspace_id: w, p_payload: {
    schedule_id: scheduleMonthly.id, clock_in_at: '2026-08-10T09:00:00Z',
    clock_out_at: '2026-08-10T18:00:00Z',
  }, p_request_id: randomUUID() });
  await rpc('confirm_hr_attendance', { p_workspace_id: w, p_id: attendanceMonthly.id, p_request_id: randomUUID() });
  const leave = await rpc('save_hr_leave_request', { p_workspace_id: w, p_payload: {
    employee_id: monthly.id, leave_type: 'annual', start_date: '2026-08-11', end_date: '2026-08-11',
    duration_unit: 'day', quantity: 1, reason: 'Synthetic paid leave',
  }, p_request_id: randomUUID() });
  await rpc('transition_hr_leave_request', { p_workspace_id: w, p_id: leave.id,
    p_target: 'pending', p_reason: '', p_request_id: randomUUID() });
  await rpc('transition_hr_leave_request', { p_workspace_id: w, p_id: leave.id,
    p_target: 'approved', p_reason: '', p_request_id: randomUUID() });
  const scheduleHourly = await rpc('save_hr_work_schedule', { p_workspace_id: w, p_payload: {
    employee_id: hourly.id, work_date: '2026-08-10',
    planned_start_at: '2026-08-10T09:00:00Z', planned_end_at: '2026-08-10T15:00:00Z',
  }});
  const attendanceHourly = await rpc('save_hr_attendance', { p_workspace_id: w, p_payload: {
    schedule_id: scheduleHourly.id, clock_in_at: '2026-08-10T09:00:00Z',
    clock_out_at: '2026-08-10T15:00:00Z',
  }, p_request_id: randomUUID() });
  await rpc('confirm_hr_attendance', { p_workspace_id: w, p_id: attendanceHourly.id, p_request_id: randomUUID() });

  const advanceRequest = randomUUID();
  const advance = await rpc('create_salary_advance', {
    p_workspace_id: w, p_employee_id: monthly.id, p_period_id: period.id,
    p_account_id: account.id, p_amount: 1000000, p_transaction_date: '2026-08-15',
    p_request_id: advanceRequest,
  });
  await check('salary advance posts once and targets selected period', async () => {
    const retry = await rpc('create_salary_advance', {
      p_workspace_id: w, p_employee_id: monthly.id, p_period_id: period.id,
      p_account_id: account.id, p_amount: 1000000, p_transaction_date: '2026-08-15',
      p_request_id: advanceRequest,
    });
    assert.equal(retry.id, advance.id);
    assert.equal(await count('public.cash_movements', 'workspace_id=$1 and cash_id=$2', [w, advance.cash_id]), 1);
    const [voucher] = await rows('select description from public.cash_transactions where workspace_id=$1 and id=$2', [w, advance.cash_id]);
    assert.match(voucher.description, /Ứng lương Monthly Synthetic/);
    await expectError(() => rpc('create_salary_advance', {
      p_workspace_id: w, p_employee_id: monthly.id, p_period_id: period.id,
      p_account_id: account.id, p_amount: 2000000, p_transaction_date: '2026-08-15',
      p_request_id: advanceRequest,
    }), /HR_REQUEST_REUSED/);
  });

  await check('future-dated advances cannot be marked as cash already paid', async () => {
    const dates = (await rows("select ((clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date+1)::text tomorrow, ((clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date+20)::text finish"))[0];
    const futurePeriod = await rpc('save_payroll_period', { p_payload: {
      workspace_id: w, period_start: dates.tomorrow, period_end: dates.finish,
    }});
    await expectError(() => rpc('create_salary_advance', {
      p_workspace_id: w, p_employee_id: monthly.id, p_period_id: futurePeriod.id,
      p_account_id: account.id, p_amount: 10000, p_transaction_date: dates.tomorrow,
      p_request_id: randomUUID(),
    }), /HR_ADVANCE_DATE/);
  });

  await check('an edited contract cannot strand an already posted advance at approval', async () => {
    await rpc('save_payroll_contract', { p_payload: {
      workspace_id: w, id: monthlyContract.id, effective_from: '2026-09-01',
    }});
    await expectError(() => rpc('calculate_payroll', { p_workspace_id: w, p_period_id: period.id }),
      /HR_ADVANCE_UNMATCHED/);
    await rpc('save_payroll_contract', { p_payload: {
      workspace_id: w, id: monthlyContract.id, effective_from: '2026-08-01',
    }});
  });

  await check('scheduled shifts without confirmed attendance block calculation', async () => {
    const missing = await rpc('save_hr_work_schedule', { p_workspace_id: w, p_payload: {
      employee_id: hourly.id, work_date: '2026-08-12',
      planned_start_at: '2026-08-12T09:00:00Z', planned_end_at: '2026-08-12T17:00:00Z',
    }});
    await expectError(() => rpc('calculate_payroll', { p_workspace_id: w, p_period_id: period.id }),
      /HR_ATTENDANCE_MISSING/);
    const absent = await rpc('save_hr_attendance', { p_workspace_id: w, p_payload: {
      schedule_id: missing.id, kind: 'absent',
    }, p_request_id: randomUUID() });
    await rpc('confirm_hr_attendance', { p_workspace_id: w, p_id: absent.id, p_request_id: randomUUID() });
  });

  const calculated = await rpc('calculate_payroll', { p_workspace_id: w, p_period_id: period.id });
  await check('monthly, hourly, paid leave, overtime and advance calculate in VND', async () => {
    assert.equal(calculated.status, 'CALCULATED');
    const lines = await rows('select * from public.hr_payroll_lines where workspace_id=$1 and period_id=$2 order by pay_basis', [w, period.id]);
    const hourLine = lines.find((line) => line.pay_basis === 'hourly');
    const monthLine = lines.find((line) => line.pay_basis === 'monthly');
    assert.equal(Number(monthLine.regular_minutes), 480);
    assert.equal(Number(monthLine.paid_leave_minutes), 480);
    assert.equal(Number(monthLine.overtime_minutes), 60);
    assert.equal(Number(monthLine.base_pay), 6000000);
    assert.equal(Number(monthLine.overtime_pay), 562500);
    assert.equal(Number(monthLine.advance_deduction), 1000000);
    assert.equal(Number(monthLine.net_pay), 5562500);
    assert.equal(Number(hourLine.base_pay), 720000);
    assert.equal(Number(hourLine.net_pay), 720000);
    assert.equal(Number(calculated.gross_total), 7282500);
    assert.equal(Number(calculated.net_total), 6282500);
  });
  await check('review and approval freeze one recognized gross expense per positive payslip', async () => {
    await rpc('review_payroll', { p_workspace_id: w, p_period_id: period.id });
    const request = randomUUID();
    const approved = await rpc('approve_payroll', { p_workspace_id: w, p_period_id: period.id, p_request_id: request });
    assert.equal(approved.status, 'APPROVED');
    await rpc('approve_payroll', { p_workspace_id: w, p_period_id: period.id, p_request_id: request });
    assert.equal(await count('public.hr_payroll_expenses', 'workspace_id=$1 and period_id=$2', [w, period.id]), 2);
    assert.equal(Number((await rows('select sum(amount) total from public.hr_payroll_expenses where workspace_id=$1 and period_id=$2', [w, period.id]))[0].total), 7282500);
    await expectError(() => rpc('calculate_payroll', { p_workspace_id: w, p_period_id: period.id }), /HR_PERIOD_LOCKED/);
    await expectError(() => rpc('create_salary_advance', { p_workspace_id: w, p_employee_id: monthly.id,
      p_period_id: period.id, p_account_id: account.id, p_amount: 1,
      p_transaction_date: '2026-08-16', p_request_id: randomUUID(),
    }), /HR_PERIOD_LOCKED/);
  });
  await check('owner/manager settlement posts cash once without recognizing another expense', async () => {
    const future = (await rows("select ((clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date+1)::text value"))[0].value;
    await expectError(() => rpc('pay_payroll', { p_workspace_id: w, p_period_id: period.id,
      p_account_id: account.id, p_payment_date: future, p_request_id: randomUUID() }), /HR_PAYMENT_DATE/);
    const request = randomUUID();
    const paid = await rpc('pay_payroll', { p_workspace_id: w, p_period_id: period.id,
      p_account_id: account.id, p_payment_date: '2026-09-01', p_request_id: request });
    assert.equal(paid.status, 'PAID');
    await rpc('pay_payroll', { p_workspace_id: w, p_period_id: period.id,
      p_account_id: account.id, p_payment_date: '2026-09-01', p_request_id: request });
    assert.equal(await count('public.cash_movements', "workspace_id=$1 and movement_kind='post'", [w]), 3);
    assert.equal(await count('public.hr_payroll_expenses', 'workspace_id=$1', [w]), 2);
    const paymentVouchers = await rows("select description from public.cash_transactions where workspace_id=$1 and category='payroll' order by description", [w]);
    assert.equal(paymentVouchers.length, 2);
    assert(paymentVouchers.some((voucher) => voucher.description.includes('Monthly Synthetic')));
    assert(paymentVouchers.some((voucher) => voucher.description.includes('Hourly Synthetic')));
    const classifications = await rows('select code,profit_eligible from public.cash_category_snapshots where workspace_id=$1 order by code,cash_id', [w]);
    assert.deepEqual(classifications.map((x) => [x.code,x.profit_eligible]),
      [['payroll',false],['payroll',false],['salary_advance',false]]);
    await expectError(() => rpc('reverse_document', { p_kind: 'cash', p_id: advance.cash_id,
      p_request_id: randomUUID(), p_date: '2026-09-02', p_reason: 'Synthetic reversal reason',
    }), /HR_CASH_LOCKED/);
  });
  await check('owner read model exposes frozen payslips and six-month expense chart', async () => {
    const state = await rpc('get_hr_payroll_state', { p_workspace_id: w, p_period_id: period.id });
    assert.equal(state.selected_period.status, 'PAID');
    assert.equal(state.lines.length, 2);
    assert.equal(state.expenses.length, 2);
    assert.equal(state.payments.length, 2);
    assert.equal(state.advances.length, 1);
    assert.equal(state.recognized_months.length, 6);
    const frozen = state.lines.find((line) => line.employee_id === monthly.id).source_snapshot.employee;
    assert.equal(frozen.full_name, 'Monthly Synthetic');
    await rpc('save_hr_employee', { p_workspace_id: w, p_payload: {
      id: monthly.id, full_name: 'Monthly Renamed',
    }});
    const reread = await rpc('get_hr_payroll_state', { p_workspace_id: w, p_period_id: period.id });
    assert.equal(reread.lines.find((line) => line.employee_id === monthly.id).source_snapshot.employee.full_name,
      'Monthly Synthetic');
  });
  await asUser(users.staff);
  await check('staff cannot read salary tables or linked cash/audit rows', async () => {
    for (const table of ['hr_payroll_contracts','hr_payroll_periods','hr_payroll_lines','hr_payroll_expenses','hr_salary_advances','hr_payroll_audit']) {
      assert.equal((await rows(`select count(*) n from public.${table} where workspace_id=$1`, [w]))[0].n, 0);
    }
    assert.equal((await rows('select count(*) n from public.cash_transactions where workspace_id=$1', [w]))[0].n, 0);
    assert.equal((await rows('select count(*) n from public.cash_movements where workspace_id=$1', [w]))[0].n, 0);
    assert.equal((await rows("select count(*) n from public.audit_events where workspace_id=$1 and action='cash.posted'", [w]))[0].n, 0);
    assert.equal((await rows("select count(*) n from public.audit_events where workspace_id=$1 and action like 'hr.%'", [w]))[0].n, 0);
    await expectError(() => rpc('get_hr_payroll_state', { p_workspace_id: w, p_period_id: period.id }), /permission|quyền|role/i);
    await expectError(() => rpc('pay_payroll', { p_workspace_id: w, p_period_id: period.id,
      p_account_id: account.id, p_payment_date: '2026-09-01', p_request_id: randomUUID(),
    }), /permission|quyền|role/i);
  });
  await check('staff retain stock report without payroll cash details', async () => {
    await expectError(() => rpc('get_workspace_report_v2_internal', { p_workspace_id: w,
      p_from: '2026-08-01', p_to: '2026-09-30' }), /permission denied/i);
    const restricted = await rpc('get_workspace_report', { p_workspace_id: w,
      p_from: '2026-08-01', p_to: '2026-09-30' });
    assert.equal(restricted.cash_restricted, true);
    assert.equal(restricted.overview.cash_out, undefined);
    assert.equal(restricted.cash_categories.length, 0);
    assert.equal(typeof restricted.overview.stock_qty_as_of, 'string');
  });

  await asUser(users.other);
  await check('cross-workspace contract and period mutations are denied', async () => {
    assert.notEqual(otherW,w);
    await expectError(() => rpc('get_hr_payroll_state', { p_workspace_id: w, p_period_id: period.id }), /permission|quyền|role/i);
    await expectError(() => rpc('calculate_payroll', { p_workspace_id: w, p_period_id: period.id }), /permission|quyền|role/i);
  });
  await asUser(users.manager);
  await check('manager can read posted payroll snapshot', async () => {
    const state = await rpc('get_hr_payroll_state', { p_workspace_id: w, p_period_id: period.id });
    assert.equal(state.selected_period.status, 'PAID');
    const report = await rpc('get_workspace_report', { p_workspace_id: w,
      p_from: '2026-08-01', p_to: '2026-09-30' });
    assert.equal(report.cash_restricted, undefined);
    assert.ok(Number(report.overview.cash_out) > 0);
  });
  console.log(`Payroll PGlite checks passed: ${passed}`);
} finally {
  await db.close();
}
