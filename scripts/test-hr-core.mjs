// Synthetic local PostgreSQL only. No environment, cloud, or customer data.
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
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
];
const users = {
  owner: '11111111-1111-4111-8111-111111111111',
  other: '22222222-2222-4222-8222-222222222222',
  manager: '33333333-3333-4333-8333-333333333333',
  staff: '44444444-4444-4444-8444-444444444444',
  viewer: '55555555-5555-4555-8555-555555555555',
};
const db = new PGlite();
let passed = 0;
async function check(name, run) {
  await run();
  passed++;
  console.log('PASS', name);
}
async function asUser(id) {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id || '']);
  await db.exec('set role authenticated');
}
async function rpc(name, args) {
  const entries = Object.entries(args);
  const { rows } = await db.query(
    `select public.${name}(${entries.map(([key], i) => `${key}=>$${i + 1}`).join(',')}) as result`,
    entries.map(([, value]) =>
      value !== null && typeof value === 'object' ? JSON.stringify(value) : value,
    ),
  );
  return rows[0].result;
}
const save = (name, workspace, payload) =>
  rpc(name, { p_workspace_id: workspace, p_payload: payload });
const archive = (name, workspace, id, archived) =>
  rpc(name, {
    p_workspace_id: workspace,
    p_id: id,
    p_archived: archived,
    p_reason: 'Synthetic HR archive lifecycle reason',
  });
const remove = (name, workspace, id) =>
  rpc(name, {
    p_workspace_id: workspace,
    p_id: id,
    p_reason: 'Synthetic unused HR catalog removal',
  });
const list = (workspace, args = {}) =>
  rpc('list_hr_employees', {
    p_workspace_id: workspace,
    p_query: args.query ?? '',
    p_department_id: args.department_id ?? null,
    p_status: args.status ?? null,
    p_sort: args.sort ?? 'code',
    p_desc: args.desc ?? false,
    p_limit: args.limit ?? 25,
    p_offset: args.offset ?? 0,
  });

