// Synthetic local PostgreSQL only. No environment, cloud or customer data.
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const users = {
  owner: '11111111-1111-4111-8111-111111111111',
  other: '22222222-2222-4222-8222-222222222222',
  manager: '33333333-3333-4333-8333-333333333333',
  staff: '44444444-4444-4444-8444-444444444444',
  viewer: '55555555-5555-4555-8555-555555555555',
};
const names = [
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
];
const sql = await Promise.all(
  names.map((name) =>
    readFile(new URL(`../supabase/migrations/${name}.sql`, import.meta.url), 'utf8'),
  ),
);
const legacy = [
  ['packaging', 'out', true],
  ['software', 'out', true],
  ['rent', 'out', true],
  ['utilities', 'out', true],
  ['shipping', 'out', true],
  ['marketing', 'out', true],
  ['payroll', 'out', false],
  ['other_expense', 'out', true],
  ['legacy_purchase_payment', 'out', false],
  ['owner_withdrawal', 'out', false],
  ['capital', 'in', false],
  ['legacy_cod', 'in', false],
  ['customer_receipt', 'in', false],
  ['other_receipt', 'in', false],
];
const opened = [];
let passed = 0;
async function check(name, run) {
  await run();
  passed++;
  console.log('PASS', name);
}
async function asUser(db, id) {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id || '']);
  await db.exec('set role authenticated');
}
async function call(db, name, args) {
  const { rows } = await db.query(
    `select public.${name}(${Object.keys(args)
      .map((key, i) => `${key}=>$${i + 1}`)
      .join(',')}) result`,
    Object.values(args).map((value) =>
      value !== null && typeof value === 'object' ? JSON.stringify(value) : value,
    ),
  );
  return rows[0].result;
}
async function setup(count) {
  const db = new PGlite();
  opened.push(db);
  await db.exec(`create role anon;create role authenticated;create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to authenticated,anon;grant execute on function auth.uid() to authenticated,anon;`);
  for (const [name, id] of Object.entries(users)) {
    await db.query('insert into auth.users values($1,$2,now())', [
      id,
      `${name}@expense.example.test`,
    ]);
  }
  for (const migration of sql.slice(0, count)) await db.exec(migration);
  return db;
}
async function workspace(db, who = 'owner') {
  await asUser(db, users[who]);
  const w = (await call(db, 'bootstrap_workspace', { p_name: `Synthetic ${who}` })).id;
  const account = (
    await db.query("select * from public.cash_accounts where workspace_id=$1 and code='CASH'", [w])
  ).rows[0];
  await call(db, 'save_master', {
    p_kind: 'cash_accounts',
    p_payload: {
      workspace_id: w,
      id: account.id,
      code: account.code,
      name: account.name,
      opening_confirmed: true,
      opening_date: '2026-08-01',
      opening_balance: 0,
    },
  });
  return { w, account: account.id };
}
async function cash(db, f, category, direction = 'out', amount = 100, post = true) {
  const row = await call(db, 'create_cash', {
    p_payload: {
      workspace_id: f.w,
      account_id: f.account,
      transaction_date: '2026-08-18',
      category,
      direction,
      amount,
      description: `Synthetic ${category}`,
      notes: 'Synthetic document',
    },
  });
  if (post) await call(db, 'post_cash', { p_id: row.id, p_request_id: randomUUID() });
  return row;
}
async function categories(db, f) {
  return call(db, 'get_expense_categories', { p_workspace_id: f.w });
}
async function save(db, f, payload) {
  return call(db, 'save_expense_category', { p_workspace_id: f.w, p_payload: payload });
}
async function archive(db, f, id, archived) {
  return call(db, 'set_expense_category_archived', {
    p_workspace_id: f.w,
    p_id: id,
    p_archived: archived,
    p_reason: 'Synthetic category lifecycle reason',
  });
}
async function remove(db, f, id) {
  return call(db, 'delete_expense_category', {
    p_workspace_id: f.w,
    p_id: id,
    p_reason: 'Synthetic unused category removal',
  });
}
async function snapshot(db) {
  await db.exec('reset role');
  const result = {};
  for (const table of [
    'workspaces',
    'workspace_members',
    'cash_accounts',
    'cash_transactions',
    'cash_movements',
    'purchase_receipts',
    'stock_movements',
    'sales_orders',
    'sales_order_lines',
    'sales_events',
    'inventory_lots',
    'sales_allocations',
    'audit_events',
    'app_private.posting_requests',
  ]) {
    const relation = table.includes('.') ? table : `public.${table}`;
    result[table] = (
      await db.query(`select to_jsonb(t) row from ${relation} t order by to_jsonb(t)::text`)
    ).rows;
  }
  return result;
}
async function classification(db, f, id) {
  return (
    await db.query(
      'select * from public.cash_category_snapshots where workspace_id=$1 and cash_id=$2',
      [f.w, id],
    )
  ).rows[0];
}

