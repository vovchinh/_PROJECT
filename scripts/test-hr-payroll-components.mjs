// Disposable local PGlite checks for migration 020. No customer data or network.
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
  '017_hr_core','018_hr_attendance_leave','019_hr_payroll','020_hr_payroll_components',
];
const owner = randomUUID(), staff = randomUUID();
const db = new PGlite();
let passed = 0;
async function check(label, fn) { await fn();passed++;console.log('PASS', label); }
async function rows(sql, params = []) { return (await db.query(sql, params)).rows; }
async function user(id) {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
  await db.exec('set role authenticated');
}
async function rpc(name, args) {
  const entries = Object.entries(args);
  const result = await rows(`select public.${name}(${entries.map(([key], i) => `${key}=>$${i + 1}`).join(',')}) result`,
    entries.map(([, value]) => value !== null && typeof value === 'object' ? JSON.stringify(value) : value));
  return result[0].result;
}
async function error(fn, pattern) { await assert.rejects(fn, pattern); }

try {
  await db.exec(`create role anon;create role authenticated;create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to authenticated,anon;grant execute on function auth.uid() to authenticated,anon;`);
  await db.query('insert into auth.users values($1,$2,now()),($3,$4,now())',
    [owner,'owner@hr-component.example.test',staff,'staff@hr-component.example.test']);
  for (const name of names)
    await db.exec(await readFile(new URL(`../supabase/migrations/${name}.sql`, import.meta.url), 'utf8'));
  await check('001–020 migrations apply cleanly', async () => {
    assert.equal((await rows("select to_regclass('public.hr_payroll_components') value"))[0].value,
      'hr_payroll_components');
  });
  await user(owner);
  const w = (await rpc('bootstrap_workspace', { p_name: 'Synthetic components workspace' })).id;
  const employee = await rpc('save_hr_employee', { p_workspace_id: w,
    p_payload: { code: 'COMP-1', full_name: 'Synthetic Payroll Person', hire_date: '2026-01-01' } });
  await rpc('save_payroll_contract', { p_payload: { workspace_id: w, employee_id: employee.id,
    effective_from: '2026-08-01', pay_basis: 'hourly', rate_vnd: 120000,
    standard_day_minutes: 480, overtime_multiplier: 1.5 } });
  const period = await rpc('save_payroll_period', { p_payload: {
    workspace_id: w, period_start: '2026-08-01', period_end: '2026-08-31' } });
  const base = { period_id: period.id, employee_id: employee.id,
    label: 'Synthetic payroll component', reason: 'Approved test policy input' };
  const save = (payload, requestId = randomUUID()) => rpc('save_hr_payroll_component', {
    p_workspace_id: w, p_payload: payload, p_request_id: requestId,
  });
  const request = randomUUID();
  const allowance = await save({ ...base, kind: 'allowance', amount: 1000 }, request);
  await check('save is retry safe and request-content locked', async () => {
    assert.equal((await save({ ...base, kind: 'allowance', amount: 1000 }, request)).id, allowance.id);
    await error(() => save({ ...base, kind: 'allowance', amount: 2000 }, request), /HR_COMPONENT_REQUEST_REUSED/);
  });
  const bonus = await save({ ...base, kind: 'bonus', amount: 500 });
  const commission = await save({ ...base, kind: 'commission', amount: 200,
    source_reference: 'SALES-TEST-001' });
  await save({ ...base, kind: 'deduction', amount: 100 });
  await check('commission needs source and rejects duplicate active source', async () => {
    await error(() => save({ ...base, kind: 'commission', amount: 1 }), /HR_COMPONENT_INVALID/);
    await error(() => save({ ...base, kind: 'commission', amount: 1,
      source_reference: 'SALES-TEST-001' }), /duplicate key/i);
    assert.equal(commission.kind, 'commission');
  });
  await check('component void is auditable and idempotent', async () => {
    const requestId = randomUUID();
    const args = { p_workspace_id: w, p_component_id: bonus.id,
      p_reason: 'Synthetic bonus entered incorrectly', p_request_id: requestId };
    assert.equal((await rpc('void_hr_payroll_component', args)).status, 'voided');
    assert.equal((await rpc('void_hr_payroll_component', args)).status, 'voided');
    assert.equal((await rows('select count(*) n from public.hr_payroll_components where workspace_id=$1', [w]))[0].n, 4);
  });
  await check('server calculation includes active components exactly once', async () => {
    const result = await rpc('calculate_payroll', { p_workspace_id: w, p_period_id: period.id });
    assert.equal(result.status, 'CALCULATED');
    assert.equal(Number(result.gross_total), 1200);
    assert.equal(Number(result.net_total), 1100);
    const state = await rpc('get_hr_payroll_state', { p_workspace_id: w, p_period_id: period.id });
    assert.equal(state.components.length, 4);
    assert.equal(state.lines[0].allowance_pay, 1000);
    assert.equal(state.lines[0].bonus_pay, 0);
    assert.equal(state.lines[0].commission_pay, 200);
    assert.equal(state.lines[0].other_deduction, 100);
    assert.equal(state.lines[0].source_snapshot.components.length, 3);
  });
  await check('changing inputs reopens calculated period, then approved snapshot locks', async () => {
    await save({ ...base, id: allowance.id, kind: 'allowance', amount: 2000 });
    let state = await rpc('get_hr_payroll_state', { p_workspace_id: w, p_period_id: period.id });
    assert.equal(state.selected_period.status, 'DRAFT');
    await rpc('calculate_payroll', { p_workspace_id: w, p_period_id: period.id });
    await rpc('review_payroll', { p_workspace_id: w, p_period_id: period.id });
    await rpc('approve_payroll', { p_workspace_id: w, p_period_id: period.id, p_request_id: randomUUID() });
    state = await rpc('get_hr_payroll_state', { p_workspace_id: w, p_period_id: period.id });
    assert.equal(Number(state.selected_period.gross_total), 2200);
    assert.equal(Number(state.expenses[0].amount), 2200);
    assert.equal(state.lines[0].source_snapshot.components.length, 3);
    await error(() => save({ ...base, id: allowance.id, kind: 'allowance', amount: 3000 }), /HR_PERIOD_LOCKED/);
  });
  await db.exec('reset role');
  await db.query('insert into public.workspace_members(workspace_id,user_id,role) values($1,$2,$3)', [w,staff,'staff']);
  await user(staff);
  await check('staff cannot read or change payroll components', async () => {
    assert.equal((await rows('select count(*) n from public.hr_payroll_components where workspace_id=$1', [w]))[0].n, 0);
    await error(() => rpc('get_hr_payroll_state', { p_workspace_id: w, p_period_id: period.id }), /permission|quyền|role/i);
    await error(() => save({ ...base, kind: 'bonus', amount: 100 }), /permission|quyền|role/i);
  });
  console.log(`HR payroll component checks passed: ${passed}`);
} finally { await db.close(); }