try {
  await db.exec(`create role anon;create role authenticated;create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to authenticated,anon;grant execute on function auth.uid() to authenticated,anon;`);
  for (const [name, id] of Object.entries(users)) {
    await db.query('insert into auth.users values($1,$2,now())', [id, `${name}@hr.example.test`]);
  }
  for (const name of migrationNames) {
    const sql = await readFile(
      new URL(`../supabase/migrations/${name}.sql`, import.meta.url),
      'utf8',
    );
    await db.exec(sql);
  }
  await check('clean 001--017 migration builds without existing HR data', async () => {
    assert.equal(
      (await db.query("select to_regclass('public.hr_employees') as table_name")).rows[0]
        .table_name,
      'hr_employees',
    );
  });

  await asUser(users.owner);
  const w = (await rpc('bootstrap_workspace', { p_name: 'Synthetic HR A' })).id;
  await asUser(users.other);
  const otherW = (await rpc('bootstrap_workspace', { p_name: 'Synthetic HR B' })).id;
  await asUser(users.owner);
  await rpc('add_workspace_member', {
    p_workspace_id: w,
    p_email: 'manager@hr.example.test',
    p_role: 'manager',
  });
  await rpc('add_workspace_member', {
    p_workspace_id: w,
    p_email: 'staff@hr.example.test',
    p_role: 'staff',
  });
  await rpc('add_workspace_member', {
    p_workspace_id: w,
    p_email: 'viewer@hr.example.test',
    p_role: 'viewer',
  });

  const department = await save('save_hr_department', w, { code: 'SALE', name: 'Kinh doanh' });
  const position = await save('save_hr_position', w, {
    code: 'ADVISOR',
    name: 'Tư vấn',
    department_id: department.id,
  });
  const employee = await save('save_hr_employee', w, {
    code: 'NV001',
    full_name: 'Nguyễn Văn Mẫu',
    phone: '0901234567',
    email: 'sample@hr.example.test',
    department_id: department.id,
    position_id: position.id,
    hire_date: '2026-01-01',
  });
  await check('employee is a separate record with no implicit auth account', async () => {
    assert.equal(employee.auth_user_id, null);
    await db.exec('reset role');
    assert.equal((await db.query('select count(*)::int as n from auth.users')).rows[0].n, 5);
    assert.equal(
      (await db.query('select count(*)::int as n from public.hr_employees')).rows[0].n,
      1,
    );
    await asUser(users.owner);
  });

  await check('workspace unique code, linked catalog, server input validation', async () => {
    await assert.rejects(
      () => save('save_hr_employee', w, { code: 'nv001', full_name: 'Trùng mã' }),
      /duplicate key/,
    );
    await assert.rejects(
      () =>
        save('save_hr_employee', w, {
          code: 'NV002',
          full_name: 'Sai phòng',
          department_id: otherW,
        }),
      /HR_DEPARTMENT/,
    );
    await assert.rejects(
      () =>
        save('save_hr_employee', w, { code: 'NV002', full_name: 'Sai email', email: 'invalid' }),
      /check constraint/,
    );
    await assert.rejects(
      () =>
        save('save_hr_employee', w, {
          code: 'NV002',
          full_name: 'Sai tài khoản',
          auth_user_id: users.other,
        }),
      /HR_AUTH_MEMBER/,
    );
  });

  await check('paginated filtered search and stable ordering', async () => {
    await save('save_hr_employee', w, {
      code: 'NV002',
      full_name: 'Trần B',
      department_id: department.id,
      position_id: position.id,
      status: 'on_leave',
    });
    await save('save_hr_employee', w, { code: 'NV003', full_name: 'Lê C', status: 'terminated' });
    const page = await list(w, { limit: 2, sort: 'code', desc: true });
    assert.equal(page.total, 3);
    assert.deepEqual(
      page.rows.map((e) => e.code),
      ['NV003', 'NV002'],
    );
    assert.equal((await list(w, { query: 'nguyễn' })).total, 1);
    assert.equal((await list(w, { department_id: department.id, status: 'on_leave' })).total, 1);
    assert.deepEqual(
      (await list(w, { limit: 2, offset: 2 })).rows.map((e) => e.code),
      ['NV003'],
    );
    await assert.rejects(() => list(w, { sort: 'unsafe_sql' }), /HR_SORT/);
  });

  await check('dashboard counts and department chart derive from rows', async () => {
    const result = await rpc('get_hr_dashboard', { p_workspace_id: w });
    assert.equal(result.employee_total, 3);
    assert.equal(result.working_count, 1);
    assert.equal(result.on_leave_count, 1);
    assert.equal(result.left_count, 1);
    assert.equal(
      result.department_counts.find((d) => d.department_id === department.id).employee_count,
      2,
    );
  });

  await check('manager may manage; staff and viewer cannot read sensitive HR', async () => {
    await asUser(users.manager);
    assert.equal((await list(w)).total, 3);
    await save('save_hr_employee', w, { id: employee.id, full_name: 'Nguyễn Văn Mẫu Sửa' });
    await asUser(users.staff);
    assert.equal(
      (await db.query('select count(*)::int as n from public.hr_employees')).rows[0].n,
      0,
    );
    await assert.rejects(() => list(w), /quyền|permission|42501/i);
    await assert.rejects(
      () => save('save_hr_employee', w, { code: 'BAD', full_name: 'Không quyền' }),
      /quyền|permission|42501/i,
    );
    await asUser(users.viewer);
    assert.equal(
      (await db.query('select count(*)::int as n from public.hr_employees')).rows[0].n,
      0,
    );
    await assert.rejects(
      () => rpc('get_hr_employee', { p_workspace_id: w, p_id: employee.id }),
      /quyền|permission|42501/i,
    );
    await asUser(users.owner);
  });

  await check('workspace isolation and direct table write denial', async () => {
    await asUser(users.other);
    assert.equal(
      (await db.query('select count(*)::int as n from public.hr_employees')).rows[0].n,
      0,
    );
    await assert.rejects(() => list(w), /quyền|permission|42501/i);
    await assert.rejects(
      () => save('save_hr_employee', w, { id: employee.id, full_name: 'Cross workspace' }),
      /quyền|permission|42501/i,
    );
    await assert.rejects(
      () =>
        db.query(
          "insert into public.hr_employees(workspace_id,code,full_name,created_by) values($1,'BAD','Direct',$2)",
          [otherW, users.other],
        ),
      /permission denied/i,
    );
    await asUser(users.owner);
  });

  await check('manager cycle, archive blockers and conditional deletion', async () => {
    const subordinate = (await list(w, { query: 'Trần B' })).rows[0];
    await save('save_hr_employee', w, {
      id: subordinate.id,
      manager_employee_id: employee.id,
      status: 'active',
    });
    await assert.rejects(
      () => save('save_hr_employee', w, { id: employee.id, manager_employee_id: subordinate.id }),
      /HR_MANAGER_CYCLE/,
    );
    await assert.rejects(
      () => archive('set_hr_employee_archived', w, employee.id, true),
      /HR_MANAGER_IN_USE/,
    );
    await assert.rejects(() => remove('delete_hr_position', w, position.id), /HR_POSITION_IN_USE/);
    await assert.rejects(
      () => archive('set_hr_position_archived', w, position.id, true),
      /HR_POSITION_IN_USE/,
    );
    await assert.rejects(
      () => remove('delete_hr_department', w, department.id),
      /HR_DEPARTMENT_IN_USE/,
    );
    const sparePosition = await save('save_hr_position', w, { code: 'SPARE', name: 'Chưa dùng' });
    assert.equal(
      (await remove('delete_hr_position', w, sparePosition.id)).deleted_id,
      sparePosition.id,
    );
    await save('save_hr_employee', w, { id: subordinate.id, manager_employee_id: null });
    assert.equal(
      (await archive('set_hr_employee_archived', w, employee.id, true)).is_active,
      false,
    );
    assert.equal((await list(w, { status: 'archived' })).total, 1);
    assert.equal(
      (await archive('set_hr_employee_archived', w, employee.id, false)).is_active,
      true,
    );
  });

  await check('removing a workspace member unlinks login without deleting employee', async () => {
    await save('save_hr_employee', w, { id: employee.id, auth_user_id: users.viewer });
    await rpc('remove_workspace_member', { p_workspace_id: w, p_user_id: users.viewer });
    const retained = await rpc('get_hr_employee', { p_workspace_id: w, p_id: employee.id });
    assert.equal(retained.auth_user_id, null);
    assert.equal(retained.id, employee.id);
  });

  await check('audit avoids storing employee personal fields', async () => {
    await db.exec('reset role');
    const events = (
      await db.query(
        "select details::text from public.audit_events where workspace_id=$1 and action='hr_employee.saved'",
        [w],
      )
    ).rows;
    assert.ok(events.length >= 3);
    assert.ok(
      events.every((e) => !e.details.includes('Nguyễn') && !e.details.includes('0901234567')),
    );
  });

  console.log(`HR core database: ${passed} checks passed.`);
} finally {
  await db.close();
}
