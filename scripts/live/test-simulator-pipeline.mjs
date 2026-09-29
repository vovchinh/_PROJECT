// Real worker + real PostgreSQL engine; synthetic auth/provider only.
// This is NOT a cloud Realtime or real TikTok acceptance test.
import assert from 'node:assert/strict';
import { readFile, readdir, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { runWorker } from '../../services/live-bridge/intake-worker.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const parent = resolve(root, '.tools/live-simulator');
await mkdir(parent, { recursive: true });
const temporary = await mkdtemp(resolve(parent, 'run-'));
const db = new PGlite();
const checks = [];
const actor = randomUUID();
let scope,
  session,
  loseAck = false;
const rpc = async (name, args) => {
  assert.match(name, /^[a-z_]+$/u);
  const keys = Object.keys(args);
  for (const key of keys) assert.match(key, /^p_[a-z_]+$/u);
  return (
    await db.query(
      `select public.${name}(${keys.map((key, i) => `${key}=>$${i + 1}`).join(',')}) as result`,
      Object.values(args).map((value) =>
        value !== null && typeof value === 'object' ? JSON.stringify(value) : value,
      ),
    )
  ).rows[0].result;
};
const workerClient = {
  rpc: async (name, args) => {
    assert.ok(
      [
        'get_live_intake',
        'report_live_connection',
        'ingest_live_comments',
        'ingest_live_events',
        'get_live_runtime',
      ].includes(name),
    );
    assert.equal(args.p_workspace_id, scope);
    assert.equal(args.p_session_id, session);
    const result = await rpc(name, args);
    if (loseAck && name === 'ingest_live_events') {
      loseAck = false;
      throw Error('SYNTHETIC_RESPONSE_LOST_AFTER_COMMIT');
    }
    return result;
  },
};
const protectedTables = [
  'stock_movements',
  'cash_movements',
  'inventory_reservations',
  'sales_orders',
  'live_sale_tickets',
  'live_campaign_customers',
  'customer_carts',
  'customer_cart_items',
  'live_print_jobs',
];
const snapshot = async () => {
  const output = {};
  await db.exec('reset role');
  try {
    for (const table of protectedTables)
      output[table] = (
        await db.query(
          `select to_jsonb(t) as value from public.${table} t order by to_jsonb(t)::text`,
        )
      ).rows;
  } finally {
    await db.exec('set role authenticated');
  }
  return output;
};
async function check(name, action) {
  try {
    await action();
    checks.push({ name, status: 'PASS' });
    console.log('PASS', name);
  } catch (failure) {
    checks.push({ name, status: 'FAIL', detail: failure.message });
    throw failure;
  }
}
const fixture = resolve(temporary, 'events.ndjson');
const run = () =>
  runWorker(
    {
      LIVE_SOURCE: 'ndjson',
      LIVE_WORKSPACE_ID: scope,
      LIVE_SESSION_ID: session,
      LIVE_FIXTURE_FILE: fixture,
    },
    { client: workerClient, stateDir: temporary },
  );
const state = () => rpc('get_live_runtime', { p_workspace_id: scope, p_session_id: session });
const put = (events) =>
  writeFile(fixture, events.map((row) => JSON.stringify(row)).join('\n') + '\n');

try {
  await db.exec(`create role anon;create role authenticated;create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to authenticated,anon;grant execute on function auth.uid() to authenticated,anon;`);
  await db.query('insert into auth.users values($1,$2,now())', [actor, 'simulator@synthetic.test']);
  const migrations = (await readdir(resolve(root, 'supabase/migrations')))
    .filter((name) => /^(00[1-9]|01[0-2])_.*\.sql$/u.test(name))
    .sort();
  assert.equal(migrations.length, 12);
  for (const name of migrations)
    await db.exec(await readFile(resolve(root, 'supabase/migrations', name), 'utf8'));
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [actor]);
  await db.exec('set role authenticated');
  scope = (await rpc('bootstrap_workspace', { p_name: 'Disposable simulator integration' })).id;
  const warehouse = (
    await db.query('select id from public.warehouses where workspace_id=$1', [scope])
  ).rows[0].id;
  const campaign = await rpc('save_live_campaign', {
    p_workspace_id: scope,
    p_payload: {
      code: 'SIMULATOR',
      name: 'Synthetic campaign',
      warehouse_id: warehouse,
      status: 'active',
    },
  });
  session = await rpc('save_live_session', {
    p_workspace_id: scope,
    p_payload: {
      code: 'SIMULATOR-ONE',
      campaign_id: campaign,
      title: 'Synthetic session',
      provider: 'simulator',
      status: 'live',
      room_id: '',
    },
  });
  const before = await snapshot();
  const occurred = new Date(Date.now() - 10000).toISOString();
  const comment = {
    type: 'COMMENT',
    message_id: '9007199254740993111',
    author_external_id: '9007199254740993222',
    author_display_name: 'Khách mô phỏng',
    text: 'AO-01 2c',
    occurred_at: occurred,
  };
  const viewer = {
    type: 'VIEWER_COUNT',
    event_id: '9007199254740993333',
    occurred_at: occurred,
    viewer_count: 0,
  };
  const member = { type: 'MEMBER_JOIN', event_id: '9007199254740993444', occurred_at: occurred };
  await check('Unknown viewers stay null before provider observations', async () => {
    const result = await state();
    assert.equal(result.telemetry?.current_viewer_count ?? null, null);
  });
  await check(
    'Simulator COMMENT + VIEWER_COUNT + MEMBER_JOIN traverse real worker and PostgreSQL RPC',
    async () => {
      await put([comment, viewer, member]);
      await run();
      const intake = await rpc('get_live_intake', { p_workspace_id: scope, p_session_id: session });
      assert.equal(intake.comments.length, 1);
      assert.equal(intake.comments[0].provider_message_id, comment.message_id);
      assert.equal(intake.comments[0].author_external_id, comment.author_external_id);
      const result = await state();
      assert.equal(result.telemetry.current_viewer_count, 0);
      assert.equal(result.telemetry.peak_viewer_count, 0);
      assert.equal(Number(result.telemetry.member_event_count), 1);
    },
  );
  await check('Restart and replay do not duplicate comments or member observations', async () => {
    await run();
    const intake = await rpc('get_live_intake', { p_workspace_id: scope, p_session_id: session });
    assert.equal(intake.comments.length, 1);
    assert.equal(Number((await state()).telemetry.member_event_count), 1);
  });
  await check('Viewer-only event updates current and peak without inventing comments', async () => {
    await put([
      {
        ...viewer,
        event_id: '9007199254740993555',
        occurred_at: new Date(Date.now() - 5000).toISOString(),
        viewer_count: 17,
      },
    ]);
    await run();
    const result = await state();
    assert.equal(result.telemetry.current_viewer_count, 17);
    assert.equal(result.telemetry.peak_viewer_count, 17);
    assert.equal(
      (await rpc('get_live_intake', { p_workspace_id: scope, p_session_id: session })).comments
        .length,
      1,
    );
  });
  await check(
    'Lost ACK retains the queue; restart reconciles an already committed telemetry event',
    async () => {
      await put([{ ...member, event_id: '9007199254740993666' }]);
      loseAck = true;
      await assert.rejects(run(), /SYNTHETIC_RESPONSE_LOST_AFTER_COMMIT/u);
      await run();
      assert.equal(Number((await state()).telemetry.member_event_count), 2);
    },
  );
  await check(
    'Raw observations have no ticket, STT, print, reservation, stock or cash effect',
    async () => {
      assert.deepEqual(await snapshot(), before);
    },
  );
} finally {
  await mkdir(resolve(root, 'test-results'), { recursive: true });
  await writeFile(
    resolve(root, 'test-results/live-simulator-pipeline.json'),
    JSON.stringify(
      {
        checked_at: new Date().toISOString(),
        environment: 'disposable-local-PGlite',
        cloud_mutations: false,
        realtime_tested: false,
        real_tiktok_tested: false,
        checks,
      },
      null,
      2,
    ),
  );
  await db.close();
  // Delete only the exact temporary run created by this invocation.
  const target = resolve(temporary);
  assert.ok(target.startsWith(parent + sep + 'run-') && target !== parent);
  await rm(target, { recursive: true, force: true });
}
