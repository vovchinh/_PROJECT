import { PGlite } from '@electric-sql/pglite';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';

// Executes real PostgreSQL SQL locally. Auth/JWT is mocked; no cloud credentials.
const db = new PGlite();
const checks = [];
const users = {
  owner: '11111111-1111-4111-8111-111111111111',
  otherOwner: '22222222-2222-4222-8222-222222222222',
  staff: '33333333-3333-4333-8333-333333333333',
  viewer: '44444444-4444-4444-8444-444444444444',
  manager: '55555555-5555-4555-8555-555555555555',
  coOwner: '66666666-6666-4666-8666-666666666666',
  unconfirmed: '77777777-7777-4777-8777-777777777777',
};
const migration1 = await readFile(
  new URL('../supabase/migrations/001_core.sql', import.meta.url),
  'utf8',
);
const migration2 = await readFile(
  new URL('../supabase/migrations/002_operations.sql', import.meta.url),
  'utf8',
);

async function ok(name, fn) {
  await fn();
  checks.push(name);
  console.log('PASS', name);
}
async function user(id) {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id ?? '']);
  await db.exec('set role authenticated');
}
async function rpc(name, args) {
  const keys = Object.keys(args);
  const { rows } = await db.query(
    `select public.${name}(${keys.map((k, i) => `${k}=>$${i + 1}`).join(',')}) as result`,
    Object.values(args).map((v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v)),
  );
  return rows[0].result;
}
async function denied(name, args, pattern) {
  await assert.rejects(() => rpc(name, args), pattern);
}
async function report(w, from = '2026-08-01', to = '2026-08-31') {
  return rpc('get_workspace_report', { p_workspace_id: w, p_from: from, p_to: to });
}
async function memberAuditCount(w) {
  return (
    await db.query(
      "select count(*)::integer n from public.audit_events where workspace_id=$1 and action like 'member.%'",
      [w],
    )
  ).rows[0].n;
}