try {
  const db = await setup(13);
  const f = await workspace(db);
  const oldCash = new Map();
  for (const [code, direction] of legacy) oldCash.set(code, await cash(db, f, code, direction));
  await call(db, 'reverse_document', {
    p_kind: 'cash',
    p_id: oldCash.get('packaging').id,
    p_request_id: randomUUID(),
    p_date: '2026-09-01',
    p_reason: 'Synthetic later period reversal',
  });
  const unknownDraft = await cash(db, f, 'unmapped_legacy', 'out', 200, false);
  const badDirection = await cash(db, f, 'packaging', 'in', 300, false);
  const ordinaryDraft = await cash(db, f, 'rent', 'out', 400, false);
  await db.exec('reset role');
  // Simulate pre-existing legacy anomalies, without weakening the public RPC.
  for (const row of [unknownDraft, badDirection]) {
    await db.query("update public.cash_transactions set status='posted' where id=$1", [row.id]);
    await db.query(
      `insert into public.cash_movements(workspace_id,cash_id,account_id,transaction_date,movement_kind,direction,amount,category)
      select workspace_id,id,account_id,transaction_date,'post',direction,amount,category from public.cash_transactions where id=$1`,
      [row.id],
    );
  }
  await asUser(db, users.owner);
  await cash(db, f, 'draft_unmapped', 'out', 800, false);
  // Also preserve a complete delivered order and its customer snapshot/FIFO facts.
  const supplier = await call(db, 'save_master', {
    p_kind: 'suppliers',
    p_payload: { workspace_id: f.w, code: 'S', name: 'Synthetic supplier' },
  });
  const product = await call(db, 'save_master', {
    p_kind: 'products',
    p_payload: {
      workspace_id: f.w,
      code: 'P',
      name: 'Synthetic product',
      unit_cost: 600000,
      provisional: false,
    },
  });
  const warehouseId = (
    await db.query('select id from public.warehouses where workspace_id=$1', [f.w])
  ).rows[0].id;
  const receipt = await call(db, 'create_purchase', {
    p_payload: {
      workspace_id: f.w,
      supplier_id: supplier.id,
      product_id: product.id,
      warehouse_id: warehouseId,
      received_date: '2026-08-01',
      qty: 10,
      unit_cost: 600000,
    },
  });
  await call(db, 'post_purchase', { p_id: receipt.id, p_request_id: randomUUID() });
  const customer = await call(db, 'save_customer', {
    p_workspace_id: f.w,
    p_payload: { code: 'C', name: 'Synthetic customer' },
  });
  const order = await call(db, 'save_sales_order', {
    p_workspace_id: f.w,
    p_payload: {
      code: 'SO',
      customer_id: customer,
      warehouse_id: warehouseId,
      order_date: '2026-08-02',
      lines: [{ product_id: product.id, qty: 10, unit_price: 1000000 }],
    },
  });
  for (const action of ['confirm', 'ship', 'deliver']) {
    await call(db, 'transition_sales_order', {
      p_workspace_id: f.w,
      p_order_id: order,
      p_action: action,
      p_payload: { date: '2026-08-03', carrier: 'Synthetic', tracking_number: 'TEST' },
      p_request_id: randomUUID(),
    });
  }
  const before = await snapshot(db);
  await check(
    '014 upgrades populated 001–013 without rewriting any document, ledger, FIFO, order snapshot or old audit',
    async () => {
      await db.exec(sql[13]);
      assert.deepEqual(await snapshot(db), before);
    },
  );
  await asUser(db, users.owner);
  await check(
    'Exact 14 legacy codes, directions and eligibility values are seeded, including payroll=false',
    async () => {
      const response = await categories(db, f);
      assert.deepEqual(
        response.categories.map((c) => [c.code, c.direction, c.profit_eligible]),
        legacy,
      );
      assert.ok(response.categories.every((c) => c.is_system && c.is_active));
      assert.deepEqual(response.reconciliation, {
        posted_document_count: 16,
        snapshot_count: 16,
        unknown_posted_count: 2,
        missing_snapshot_count: 0,
        unclassified_draft_count: 1,
        orphan_reversal_count: 0,
      });
    },
  );
  await check(
    'Original post classification is retained for reversed documents and unknown history is explicit',
    async () => {
      for (const [code, direction, eligible] of legacy) {
        const s = await classification(db, f, oldCash.get(code).id);
        assert.equal(s.code, code);
        assert.equal(s.direction, direction);
        assert.equal(s.profit_eligible, eligible);
        assert.equal(s.classification_source, 'legacy_v1');
      }
      for (const id of [unknownDraft.id, badDirection.id]) {
        const s = await classification(db, f, id);
        assert.equal(s.classification_source, 'legacy_unknown');
        assert.equal(s.category_id, null);
        assert.equal(s.name, null);
        assert.equal(s.profit_eligible, false);
      }
      assert.equal(await classification(db, f, ordinaryDraft.id), undefined);
    },
  );
  await check('Historical category totals and reversal dates reconcile exactly', async () => {
    const rows = (
      await db.query(
        `select m.transaction_date::text date,sum(-m.signed_amount)::text expense
      from public.cash_movements m join public.cash_category_snapshots s using(workspace_id,cash_id)
      where m.workspace_id=$1 and s.profit_eligible group by m.transaction_date order by m.transaction_date`,
        [f.w],
      )
    ).rows;
    assert.deepEqual(rows, [
      { date: '2026-08-18', expense: '700' },
      { date: '2026-09-01', expense: '-100' },
    ]);
    assert.equal(
      (await call(db, 'get_sales_state', { p_workspace_id: f.w })).summary.gross_profit,
      '4000000',
    );
  });
  let custom = await save(db, f, {
    code: 'office_supplies',
    name: 'Office supplies',
    profit_eligible: true,
    sort_order: 200,
  });
  const customCash = await cash(db, f, custom.code, 'out', 1000000);
  const frozenCustom = await classification(db, f, customCash.id);
  await check(
    'Custom categories post once through the original cash API and freeze classification atomically',
    async () => {
      assert.equal(frozenCustom.category_id, custom.id);
      assert.equal(frozenCustom.classification_source, 'posted');
      assert.equal(frozenCustom.profit_eligible, true);
      await call(db, 'post_cash', { p_id: customCash.id, p_request_id: randomUUID() });
      assert.equal(
        (
          await db.query('select count(*)::int n from public.cash_movements where cash_id=$1', [
            customCash.id,
          ])
        ).rows[0].n,
        1,
      );
      assert.deepEqual(await classification(db, f, customCash.id), frozenCustom);
    },
  );
  await check(
    'Rename and prospective eligibility changes never reclassify old postings or legacy payroll',
    async () => {
      custom = await save(db, f, {
        id: custom.id,
        name: 'Renamed office supplies',
        profit_eligible: false,
      });
      assert.deepEqual(await classification(db, f, customCash.id), frozenCustom);
      const next = await cash(db, f, custom.code);
      assert.equal((await classification(db, f, next.id)).profit_eligible, false);
      const payroll = (await categories(db, f)).categories.find((c) => c.code === 'payroll');
      await save(db, f, { id: payroll.id, name: payroll.name, profit_eligible: true });
      assert.equal((await classification(db, f, oldCash.get('payroll').id)).profit_eligible, false);
      assert.equal(
        (await classification(db, f, (await cash(db, f, 'payroll')).id)).profit_eligible,
        true,
      );
      await save(db, f, {
        code: 'unmapped_legacy',
        name: 'Now reviewed category',
        profit_eligible: true,
      });
      assert.equal(
        (await classification(db, f, unknownDraft.id)).classification_source,
        'legacy_unknown',
      );
    },
  );
  await check(
    'Archive blocks new posting, preserves idempotent replays and allows owner reversal with the frozen category',
    async () => {
      await archive(db, f, custom.id, true);
      const pending = await cash(db, f, custom.code, 'out', 100, false);
      await assert.rejects(
        () => call(db, 'post_cash', { p_id: pending.id, p_request_id: randomUUID() }),
        /EXPENSE_CATEGORY/,
      );
      assert.equal(await classification(db, f, pending.id), undefined);
      assert.equal(
        (
          await db.query('select count(*)::int n from public.cash_movements where cash_id=$1', [
            pending.id,
          ])
        ).rows[0].n,
        0,
      );
      await call(db, 'post_cash', { p_id: customCash.id, p_request_id: randomUUID() });
      await call(db, 'reverse_document', {
        p_kind: 'cash',
        p_id: customCash.id,
        p_request_id: randomUUID(),
        p_date: '2026-09-01',
        p_reason: 'Synthetic archived category reversal',
      });
      assert.deepEqual(await classification(db, f, customCash.id), frozenCustom);
      await archive(db, f, custom.id, false);
      await call(db, 'post_cash', { p_id: pending.id, p_request_id: randomUUID() });
    },
  );
  await check(
    'System deletion and deletion of any draft/history reference are blocked; unused custom deletion is audited',
    async () => {
      await assert.rejects(() => remove(db, f, custom.id), /EXPENSE_IN_USE/);
      const system = (await categories(db, f)).categories.find((c) => c.code === 'packaging');
      await assert.rejects(() => remove(db, f, system.id), /EXPENSE_SYSTEM/);
      const draftOnly = await save(db, f, { code: 'draft_category', name: 'Draft reference' });
      await cash(db, f, draftOnly.code, 'out', 100, false);
      await assert.rejects(() => remove(db, f, draftOnly.id), /EXPENSE_IN_USE/);
      const unused = await save(db, f, { code: 'unused_category', name: 'Unused' });
      assert.equal((await remove(db, f, unused.id)).deleted_id, unused.id);
      const audit = (
        await db.query(
          "select details from public.audit_events where entity_id=$1 and action='expense_category.deleted'",
          [unused.id],
        )
      ).rows[0];
      assert.equal(audit.details.before.code, unused.code);
      assert.ok(audit.details.reason.length >= 10);
    },
  );
  await check(
    'Excluded category kinds cannot become profit and identity/direction/classification changes are rejected',
    async () => {
      for (const kind of [
        'owner_capital',
        'owner_withdrawal',
        'transfer',
        'loan',
        'cod_settlement',
        'inventory_purchase',
        'customer_receipt',
        'other_receipt',
      ]) {
        await assert.rejects(
          () =>
            save(db, f, {
              code: `reject_${kind}`,
              name: kind,
              category_kind: kind,
              profit_eligible: true,
            }),
          /EXPENSE_CLASSIFICATION/,
        );
        const excluded = await save(db, f, {
          code: `exclude_${kind}`,
          name: kind,
          category_kind: kind,
        });
        assert.equal(
          (await classification(db, f, (await cash(db, f, excluded.code)).id)).profit_eligible,
          false,
        );
      }
      for (const payload of [{ code: 'changed' }, { direction: 'in' }, { category_kind: 'loan' }]) {
        await assert.rejects(
          () => save(db, f, { id: custom.id, name: custom.name, ...payload }),
          /EXPENSE_(CODE|KIND)_IMMUTABLE/,
        );
      }
      await assert.rejects(
        () => save(db, f, { code: 'Bad Code', name: 'Invalid' }),
        /EXPENSE_CODE/,
      );
      await assert.rejects(
        () => save(db, f, { code: 'invalid_bool', name: 'Invalid', profit_eligible: 'true' }),
        /true.*false/,
      );
      await assert.rejects(
        () => save(db, f, { code: 'invalid_sort', name: 'Invalid', sort_order: 1.5 }),
        /EXPENSE_SORT/,
      );
      await assert.rejects(
        () => save(db, f, { code: 'office_supplies', name: 'Duplicate' }),
        /unique|duplicate/i,
      );
    },
  );
  await check('Unknown, mismatched-direction and infinite-date drafts cannot post', async () => {
    for (const [code, direction] of [
      ['never_mapped', 'out'],
      ['capital', 'out'],
    ]) {
      const row = await cash(db, f, code, direction, 100, false);
      await assert.rejects(
        () => call(db, 'post_cash', { p_id: row.id, p_request_id: randomUUID() }),
        /EXPENSE_CATEGORY/,
      );
    }
    const row = await call(db, 'create_cash', {
      p_payload: {
        workspace_id: f.w,
        account_id: f.account,
        transaction_date: 'infinity',
        direction: 'out',
        category: 'rent',
        amount: 100,
      },
    });
    await assert.rejects(
      () => call(db, 'post_cash', { p_id: row.id, p_request_id: randomUUID() }),
      /ngày thu chi/,
    );
  });
  const other = await workspace(db, 'other');
  await check(
    'Workspace bootstrap seeds all categories and isolation applies to catalog and snapshots',
    async () => {
      assert.deepEqual(
        (await categories(db, other)).categories.map((c) => [
          c.code,
          c.direction,
          c.profit_eligible,
        ]),
        legacy,
      );
      await assert.rejects(() => categories(db, f), /quyền/);
      await assert.rejects(() => save(db, f, { code: 'cross', name: 'Cross workspace' }), /quyền/);
      await assert.rejects(
        () => save(db, other, { id: custom.id, name: 'Foreign row' }),
        /EXPENSE_NOT_FOUND/,
      );
      assert.equal(
        (await db.query('select * from public.expense_categories where workspace_id=$1', [f.w]))
          .rows.length,
        0,
      );
      assert.equal(
        (
          await db.query('select * from public.cash_category_snapshots where workspace_id=$1', [
            f.w,
          ])
        ).rows.length,
        0,
      );
      await assert.rejects(() => remove(db, other, custom.id), /EXPENSE_NOT_FOUND/);
      await assert.rejects(() => archive(db, other, custom.id, true), /EXPENSE_NOT_FOUND/);
    },
  );
  await db.exec('reset role');
  for (const role of ['manager', 'staff', 'viewer'])
    await db.query('insert into public.workspace_members values($1,$2,$3)', [
      f.w,
      users[role],
      role,
    ]);
  await check(
    'Existing role boundaries remain: everyone reads, manager maintains, staff drafts, owner deletes/reverses',
    async () => {
      for (const role of ['owner', 'manager', 'staff', 'viewer']) {
        await asUser(db, users[role]);
        assert.ok((await categories(db, f)).categories.length >= 14);
        await assert.rejects(
          () =>
            db.query("update public.expense_categories set name='bypass' where id=$1", [custom.id]),
          /permission denied/,
        );
        await assert.rejects(
          () =>
            db.query('delete from public.cash_category_snapshots where cash_id=$1', [
              customCash.id,
            ]),
          /permission denied/,
        );
        if (['staff', 'viewer'].includes(role)) {
          await assert.rejects(
            () => save(db, f, { code: `${role}_category`, name: 'Denied' }),
            /quyền/,
          );
          await assert.rejects(() => archive(db, f, custom.id, true), /quyền/);
        }
        if (role !== 'owner') await assert.rejects(() => remove(db, f, custom.id), /quyền/);
        if (role === 'manager') {
          const managed = await save(db, f, { code: 'manager_category', name: 'Managed' });
          await archive(db, f, managed.id, true);
          await archive(db, f, managed.id, false);
          await cash(db, f, managed.code);
        }
        if (role === 'staff') {
          const row = await cash(db, f, 'rent', 'out', 100, false);
          await assert.rejects(
            () => call(db, 'post_cash', { p_id: row.id, p_request_id: randomUUID() }),
            /quyền/,
          );
          await assert.rejects(
            () =>
              call(db, 'reverse_document', {
                p_kind: 'cash',
                p_id: oldCash.get('rent').id,
                p_request_id: randomUUID(),
                p_date: '2026-09-01',
                p_reason: 'Denied staff reversal',
              }),
            /quyền/,
          );
        }
        if (role === 'viewer')
          await assert.rejects(() => cash(db, f, 'rent', 'out', 100, false), /quyền/);
      }
    },
  );
  await check('Snapshot immutability also blocks privileged accidental changes', async () => {
    await db.exec('reset role');
    await assert.rejects(
      () =>
        db.query(
          'update public.cash_category_snapshots set profit_eligible=false where cash_id=$1',
          [customCash.id],
        ),
      /EXPENSE_SNAPSHOT_IMMUTABLE/,
    );
    await assert.rejects(
      () =>
        db.query('delete from public.cash_category_snapshots where cash_id=$1', [customCash.id]),
      /EXPENSE_SNAPSHOT_IMMUTABLE/,
    );
  });
  await check(
    'Catalog reads do not mutate history; oversized results fail closed rather than truncate',
    async () => {
      await asUser(db, users.owner);
      const baseline = await snapshot(db);
      await asUser(db, users.owner);
      await categories(db, f);
      await categories(db, f);
      assert.deepEqual(await snapshot(db), baseline);
      await db.query(
        `insert into public.expense_categories(workspace_id,code,name,direction,category_kind,created_by)
      select $1,'limit_'||n,'Synthetic limit','out','operating_expense',$2 from generate_series(1,5000) n`,
        [other.w, users.other],
      );
      await asUser(db, users.other);
      await assert.rejects(() => categories(db, other), /EXPENSE_RESULT_LIMIT/);
      await assert.rejects(
        () => save(db, other, { code: 'over_limit', name: 'Over limit' }),
        /EXPENSE_RESULT_LIMIT/,
      );
    },
  );
  await check('Anonymous, missing-subject and private helper access remain denied', async () => {
    await asUser(db, null);
    await assert.rejects(() => categories(db, f), /quyền/);
    await assert.rejects(() => save(db, f, { code: 'no_subject', name: 'Denied' }), /quyền/);
    await asUser(db, users.owner);
    await assert.rejects(
      () => db.query('select * from app_private.legacy_cash_categories()'),
      /permission denied/,
    );
    await db.exec('reset role; set role anon');
    await assert.rejects(() => categories(db, f), /permission denied/);
  });
  await check(
    'All new RPCs have fixed search paths and snapshots/catalog have RLS enabled',
    async () => {
      await db.exec('reset role');
      const routines = (
        await db.query(`select proname,prosecdef,proconfig from pg_proc where proname in
      ('get_expense_categories','save_expense_category','set_expense_category_archived','delete_expense_category')`)
      ).rows;
      assert.equal(routines.length, 4);
      assert.ok(routines.every((r) => r.prosecdef && r.proconfig.includes('search_path=""')));
      const tables = (
        await db.query(
          "select relrowsecurity from pg_class where oid in ('public.expense_categories'::regclass,'public.cash_category_snapshots'::regclass)",
        )
      ).rows;
      assert.ok(tables.every((t) => t.relrowsecurity));
    },
  );
  await check(
    'Fresh 001–014 install seeds new workspaces and posts eligible cash without any backfill',
    async () => {
      const clean = await setup(14);
      const fresh = await workspace(clean);
      assert.deepEqual(
        (await categories(clean, fresh)).categories.map((c) => [
          c.code,
          c.direction,
          c.profit_eligible,
        ]),
        legacy,
      );
      const row = await cash(clean, fresh, 'packaging', 'out', 1000000);
      assert.equal((await classification(clean, fresh, row.id)).profit_eligible, true);
      const counts = (await categories(clean, fresh)).reconciliation;
      assert.equal(counts.posted_document_count, counts.snapshot_count);
      assert.equal(counts.unknown_posted_count, 0);
      await clean.exec('reset role');
      await assert.rejects(() => clean.exec(sql[13]), /EXPENSE_ALREADY_INSTALLED/);
      await clean.exec('rollback');
    },
  );
  console.log(`\n${passed} expense category checks passed.`);
} finally {
  for (const db of opened) await db.close();
}
