// A1 diagnostic only: execute historical SQL unchanged in disposable PGlite databases.
// No .env, cloud connection, workbook or existing database is opened.
import { PGlite } from '@electric-sql/pglite';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { compareMetadata } from './lib/v2-metadata.mjs';

const files = ['001_core.sql', '002_operations.sql', '003_sales_inventory.sql'];
const migrations = await Promise.all(
  files.map(async (name) => {
    const bytes = await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url));
    return {
      name,
      sql: bytes.toString('utf8'),
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  }),
);
const owner = '11111111-1111-4111-8111-111111111111';
const outsider = '22222222-2222-4222-8222-222222222222';
const result = {
  checked_at: new Date().toISOString(),
  engine: 'PGlite PostgreSQL',
  cloud_tested: false,
  concurrent_connections_tested: false,
  migrations: migrations.map(({ name, sha256 }) => ({ name, sha256 })),
  checks: [],
};
function record(name, status, detail = '') {
  result.checks.push({ name, status, detail });
  console.log(`${status} ${name}${detail ? ': ' + detail : ''}`);
}
async function check(name, fn) {
  try {
    await fn();
    record(name, 'PASS');
  } catch (error) {
    record(name, 'FAIL', `${error.code || error.name}: ${error.message}`);
  }
}
async function rpc(db, name, args) {
  const keys = Object.keys(args);
  const { rows } = await db.query(
    `select public.${name}(${keys.map((k, i) => `${k}=>$${i + 1}`).join(',')}) as value`,
    Object.values(args).map((v) => (v && typeof v === 'object' ? JSON.stringify(v) : v)),
  );
  return rows[0].value;
}
async function user(db, id) {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
  await db.exec('set role authenticated');
}
async function setup() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
    $$;
    grant usage on schema auth to anon,authenticated;
    grant execute on function auth.uid() to anon,authenticated;
  `);
  for (const id of [owner, outsider])
    await db.query('insert into auth.users values($1,$2,now())', [id, `${id}@example.test`]);
  await db.exec(migrations[0].sql);
  await db.exec(migrations[1].sql);
  return db;
}

const clean = await setup();
try {
  let installed = false;
  await check('Unmodified 001 -> 002 -> 003 on empty business database', async () => {
    await clean.exec(migrations[2].sql);
    installed = true;
  });
  if (installed) {
    await check('Six V2 public tables enable RLS and deny direct writes', async () => {
      for (const table of [
        'customers',
        'sales_orders',
        'sales_order_lines',
        'sales_events',
        'inventory_lots',
        'sales_allocations',
      ]) {
        const { rows } = await clean.query(
          `select c.relrowsecurity as rls,
          has_table_privilege('authenticated',c.oid,'SELECT') as can_read,
          has_table_privilege('authenticated',c.oid,'INSERT,UPDATE,DELETE') as can_write,
          has_table_privilege('anon',c.oid,'SELECT') as anon_read
          from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=$1`,
          [table],
        );
        assert.deepEqual(rows, [{ rls: true, can_read: true, can_write: false, anon_read: false }]);
      }
    });
    await check('V2 read RPC, customer isolation, actor and audit on clean schema', async () => {
      await user(clean, owner);
      const workspace = await rpc(clean, 'bootstrap_workspace', { p_name: 'A1 disposable owner' });
      const customer = await rpc(clean, 'save_customer', {
        p_workspace_id: workspace.id,
        p_payload: { code: 'A1-KH', name: 'Synthetic customer', actor_id: outsider },
      });
      const state = await rpc(clean, 'get_sales_state', { p_workspace_id: workspace.id });
      assert.equal(state.customers[0].id, customer);
      assert.equal(state.customers[0].created_by, owner);
      assert.equal(state.summary.net_sales, '0');
      const audit = await clean.query(
        "select actor_id from public.audit_events where workspace_id=$1 and action='customer.saved'",
        [workspace.id],
      );
      assert.equal(audit.rows[0].actor_id, owner);
      await user(clean, outsider);
      await rpc(clean, 'bootstrap_workspace', { p_name: 'A1 disposable outsider' });
      assert.equal(
        (await clean.query('select id from public.customers where id=$1', [customer])).rows.length,
        0,
      );
      await assert.rejects(() => rpc(clean, 'get_sales_state', { p_workspace_id: workspace.id }));
      await assert.rejects(() =>
        rpc(clean, 'save_customer', {
          p_workspace_id: workspace.id,
          p_payload: { code: 'ILLEGAL', name: 'Denied' },
        }),
      );
      await clean.exec('reset role; set role anon');
      await assert.rejects(
        () => rpc(clean, 'get_sales_state', { p_workspace_id: workspace.id }),
        (error) => error.code === '42501',
      );
    });
    await check('Operator metadata SQL runs in a read-only transaction', async () => {
      await clean.exec('reset role');
      const sql = await readFile(
        new URL('../supabase/verification/verify_v2_baseline.sql', import.meta.url),
        'utf8',
      );
      const metadata = await clean.exec(sql);
      const snapshot = metadata.find((r) => r.rows[0]?.v2_baseline)?.rows[0].v2_baseline;
      assert.equal(snapshot?.format_version, 1);
      assert.equal(snapshot.tables.length, 8);
      assert.equal(snapshot.routines.length, 10);
      assert.ok(snapshot.tables.every((r) => r.present));
      assert.ok(snapshot.routines.every((r) => r.present));
      assert.equal(snapshot.policies.length, 6);
      assert.ok(snapshot.columns.length > 50);
      assert.ok(snapshot.constraints.length > 20);
      result.local_metadata = snapshot;
    });
    await check(
      'Catalog comparison detects column-only grants and unsafe RPC settings',
      async () => {
        const sql = await readFile(
          new URL('../supabase/verification/verify_v2_baseline.sql', import.meta.url),
          'utf8',
        );
        const snapshot = async () =>
          (await clean.exec(sql)).find((r) => r.rows[0]?.v2_baseline).rows[0].v2_baseline;
        // Changes exist only in this disposable local database, never in migration files.
        await clean.exec('grant update(name) on public.customers to authenticated');
        const grantState = await snapshot();
        const table = grantState.tables.find((t) => t.table_name === 'customers');
        assert.equal(table.authenticated_write, false);
        assert.equal(table.authenticated_column_write, true);
        assert.equal(compareMetadata(result.local_metadata, grantState).status, 'BLOCKED');
        await clean.exec('revoke update(name) on public.customers from authenticated');
        await clean.exec("alter function public.get_sales_state(uuid) set search_path='public'");
        assert.equal(compareMetadata(result.local_metadata, await snapshot()).status, 'BLOCKED');
        await clean.exec("alter function public.get_sales_state(uuid) set search_path=''");
        assert.equal(compareMetadata(result.local_metadata, await snapshot()).status, 'PASS');
      },
    );
  }
} finally {
  await clean.close();
}

const populated = await setup();
try {
  await user(populated, owner);
  const workspace = await rpc(populated, 'bootstrap_workspace', { p_name: 'A1 populated upgrade' });
  const supplier = await rpc(populated, 'save_master', {
    p_kind: 'suppliers',
    p_payload: { workspace_id: workspace.id, code: 'A1-NCC', name: 'Synthetic supplier' },
  });
  const product = await rpc(populated, 'save_master', {
    p_kind: 'products',
    p_payload: {
      workspace_id: workspace.id,
      code: 'A1-SKU',
      name: 'Synthetic SKU',
      supplier_id: supplier.id,
      unit_cost: 80000,
      provisional: false,
    },
  });
  const warehouse = (
    await populated.query('select id from public.warehouses where workspace_id=$1', [workspace.id])
  ).rows[0].id;
  for (const [received_date, unit_cost] of [
    ['2026-08-01', 80000],
    ['2026-08-02', 90000],
  ]) {
    const receipt = await rpc(populated, 'create_purchase', {
      p_payload: {
        workspace_id: workspace.id,
        supplier_id: supplier.id,
        product_id: product.id,
        warehouse_id: warehouse,
        received_date,
        date_estimated: false,
        qty: 5,
        unit_cost,
        additional_cost: 0,
      },
    });
    await rpc(populated, 'post_purchase', { p_id: receipt.id, p_request_id: randomUUID() });
  }
  await populated.exec('reset role');
  const before = (
    await populated.query('select to_jsonb(m) as row from public.stock_movements m order by id')
  ).rows;
  let failed = false;
  await check('Unmodified 003 upgrade preserves two posted V1 receipts', async () => {
    try {
      await populated.exec(migrations[2].sql);
    } catch (error) {
      failed = true;
      await populated.exec('rollback');
      throw error;
    }
    const { rows } = await populated.query(
      'select sum(remaining_qty)::text as qty,sum(remaining_cost)::text as cost from public.inventory_lots',
    );
    assert.deepEqual(rows, [{ qty: '10', cost: '850000' }]);
  });
  await check(
    'Populated upgrade failure rolls back schema and preserves original ledger',
    async () => {
      assert.deepEqual(
        (
          await populated.query(
            'select to_jsonb(m) as row from public.stock_movements m order by id',
          )
        ).rows,
        before,
      );
      if (failed) {
        const { rows } = await populated.query(
          "select to_regclass('public.inventory_lots') as lots,to_regprocedure('public.post_purchase(uuid,uuid)')::text as post",
        );
        assert.equal(rows[0].lots, null);
        assert.equal(rows[0].post, 'post_purchase(uuid,uuid)');
      }
    },
  );
} finally {
  await populated.close();
}

await check('Historical SQL bytes unchanged by diagnostic', async () => {
  for (const { name, sha256 } of migrations) {
    const bytes = await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), sha256);
  }
});
result.status = result.checks.some((c) => c.status === 'FAIL') ? 'BLOCKED' : 'PASS';
await mkdir(new URL('../test-results/', import.meta.url), { recursive: true });
await writeFile(
  new URL('../test-results/v2-baseline.json', import.meta.url),
  JSON.stringify(result, null, 2) + '\n',
);
// Durable local evidence: Playwright recreates test-results during regression.
await mkdir(new URL('../.tools/a1/', import.meta.url), { recursive: true });
await writeFile(
  new URL('../.tools/a1/v2-baseline.json', import.meta.url),
  JSON.stringify(result, null, 2) + '\n',
);
console.log(
  `Baseline ${result.status}: ${result.checks.filter((c) => c.status === 'PASS').length} PASS, ${result.checks.filter((c) => c.status === 'FAIL').length} FAIL`,
);
if (result.status === 'BLOCKED') process.exitCode = 1;