try {
  await db.exec(`
    create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
    $$;
    grant usage on schema auth to authenticated,anon;
    grant execute on function auth.uid() to authenticated,anon;
  `);
  for (const [name, id] of Object.entries(users)) {
    await db.query('insert into auth.users values($1,$2,$3)', [
      id,
      `${name.toLowerCase()}@chidi.test`,
      name === 'unconfirmed' ? null : '2026-01-01T00:00:00Z',
    ]);
  }
  await db.exec(migration1);
  await ok('Migration 002 runs after unmodified 001', () => db.exec(migration2));
  await ok('Migration 002 can be replayed', () => db.exec(migration2));
  await user(users.owner);
  const w = (await rpc('bootstrap_workspace', { p_name: 'Operations QA' })).id;
  await user(users.otherOwner);
  const otherW = (await rpc('bootstrap_workspace', { p_name: 'Isolated QA' })).id;
  await user(users.owner);

  await ok('Only workspace owner is listed initially, with masked email', async () => {
    const rows = await rpc('list_workspace_members', { p_workspace_id: w });
    assert.deepEqual(rows, [
      { user_id: users.owner, role: 'owner', email_hint: 'o***@chidi.test', is_self: true },
    ]);
    assert.ok(!JSON.stringify(rows).includes('owner@'));
  });
  await ok('Exact normalized confirmed email adds the intended member', async () => {
    const r = await rpc('add_workspace_member', {
      p_workspace_id: w,
      p_email: '  STAFF@chidi.test ',
      p_role: 'staff',
    });
    assert.equal(r.user_id, users.staff);
    assert.equal(r.changed, true);
    assert.equal(r.email_hint, 's***@chidi.test');
  });
  await ok('Same member/role replay does not add another audit event', async () => {
    const before = await memberAuditCount(w);
    const r = await rpc('add_workspace_member', {
      p_workspace_id: w,
      p_email: 'staff@chidi.test',
      p_role: 'staff',
    });
    assert.equal(r.changed, false);
    assert.equal(await memberAuditCount(w), before);
  });
  await ok('Add cannot silently change an existing member role', () =>
    denied(
      'add_workspace_member',
      {
        p_workspace_id: w,
        p_email: 'staff@chidi.test',
        p_role: 'owner',
      },
      /đổi vai trò/,
    ),
  );
  await ok('Unknown, wildcard, partial and unconfirmed emails cannot be added', async () => {
    for (const email of ['missing@chidi.test', '%@chidi.test', 'staff', 'unconfirmed@chidi.test']) {
      await denied('add_workspace_member', { p_workspace_id: w, p_email: email, p_role: 'viewer' });
    }
  });
  await ok('Unknown or null role cannot be injected', async () => {
    for (const role of ['admin', 'OWNER', null]) {
      await denied(
        'add_workspace_member',
        { p_workspace_id: w, p_email: 'viewer@chidi.test', p_role: role },
        /Vai trò/,
      );
      await denied(
        'set_workspace_member_role',
        { p_workspace_id: w, p_user_id: users.staff, p_role: role },
        /Vai trò/,
      );
    }
  });
  await rpc('add_workspace_member', { p_workspace_id: w, p_email: 'viewer@chidi.test' });
  await rpc('add_workspace_member', {
    p_workspace_id: w,
    p_email: 'manager@chidi.test',
    p_role: 'manager',
  });
  await ok('Role changes are scoped and audited with old/new roles', async () => {
    const r = await rpc('set_workspace_member_role', {
      p_workspace_id: w,
      p_user_id: users.staff,
      p_role: 'manager',
    });
    assert.equal(r.changed, true);
    const event = (
      await db.query(
        "select details,actor_id from public.audit_events where action='member.role_changed' and entity_id=$1",
        [users.staff],
      )
    ).rows[0];
    assert.deepEqual(event.details, { old_role: 'staff', new_role: 'manager' });
    assert.equal(event.actor_id, users.owner);
    await rpc('set_workspace_member_role', {
      p_workspace_id: w,
      p_user_id: users.staff,
      p_role: 'staff',
    });
  });
  await ok('Same role edit is a no-op without duplicate audit', async () => {
    const before = await memberAuditCount(w);
    const r = await rpc('set_workspace_member_role', {
      p_workspace_id: w,
      p_user_id: users.staff,
      p_role: 'staff',
    });
    assert.equal(r.changed, false);
    assert.equal(await memberAuditCount(w), before);
  });
  await ok('Last owner cannot demote themself', () =>
    denied(
      'set_workspace_member_role',
      {
        p_workspace_id: w,
        p_user_id: users.owner,
        p_role: 'viewer',
      },
      /owner cuối cùng/,
    ),
  );
  await ok('Owner cannot remove their own membership', () =>
    denied(
      'remove_workspace_member',
      {
        p_workspace_id: w,
        p_user_id: users.owner,
      },
      /tự xóa/,
    ),
  );
  await ok('Member of another workspace cannot be changed or removed by UUID', async () => {
    await denied(
      'set_workspace_member_role',
      { p_workspace_id: w, p_user_id: users.otherOwner, p_role: 'staff' },
      /Không tìm thấy/,
    );
    await denied(
      'remove_workspace_member',
      { p_workspace_id: w, p_user_id: users.otherOwner },
      /Không tìm thấy/,
    );
  });
  await ok('Owner authority does not extend to another workspace', async () => {
    await denied('list_workspace_members', { p_workspace_id: otherW }, /không có quyền/);
    await denied(
      'add_workspace_member',
      { p_workspace_id: otherW, p_email: 'staff@chidi.test', p_role: 'owner' },
      /không có quyền/,
    );
    await denied(
      'set_workspace_member_role',
      { p_workspace_id: otherW, p_user_id: users.otherOwner, p_role: 'staff' },
      /không có quyền/,
    );
    await denied(
      'remove_workspace_member',
      { p_workspace_id: otherW, p_user_id: users.otherOwner },
      /không có quyền/,
    );
    await assert.rejects(() => report(otherW), /không có quyền/);
  });
  await ok('Direct membership writes and global Auth reads remain denied', async () => {
    await assert.rejects(() =>
      db.query('update public.workspace_members set role=$1 where user_id=$2', [
        'owner',
        users.viewer,
      ]),
    );
    await assert.rejects(() =>
      db.query('delete from public.workspace_members where user_id=$1', [users.owner]),
    );
    await assert.rejects(() => db.query('select email from auth.users'));
  });
  for (const role of ['manager', 'staff', 'viewer']) {
    await user(users[role]);
    await ok(`${role} can read reports but cannot administer membership`, async () => {
      assert.equal((await report(w)).workspace_id, w);
      await denied('list_workspace_members', { p_workspace_id: w }, /không có quyền/);
      await denied(
        'add_workspace_member',
        { p_workspace_id: w, p_email: 'coowner@chidi.test', p_role: 'owner' },
        /không có quyền/,
      );
      await denied(
        'set_workspace_member_role',
        { p_workspace_id: w, p_user_id: users[role], p_role: 'owner' },
        /không có quyền/,
      );
      await denied(
        'remove_workspace_member',
        { p_workspace_id: w, p_user_id: users.owner },
        /không có quyền/,
      );
    });
  }
  await user(users.owner);
  await rpc('add_workspace_member', {
    p_workspace_id: w,
    p_email: 'coowner@chidi.test',
    p_role: 'owner',
  });
  await ok('Self-demotion is possible only when another owner exists', async () => {
    assert.equal(
      (
        await rpc('set_workspace_member_role', {
          p_workspace_id: w,
          p_user_id: users.owner,
          p_role: 'manager',
        })
      ).role,
      'manager',
    );
    await denied('list_workspace_members', { p_workspace_id: w }, /không có quyền/);
    await user(users.coOwner);
    await denied(
      'set_workspace_member_role',
      { p_workspace_id: w, p_user_id: users.coOwner, p_role: 'manager' },
      /owner cuối cùng/,
    );
    await rpc('set_workspace_member_role', {
      p_workspace_id: w,
      p_user_id: users.owner,
      p_role: 'owner',
    });
    await rpc('set_workspace_member_role', {
      p_workspace_id: w,
      p_user_id: users.coOwner,
      p_role: 'manager',
    });
  });
  await user(users.owner);
  await ok(
    'Removing another member records an audit event and revokes RLS/report access',
    async () => {
      const result = await rpc('remove_workspace_member', {
        p_workspace_id: w,
        p_user_id: users.coOwner,
      });
      assert.deepEqual(result, { user_id: users.coOwner, removed: true });
      const audit = (
        await db.query(
          "select details from public.audit_events where action='member.removed' and entity_id=$1",
          [users.coOwner],
        )
      ).rows[0];
      assert.equal(audit.details.old_role, 'manager');
      await user(users.coOwner);
      await assert.rejects(() => report(w), /không có quyền/);
      assert.equal(
        (await db.query('select * from public.cash_accounts where workspace_id=$1', [w])).rows
          .length,
        0,
      );
      await user(users.owner);
    },
  );
  await ok('Member list only contains current workspace members', async () => {
    const rows = await rpc('list_workspace_members', { p_workspace_id: w });
    assert.equal(rows.length, 4);
    assert.ok(
      rows.every((r) => ![users.otherOwner, users.coOwner, users.unconfirmed].includes(r.user_id)),
    );
  });

  // Real RPC posting fixtures: boundaries, before-period carry and later reversals.
  const supplier = await rpc('save_master', {
    p_kind: 'suppliers',
    p_payload: { workspace_id: w, code: 'QA-SUP', name: 'QA supplier' },
  });
  const product = await rpc('save_master', {
    p_kind: 'products',
    p_payload: {
      workspace_id: w,
      code: 'QA-SKU',
      name: 'QA product',
      supplier_id: supplier.id,
      provisional: false,
    },
  });
  await rpc('save_master', {
    p_kind: 'products',
    p_payload: { workspace_id: w, code: 'ZERO-SKU', name: 'No movements' },
  });
  const warehouse = (await db.query('select id from public.warehouses where workspace_id=$1', [w]))
    .rows[0].id;
  const accounts = Object.fromEntries(
    (await db.query('select * from public.cash_accounts where workspace_id=$1', [w])).rows.map(
      (r) => [r.code, r],
    ),
  );
  for (const [code, balance, date, confirmed] of [
    ['CASH', 1000, '2026-07-01', true],
    ['BANK_CHINH', 500, '2026-08-15', true],
    ['BANK_DIEU', 2000, '2026-09-01', true],
    ['OTHER', 777, '2026-08-01', false],
  ]) {
    await rpc('save_master', {
      p_kind: 'cash_accounts',
      p_payload: {
        ...accounts[code],
        opening_balance: balance,
        opening_date: date,
        opening_confirmed: confirmed,
      },
    });
  }
  async function cash(code, date, direction, category, amount, post = true) {
    const r = await rpc('create_cash', {
      p_payload: {
        workspace_id: w,
        account_id: accounts[code].id,
        transaction_date: date,
        direction,
        category,
        amount,
        date_estimated: false,
        description: 'QA fixture',
      },
    });
    if (post) await rpc('post_cash', { p_id: r.id, p_request_id: crypto.randomUUID() });
    return r;
  }
  async function purchase(date, qty, unitCost, extra = 0, post = true) {
    const r = await rpc('create_purchase', {
      p_payload: {
        workspace_id: w,
        product_id: product.id,
        supplier_id: supplier.id,
        warehouse_id: warehouse,
        received_date: date,
        qty,
        unit_cost: unitCost,
        additional_cost: extra,
        date_estimated: false,
      },
    });
    if (post) await rpc('post_purchase', { p_id: r.id, p_request_id: crypto.randomUUID() });
    return r;
  }
  await cash('CASH', '2026-07-31', 'out', 'packaging', 100);
  await cash('CASH', '2026-08-01', 'in', 'capital', 200);
  const reversedCash = await cash('CASH', '2026-08-18', 'out', 'packaging', 80);
  await cash('CASH', '2026-08-31', 'in', 'legacy_cod', 70);
  await cash('CASH', '2026-09-01', 'out', 'software', 900);
  await cash('BANK_CHINH', '2026-08-15', 'in', 'other_receipt', 30);
  await cash('BANK_CHINH', '2026-08-31', 'out', 'software', 10);
  await cash('CASH', null, 'out', 'packaging', 1234, false);
  await purchase('2026-07-31', 2, 100);
  await purchase('2026-08-01', 3, 100, 5);
  const reversedPurchase = await purchase('2026-08-18', 4, 100);
  await purchase('2026-08-31', 5, 200, 10);
  await purchase('2026-09-01', 6, 300);
  await purchase('2026-08-19', 999, 3, 0, false);
  for (const [kind, document] of [
    ['cash', reversedCash],
    ['purchase', reversedPurchase],
  ]) {
    await rpc('reverse_document', {
      p_kind: kind,
      p_id: document.id,
      p_request_id: crypto.randomUUID(),
      p_date: '2026-08-20',
      p_reason: 'Reverse QA test document',
    });
  }
  const august = await report(w);
  await ok(
    'August totals reconcile openings, later account opening, cash and signed purchases',
    async () => {
      assert.deepEqual(august.overview, {
        cash_in: '380',
        cash_out: '90',
        net_cash_flow: '290',
        opening_cash: '900',
        openings_in_period: '500',
        closing_cash: '1690',
        reconciliation_difference: '0',
        purchase_qty: '8',
        purchase_amount: '1315',
        stock_qty_as_of: '10',
        stock_value_as_of: '1515',
        pending_purchase_count: 1,
        pending_cash_count: 1,
        confirmed_account_count: 2,
        unconfirmed_account_count: 4,
        not_yet_open_account_count: 1,
      });
    },
  );
  await ok(
    'Unknown and future openings are null in account balances and excluded from totals',
    async () => {
      const rows = Object.fromEntries(august.cash_accounts.map((r) => [r.code, r]));
      assert.equal(rows.OTHER.state, 'unconfirmed');
      assert.equal(rows.OTHER.closing_cash, null);
      assert.equal(rows.BANK_DIEU.state, 'opens_after_period');
      assert.equal(rows.BANK_DIEU.opening_cash, null);
      assert.equal(rows.CASH.closing_cash, '1170');
      assert.equal(rows.BANK_CHINH.opening_cash, '0');
      assert.equal(rows.BANK_CHINH.openings_in_period, '500');
      assert.ok(august.warnings.some((r) => r.code === 'UNCONFIRMED_OPENINGS'));
      assert.ok(august.warnings.some((r) => r.code === 'FUTURE_OPENINGS'));
    },
  );
  await ok('Categories keep reversal direction and do not turn COD into profit', async () => {
    const packaging = august.cash_categories.find((r) => r.category === 'packaging');
    assert.deepEqual(packaging, {
      category: 'packaging',
      cash_in: '80',
      cash_out: '80',
      net_cash_flow: '0',
      post_count: 1,
      reversal_count: 1,
    });
    assert.equal(august.cash_categories.find((r) => r.category === 'legacy_cod').cash_in, '70');
    assert.ok(august.warnings.some((r) => r.code === 'CASH_IS_NOT_PROFIT'));
    assert.ok(!Object.hasOwn(august.overview, 'profit'));
  });
  await ok(
    'SKU report distinguishes period changes, cumulative receipts and zero-movement products',
    async () => {
      assert.deepEqual(
        august.stock_by_sku.find((r) => r.code === 'QA-SKU'),
        {
          product_id: product.id,
          code: 'QA-SKU',
          name: 'QA product',
          qty_in_period: '8',
          amount_in_period: '1315',
          qty_as_of: '10',
          amount_as_of: '1515',
        },
      );
      assert.equal(august.stock_by_sku.find((r) => r.code === 'ZERO-SKU').qty_as_of, '0');
      assert.ok(august.warnings.some((r) => r.code === 'RECEIPT_LEDGER_ONLY'));
    },
  );
  await ok('Report before a later reversal still contains the original posting', async () => {
    const day = await report(w, '2026-08-18', '2026-08-18');
    assert.equal(day.overview.cash_out, '80');
    assert.equal(day.overview.cash_in, '0');
    assert.equal(day.overview.opening_cash, '1630');
    assert.equal(day.overview.closing_cash, '1550');
    assert.equal(day.overview.purchase_qty, '4');
    assert.equal(day.overview.stock_qty_as_of, '9');
  });
  await ok(
    'Reversal-date period shows compensating movement without duplicating original',
    async () => {
      const day = await report(w, '2026-08-20', '2026-08-20');
      assert.equal(day.overview.cash_in, '80');
      assert.equal(day.overview.cash_out, '0');
      assert.equal(day.overview.purchase_qty, '-4');
      assert.equal(day.overview.purchase_amount, '-400');
    },
  );
  await ok('Both date boundaries are inclusive and tomorrow is excluded', async () => {
    const first = await report(w, '2026-08-01', '2026-08-01');
    assert.equal(first.overview.cash_in, '200');
    assert.equal(first.overview.purchase_qty, '3');
    const last = await report(w, '2026-08-31', '2026-08-31');
    assert.equal(last.overview.cash_in, '70');
    assert.equal(last.overview.cash_out, '10');
    assert.equal(last.overview.purchase_qty, '5');
  });
  await ok('Account opening on first period day enters opening balance once', async () => {
    const september = await report(w, '2026-09-01', '2026-09-30');
    assert.equal(september.overview.opening_cash, '3690');
    assert.equal(september.overview.openings_in_period, '0');
    assert.equal(september.overview.cash_out, '900');
    assert.equal(september.overview.closing_cash, '2790');
    assert.equal(september.overview.reconciliation_difference, '0');
    assert.equal(september.overview.purchase_qty, '6');
  });
  await ok(
    'No activity before all opening dates does not include future opening claims',
    async () => {
      const before = await report(w, '2026-06-01', '2026-06-30');
      assert.equal(before.overview.opening_cash, '0');
      assert.equal(before.overview.closing_cash, '0');
      assert.equal(before.overview.cash_in, '0');
      assert.equal(before.overview.stock_qty_as_of, '0');
      assert.equal(before.cash_categories.length, 0);
    },
  );
  await ok('Null, infinite and reversed report periods are rejected', async () => {
    for (const [from, to] of [
      [null, '2026-08-31'],
      ['2026-08-01', null],
      ['2026-09-01', '2026-08-31'],
      ['-infinity', '2026-08-31'],
      ['2026-08-01', 'infinity'],
    ]) {
      await assert.rejects(() => report(w, from, to), /Kỳ báo cáo/);
    }
  });
  await ok('Reports do not mutate ledger or append audit events', async () => {
    const before = (await db.query('select count(*)::integer n from public.audit_events')).rows[0]
      .n;
    await report(w);
    await report(w);
    assert.equal(
      (await db.query('select count(*)::integer n from public.audit_events')).rows[0].n,
      before,
    );
  });
  await user(users.viewer);
  await ok('Viewer receives the same authorized report totals', async () =>
    assert.deepEqual((await report(w)).overview, august.overview),
  );
  await user(users.otherOwner);
  await ok('Another tenant cannot retrieve report or member data from this tenant', async () => {
    await assert.rejects(() => report(w), /không có quyền/);
    await denied('list_workspace_members', { p_workspace_id: w }, /không có quyền/);
    assert.equal((await report(otherW)).overview.closing_cash, '0');
  });

  // Bulk valid fixture in isolated tenant checks aggregate accuracy beyond one
  // REST page and JS safe integer limits. It is test setup, not production import.
  const otherAccount = (
    await db.query("select * from public.cash_accounts where workspace_id=$1 and code='CASH'", [
      otherW,
    ])
  ).rows[0];
  await rpc('save_master', {
    p_kind: 'cash_accounts',
    p_payload: {
      ...otherAccount,
      opening_balance: 0,
      opening_confirmed: true,
      opening_date: '2026-08-01',
    },
  });
  await db.exec('reset role');
  await db.query(
    `with inserted as (
    insert into public.cash_transactions(workspace_id,account_id,direction,transaction_date,category,amount,status,created_by)
    select $1,$2,'in','2026-08-01','capital',case when i=1003 then 1 else 9000000000000 end,'posted',$3
    from generate_series(1,1003) i returning *
  ) insert into public.cash_movements(workspace_id,cash_id,account_id,transaction_date,movement_kind,direction,amount,category)
    select workspace_id,id,account_id,transaction_date,'post',direction,amount,category from inserted`,
    [otherW, otherAccount.id, users.otherOwner],
  );
  await user(users.otherOwner);
  await ok(
    'Server aggregate includes over 1000 movements and preserves integers beyond JS safe range',
    async () => {
      const r = await report(otherW);
      const exact = (1002n * 9000000000000n + 1n).toString();
      assert.equal(r.overview.cash_in, exact);
      assert.equal(r.overview.closing_cash, exact);
      assert.equal(r.cash_categories[0].post_count, 1003);
      assert.equal(typeof r.cash_accounts.find((a) => a.code === 'CASH').closing_cash, 'string');
      assert.ok(BigInt(exact) > BigInt(Number.MAX_SAFE_INTEGER));
      assert.notEqual(BigInt(Number(exact)), BigInt(exact));
    },
  );
  await user(users.owner);
  await ok('Large other-tenant ledger does not affect this workspace totals', async () =>
    assert.deepEqual((await report(w)).overview, august.overview),
  );
  await db.exec('reset role');
  await ok(
    'Report is STABLE with fixed empty search_path; membership mutations lock workspace',
    async () => {
      const p = (
        await db.query(
          "select provolatile,prosecdef,proconfig from pg_proc where oid='public.get_workspace_report(uuid,date,date)'::regprocedure",
        )
      ).rows[0];
      assert.equal(p.provolatile, 's');
      assert.equal(p.prosecdef, true);
      assert.ok(p.proconfig.includes('search_path=""'));
      const body = (
        await db.query(
          "select prosrc from pg_proc where oid='app_private.lock_membership_owner(uuid)'::regprocedure",
        )
      ).rows[0].prosrc;
      assert.match(body, /for update/i);
      assert.equal(body.match(/require_role/g).length, 2);
    },
  );
  await ok(
    'Reapplying 002 preserves populated documents, ledger, membership and reports',
    async () => {
      await db.exec(migration2);
      await user(users.owner);
      assert.deepEqual((await report(w)).overview, august.overview);
      assert.equal((await rpc('list_workspace_members', { p_workspace_id: w })).length, 4);
    },
  );
  await user(null);
  await ok(
    'Authenticated role without an Auth subject has no report or membership authority',
    async () => {
      await assert.rejects(() => report(w), /không có quyền/);
      await denied('list_workspace_members', { p_workspace_id: w }, /không có quyền/);
    },
  );
  await db.exec('reset role');
  await db.exec('set role anon');
  await ok('Anonymous cannot execute any V1.1 RPC', async () => {
    await assert.rejects(() => report(w), /permission denied/);
    await denied('list_workspace_members', { p_workspace_id: w }, /permission denied/);
    await denied(
      'add_workspace_member',
      { p_workspace_id: w, p_email: 'staff@chidi.test', p_role: 'owner' },
      /permission denied/,
    );
    await denied(
      'set_workspace_member_role',
      { p_workspace_id: w, p_user_id: users.owner, p_role: 'viewer' },
      /permission denied/,
    );
    await denied(
      'remove_workspace_member',
      { p_workspace_id: w, p_user_id: users.owner },
      /permission denied/,
    );
  });
  await user(users.owner);
  await ok('Internal membership lock and email helper are not executable by clients', async () => {
    await assert.rejects(
      () => db.query('select app_private.lock_membership_owner($1)', [w]),
      /permission denied/,
    );
    await assert.rejects(
      () => db.query("select app_private.email_hint('owner@chidi.test')"),
      /permission denied/,
    );
  });

  await mkdir(new URL('../test-results/', import.meta.url), { recursive: true });
  await writeFile(
    new URL('../test-results/operations.json', import.meta.url),
    JSON.stringify(
      {
        status: 'PASS',
        checks: checks.length,
        names: checks,
        engine:
          'PGlite PostgreSQL WASM with mocked auth.users/auth.uid; no live Supabase mutations',
        limitations:
          'Live Auth/JWT/PostgREST and multi-connection concurrency require cloud acceptance checks.',
      },
      null,
      2,
    ),
  );
  console.log(`Operations: ${checks.length}/${checks.length} PASS`);
} finally {
  await db.close();
}
