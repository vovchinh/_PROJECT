import { PGlite } from '@electric-sql/pglite';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';

const db = new PGlite();
let checks = 0;
const awaitedMigration = await readFile(
  new URL('../supabase/migrations/001_core.sql', import.meta.url),
  'utf8',
);
const a = '11111111-1111-4111-8111-111111111111',
  b = '22222222-2222-4222-8222-222222222222',
  staff = '33333333-3333-4333-8333-333333333333';
async function ok(name, fn) {
  await fn();
  checks++;
  console.log('PASS', name);
}
async function fail(sql, params = []) {
  await assert.rejects(() => db.query(sql, params));
}
async function user(id) {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
  await db.exec('set role authenticated');
}
async function rpc(name, args) {
  const keys = Object.keys(args);
  const result = await db.query(
    `select public.${name}(${keys.map((k, i) => `${k}=>$${i + 1}`).join(',')}) as result`,
    Object.values(args).map((v) => (typeof v === 'object' ? JSON.stringify(v) : v)),
  );
  return result.rows[0].result;
}
try {
  await db.exec(
    `create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);insert into auth.users values('${a}'),('${b}'),('${staff}');create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated,anon;grant execute on function auth.uid() to authenticated,anon;`,
  );
  await ok('Migration executes on PostgreSQL engine', () => db.exec(awaitedMigration));
  await user(a);
  const w = await rpc('bootstrap_workspace', { p_name: 'ChiDi QA' });
  await ok('Bootstrap replay reuses owner workspace', async () =>
    assert.equal((await rpc('bootstrap_workspace', { p_name: 'Again' })).id, w.id),
  );
  const sup = await rpc('save_master', {
    p_kind: 'suppliers',
    p_payload: { workspace_id: w.id, code: 'SUP-A', name: 'NCC A' },
  });
  const product = await rpc('save_master', {
    p_kind: 'products',
    p_payload: {
      workspace_id: w.id,
      code: 'SKU-A',
      name: 'Jean A',
      supplier_id: sup.id,
      unit_cost: 45000,
      provisional: true,
    },
  });
  const warehouse = (
    await db.query('select id from public.warehouses where workspace_id=$1', [w.id])
  ).rows[0].id;
  const base = {
    workspace_id: w.id,
    supplier_id: sup.id,
    product_id: product.id,
    warehouse_id: warehouse,
    received_date: '2026-08-18',
    date_estimated: true,
    qty: 10,
    unit_cost: 45000,
    additional_cost: 0,
  };
  const purchase = await rpc('create_purchase', { p_payload: base });
  await ok('Draft purchase generates zero ledger rows', async () =>
    assert.equal(
      (await db.query('select count(*)::int n from public.stock_movements')).rows[0].n,
      0,
    ),
  );
  await ok('Estimated date blocks purchase posting', () =>
    assert.rejects(() =>
      rpc('post_purchase', { p_id: purchase.id, p_request_id: crypto.randomUUID() }),
    ),
  );
  await rpc('create_purchase', { p_payload: { ...base, id: purchase.id, date_estimated: false } });
  await ok('Provisional SKU blocks purchase posting', () =>
    assert.rejects(() =>
      rpc('post_purchase', { p_id: purchase.id, p_request_id: crypto.randomUUID() }),
    ),
  );
  await rpc('save_master', { p_kind: 'products', p_payload: { ...product, provisional: false } });
  const request = crypto.randomUUID();
  await rpc('post_purchase', { p_id: purchase.id, p_request_id: request });
  await rpc('post_purchase', { p_id: purchase.id, p_request_id: request });
  await ok('Posting twice produces one exact stock movement', async () => {
    const r = (
      await db.query(
        'select count(*)::int n,sum(qty)::int q,sum(amount)::text a from public.stock_movements',
      )
    ).rows[0];
    assert.deepEqual(r, { n: 1, q: 10, a: '450000' });
  });
  await ok('Posted source cannot be edited', () =>
    assert.rejects(() =>
      rpc('create_purchase', { p_payload: { ...base, id: purchase.id, qty: 50 } }),
    ),
  );
  await ok('Fractional VND rejected', () =>
    assert.rejects(() => rpc('create_purchase', { p_payload: { ...base, unit_cost: 1.5 } })),
  );
  const acc = (
    await db.query("select * from public.cash_accounts where workspace_id=$1 and code='CASH'", [
      w.id,
    ])
  ).rows[0];
  const cash = await rpc('create_cash', {
    p_payload: {
      workspace_id: w.id,
      account_id: acc.id,
      direction: 'out',
      transaction_date: '2026-08-18',
      date_estimated: false,
      category: 'packaging',
      amount: 264000,
      description: 'Bao bì QA',
    },
  });
  await ok('Unknown opening balance blocks cash posting', () =>
    assert.rejects(() => rpc('post_cash', { p_id: cash.id, p_request_id: crypto.randomUUID() })),
  );
  await rpc('save_master', {
    p_kind: 'cash_accounts',
    p_payload: {
      ...acc,
      opening_balance: 1000000,
      opening_date: '2026-08-01',
      opening_confirmed: true,
    },
  });
  await rpc('post_cash', { p_id: cash.id, p_request_id: crypto.randomUUID() });
  await rpc('post_cash', { p_id: cash.id, p_request_id: crypto.randomUUID() });
  await ok('Posted cash exactly once', async () =>
    assert.deepEqual(
      (
        await db.query(
          'select count(*)::int n,sum(signed_amount)::text a from public.cash_movements',
        )
      ).rows[0],
      { n: 1, a: '-264000' },
    ),
  );
  await ok('Opening balance immutable after posting', () =>
    assert.rejects(() =>
      rpc('save_master', {
        p_kind: 'cash_accounts',
        p_payload: {
          ...acc,
          opening_balance: 999,
          opening_date: '2026-08-01',
          opening_confirmed: true,
        },
      }),
    ),
  );
  await ok('Direct ledger writes denied', () =>
    fail('insert into public.stock_movements(workspace_id) values($1)', [w.id]),
  );
  await ok('Direct draft writes denied', () =>
    fail('update public.purchase_receipts set qty=99 where id=$1', [purchase.id]),
  );
  await ok('Audit deletion denied', () => fail('delete from public.audit_events'));
  await user(b);
  const wb = await rpc('bootstrap_workspace', { p_name: 'Other tenant' });
  await ok('Cross-tenant rows invisible', async () =>
    assert.equal(
      (await db.query('select * from public.purchase_receipts where workspace_id=$1', [w.id])).rows
        .length,
      0,
    ),
  );
  await ok('Cross-tenant RPC authorization enforced', () =>
    assert.rejects(() =>
      rpc('post_purchase', { p_id: purchase.id, p_request_id: crypto.randomUUID() }),
    ),
  );
  await ok('Composite tenant foreign keys enforced', () =>
    assert.rejects(() => rpc('create_purchase', { p_payload: { ...base, workspace_id: wb.id } })),
  );
  await db.exec('reset role');
  await db.query('insert into public.workspace_members values($1,$2,$3)', [w.id, staff, 'staff']);
  await user(staff);
  await ok('Staff cannot post', () =>
    assert.rejects(() => rpc('post_cash', { p_id: cash.id, p_request_id: crypto.randomUUID() })),
  );
  await ok('Staff cannot set account opening', () =>
    assert.rejects(() =>
      rpc('save_master', {
        p_kind: 'cash_accounts',
        p_payload: { ...acc, opening_date: '2026-08-01' },
      }),
    ),
  );
  await user(a);
  const payload = {
    workspace_id: w.id,
    source_id: 'a'.repeat(64),
    source_name: 'QA only',
    suppliers: [{ code: 'SUP-A', name: 'NCC A' }],
    products: [{ code: 'SKU-A', name: 'Jean A', unit_cost: 45000 }],
    purchases: [
      {
        legacy_id: 'LEG-P1',
        supplier_code: 'SUP-A',
        product_code: 'SKU-A',
        qty: 2,
        unit_cost: 45000,
        received_date: '2026-08-04',
        date_estimated: true,
        source_status: 'posted',
      },
    ],
    cash: [
      {
        legacy_id: 'LEG-C1',
        direction: 'out',
        category: 'packaging',
        amount: 10000,
        source_status: 'posted',
      },
    ],
  };
  await rpc('import_legacy', { p_payload: payload });
  await rpc('import_legacy', { p_payload: payload });
  await ok('Import keeps source posted claims in draft and is idempotent', async () => {
    const rows = (
      await db.query(
        "select status,provenance from public.purchase_receipts where legacy_id='LEG-P1'",
      )
    ).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'draft');
    assert.equal(rows[0].provenance.source_status, 'posted');
  });
  const repeat = await rpc('import_legacy', {
    p_payload: { ...payload, source_id: 'b'.repeat(64) },
  });
  await ok('Changed file hash never duplicates stable legacy IDs', async () => {
    assert.equal(repeat.skipped, 2);
    assert.equal(repeat.inserted_purchases, 0);
    assert.equal(repeat.conflicts.length, 0);
  });
  const changed = await rpc('import_legacy', {
    p_payload: {
      ...payload,
      source_id: 'c'.repeat(64),
      cash: [{ ...payload.cash[0], amount: 20000 }],
    },
  });
  await ok('Changed source amount is flagged without overwriting', async () => {
    assert.equal(changed.conflicts.length, 1);
    assert.equal(
      Number(
        (await db.query("select amount from public.cash_transactions where legacy_id='LEG-C1'"))
          .rows[0].amount,
      ),
      10000,
    );
  });
  await rpc('reverse_document', {
    p_kind: 'cash',
    p_id: cash.id,
    p_request_id: crypto.randomUUID(),
    p_date: '2026-08-19',
    p_reason: 'Điều chỉnh chứng từ thử sai',
  });
  await ok('Cash reversal appends compensating movement', async () =>
    assert.equal(
      (await db.query('select sum(signed_amount)::text a from public.cash_movements')).rows[0].a,
      '0',
    ),
  );
  await rpc('reverse_document', {
    p_kind: 'purchase',
    p_id: purchase.id,
    p_request_id: crypto.randomUUID(),
    p_date: '2026-08-19',
    p_reason: 'Điều chỉnh chứng từ thử sai',
  });
  await ok('Stock reversal preserves original and nets to zero', async () => {
    const r = (
      await db.query(
        'select count(*)::int n,sum(qty)::int q,sum(amount)::text a from public.stock_movements',
      )
    ).rows[0];
    assert.deepEqual(r, { n: 2, q: 0, a: '0' });
  });
  await db.exec('reset role');
  await db.exec('set role anon');
  await ok('Anonymous RPC execution denied', () =>
    assert.rejects(() => rpc('bootstrap_workspace', { p_name: 'Intruder' })),
  );
  await mkdir('test-results', { recursive: true });
  await writeFile(
    'test-results/database.json',
    JSON.stringify(
      {
        status: 'PASS',
        checks,
        engine:
          'PGlite PostgreSQL WASM, mocked Supabase auth.uid; live cloud still requires connection verification',
      },
      null,
      2,
    ),
  );
  console.log(`Database: ${checks}/${checks} PASS`);
} finally {
  await db.close();
}
