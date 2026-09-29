// Isolated synthetic PostgreSQL/PGlite only. No .env, provider or cloud I/O.
import { PGlite } from '@electric-sql/pglite';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID as uuid, createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const directory = new URL('../supabase/migrations/', import.meta.url);
const names = (await readdir(directory))
  .filter((n) => /^(00[1-9]|01[0-2])_.*\.sql$/u.test(n))
  .sort();
assert.equal(names.length, 12);
const migrations = await Promise.all(
  names.map(async (name) => {
    const sql = await readFile(new URL(name, directory), 'utf8');
    assert.match(sql.trim(), /commit;$/iu);
    return { name, sql, sha256: createHash('sha256').update(sql).digest('hex') };
  }),
);
const auth = `create role anon;create role authenticated;create schema auth;
create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema auth to authenticated,anon;grant execute on function auth.uid() to authenticated,anon;`;
const db = new PGlite();
const verification = await readFile(
  new URL('../supabase/verification/verify_live_runtime.sql', import.meta.url),
  'utf8',
);
const verificationQuery = verification
  .replace(/^begin transaction isolation level repeatable read read only;\s*$/gimu, '')
  .replace(/^commit;\s*$/gimu, '');
const checks = [];
const users = Object.fromEntries(
  ['owner', 'manager', 'staff', 'viewer', 'other'].map((name) => [name, uuid()]),
);
let actor = users.owner,
  w,
  foreignW,
  warehouse,
  product,
  ctx,
  sim,
  manual,
  foreignSession,
  initialTicket;
const instance = uuid(),
  otherInstance = uuid();
const instant = (offset = 0) => new Date(Date.now() - 120000 + offset).toISOString();
const baseTime = instant();
const time = (offset = 0) => new Date(Date.parse(baseTime) + offset).toISOString();
const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date());
const businessTables = [
  'products',
  'purchase_receipts',
  'stock_movements',
  'inventory_lots',
  'inventory_reservations',
  'reservation_lots',
  'sales_allocations',
  'sales_orders',
  'sales_order_lines',
  'sales_events',
  'cash_transactions',
  'cash_movements',
  'live_sale_tickets',
  'live_campaign_customers',
  'customer_carts',
  'customer_cart_items',
  'live_print_jobs',
  'live_print_attempts',
  'live_outbox_events',
];
async function check(name, action) {
  try {
    await action();
    checks.push({ name, status: 'PASS' });
    console.log('PASS', name);
  } catch (error) {
    checks.push({ name, status: 'FAIL', code: error.code, detail: error.message });
    throw error;
  }
}
async function user(id = users.owner) {
  actor = id;
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id || '']);
  await db.exec('set role authenticated');
}
async function admin(action) {
  const previous = actor;
  await db.exec('reset role');
  try {
    return await action();
  } finally {
    await user(previous);
  }
}
async function rpc(name, args) {
  return (
    await db.query(
      `select public.${name}(${Object.keys(args)
        .map((key, i) => `${key}=>$${i + 1}`)
        .join(',')}) result`,
      Object.values(args).map((value) =>
        value !== null && typeof value === 'object' ? JSON.stringify(value) : value,
      ),
    )
  ).rows[0].result;
}
async function snapshot(tables = businessTables, schema = 'public') {
  return admin(async () =>
    Object.fromEntries(
      await Promise.all(
        tables.map(async (table) => [
          table,
          (
            await db.query(
              `select to_jsonb(t) row from ${schema}.${table} t order by to_jsonb(t)::text`,
            )
          ).rows.map((r) => r.row),
        ]),
      ),
    ),
  );
}
const runtime = (session = null, workspace = w) =>
  rpc('get_live_runtime', { p_workspace_id: workspace, p_session_id: session });
const health = (payload = {}, id = instance, workspace = w) =>
  rpc('report_live_listener_health', {
    p_workspace_id: workspace,
    p_instance_id: id,
    p_payload: {
      ready: true,
      provider_version: '2.5.0',
      active_listener_count: 1,
      last_error_code: null,
      ...payload,
    },
  });
const event = (type = 'VIEWER_COUNT', id = uuid(), at = baseTime, viewers = 0) => ({
  type,
  event_id: id,
  occurred_at: at,
  ...(type === 'VIEWER_COUNT' ? { viewer_count: viewers } : {}),
});
const events = (batch, session = sim, workspace = w) =>
  rpc('ingest_live_events', { p_workspace_id: workspace, p_session_id: session, p_events: batch });
const tiktokArgs = (batch) => ({
  p_workspace_id: w,
  p_channel_id: ctx.id,
  p_revision: ctx.revision,
  p_lease_token: ctx.token,
  p_session_id: ctx.session,
  p_events: batch,
});
const tiktok = (batch, overrides = {}) =>
  rpc('ingest_tiktok_events', { ...tiktokArgs(batch), ...overrides });
const connect = (id, desired = 'connected') =>
  rpc('request_tiktok_connection', {
    p_workspace_id: w,
    p_channel_id: id,
    p_desired_state: desired,
    p_request_id: uuid(),
  });
async function live(username) {
  const id = await rpc('save_tiktok_channel', {
    p_workspace_id: w,
    p_payload: { username },
    p_request_id: uuid(),
  });
  const requested = await connect(id);
  const lease = await rpc('claim_tiktok_connection', {
    p_workspace_id: w,
    p_channel_id: id,
    p_revision: requested.revision,
  });
  const result = await rpc('report_tiktok_connection', {
    p_workspace_id: w,
    p_channel_id: id,
    p_revision: requested.revision,
    p_lease_token: lease.lease_token,
    p_status: 'live',
    p_provider_room_id: `room-${id}`,
  });
  return { id, revision: requested.revision, token: lease.lease_token, session: result.session_id };
}
async function localSession(provider = 'simulator', workspace = w, wh = warehouse) {
  const campaign = await rpc('save_live_campaign', {
    p_workspace_id: workspace,
    p_payload: { code: `CP-${uuid()}`, name: 'Phiên kiểm thử', warehouse_id: wh, status: 'active' },
  });
  return rpc('save_live_session', {
    p_workspace_id: workspace,
    p_payload: {
      campaign_id: campaign,
      code: `S-${uuid()}`,
      title: 'Runtime tổng hợp',
      provider,
      status: 'live',
    },
  });
}
async function ingestComment(session, id = uuid(), isTikTok = false) {
  const comments = [
    {
      message_id: id,
      author_external_id: 'synthetic-buyer',
      author_display_name: 'Khách kiểm tra',
      text: '49 xanh M 1c',
      occurred_at: new Date().toISOString(),
    },
  ];
  return isTikTok
    ? rpc('ingest_tiktok_comments', {
        p_workspace_id: w,
        p_channel_id: ctx.id,
        p_revision: ctx.revision,
        p_lease_token: ctx.token,
        p_session_id: session,
        p_comments: comments,
      })
    : rpc('ingest_live_comments', {
        p_workspace_id: w,
        p_session_id: session,
        p_comments: comments,
      });
}
async function observationSnapshot() {
  return {
    public: await snapshot(['live_listener_health', 'live_session_telemetry']),
    keys: await snapshot(['live_runtime_event_keys'], 'app_private'),
  };
}
async function rejectUnchanged(action, pattern) {
  const before = await observationSnapshot();
  await assert.rejects(action, pattern);
  assert.deepEqual(await observationSnapshot(), before);
}
async function verify(sql = verification) {
  const rows = (await db.exec(sql))
    .flatMap((result) => result.rows)
    .filter((row) => row.live_runtime_verification);
  assert.equal(rows.length, 1);
  return rows[0].live_runtime_verification;
}
function healthy(result) {
  assert.equal(result.status, 'PASS', JSON.stringify(result));
  assert.equal(result.failed_checks, 0);
}
async function corrupt(action, group, key) {
  await admin(async () => {
    await db.exec('begin');
    try {
      await action();
      const result = await verify(verificationQuery);
      assert.equal(result.status, 'FAIL');
      assert.ok(result[group][key] > 0, `${group}.${key} must detect fixture corruption`);
    } finally {
      await db.exec('rollback');
    }
  });
  healthy(await admin(() => verify()));
}

try {
  await check('012 preflight fails atomically when 010/011 prerequisites are absent', async () => {
    const empty = new PGlite();
    try {
      await assert.rejects(() => empty.exec(migrations[11].sql), /LIVE_RUNTIME_PREREQUISITE/);
      await empty.exec('rollback');
      assert.equal(
        (await empty.query("select to_regclass('public.live_session_telemetry') t")).rows[0].t,
        null,
      );
    } finally {
      await empty.close();
    }
  });
  await check(
    'Clean 001..012 installation creates empty runtime tables and only safe telemetry publication',
    async () => {
      const clean = new PGlite();
      try {
        await clean.exec(auth);
        for (const migration of migrations.slice(0, 11)) await clean.exec(migration.sql);
        await clean.exec('create publication supabase_realtime');
        await clean.exec(migrations[11].sql);
        const rows = (
          await clean.query(
            "select tablename from pg_publication_tables where pubname='supabase_realtime' order by tablename",
          )
        ).rows;
        assert.deepEqual(rows, [{ tablename: 'live_session_telemetry' }]);
        assert.equal(
          (await clean.query('select count(*)::int n from public.live_session_telemetry')).rows[0]
            .n,
          0,
        );
      } finally {
        await clean.close();
      }
    },
  );
  await db.exec(auth);
  for (const [role, id] of Object.entries(users))
    await db.query('insert into auth.users values($1,$2,now())', [id, `${role}@runtime.test`]);
  for (const migration of migrations.slice(0, 11)) await db.exec(migration.sql);
  await user();
  w = (await rpc('bootstrap_workspace', { p_name: 'Synthetic runtime' })).id;
  for (const role of ['manager', 'staff', 'viewer'])
    await rpc('add_workspace_member', {
      p_workspace_id: w,
      p_email: `${role}@runtime.test`,
      p_role: role,
    });
  warehouse = (await db.query('select id from public.warehouses where workspace_id=$1', [w]))
    .rows[0].id;
  await user(users.other);
  foreignW = (await rpc('bootstrap_workspace', { p_name: 'Foreign runtime' })).id;
  const foreignWarehouse = (
    await db.query('select id from public.warehouses where workspace_id=$1', [foreignW])
  ).rows[0].id;
  foreignSession = await localSession('simulator', foreignW, foreignWarehouse);
  await user();
  const supplier = await rpc('save_master', {
    p_kind: 'suppliers',
    p_payload: { workspace_id: w, code: 'RT', name: 'NCC tổng hợp' },
  });
  product = await rpc('save_master', {
    p_kind: 'products',
    p_payload: {
      workspace_id: w,
      code: '49-XANH-M',
      name: 'Quần xanh M',
      supplier_id: supplier.id,
      provisional: false,
    },
  });
  const style = await rpc('save_product_style', {
    p_workspace_id: w,
    p_payload: { code: '49', name: 'Quần xanh' },
  });
  await rpc('save_product_variant', {
    p_workspace_id: w,
    p_payload: {
      product_id: product.id,
      style_id: style,
      size: 'M',
      color: 'Xanh',
      mapping_status: 'confirmed',
      review_note: 'Dữ liệu tổng hợp đã kiểm tra trước migration 012.',
    },
  });
  const receipt = await rpc('create_purchase', {
    p_payload: {
      workspace_id: w,
      warehouse_id: warehouse,
      supplier_id: supplier.id,
      product_id: product.id,
      received_date: '2026-08-18',
      date_estimated: false,
      qty: 10,
      unit_cost: 80000,
      additional_cost: 0,
    },
  });
  await rpc('post_purchase', { p_id: receipt.id, p_request_id: uuid() });
  ctx = await live('runtime.history2');
  const comment = (await ingestComment(ctx.session, uuid(), true)).ids[0];
  const held = await rpc('claim_live_comment', { p_workspace_id: w, p_comment_id: comment });
  initialTicket = await rpc('commit_live_sale_ticket', {
    p_workspace_id: w,
    p_request_id: uuid(),
    p_payload: {
      comment_id: comment,
      claim_token: held.claim_token,
      product_id: product.id,
      qty: 1,
      unit_price: 100000,
      date,
      customer_id: null,
      review_note: 'Phiếu kiểm tra tổng hợp trước nâng cấp runtime.',
    },
  });
  sim = await localSession();
  manual = await localSession('manual');
  await check(
    'Populated 011 upgrade preserves every historical public row and all old routines/ACL',
    async () => {
      const tables = await admin(async () =>
        (
          await db.query(
            "select tablename from pg_tables where schemaname='public' order by tablename",
          )
        ).rows.map((r) => r.tablename),
      );
      const before = await snapshot(tables);
      const routines = () =>
        db.query(`select p.oid::regprocedure::text signature,pg_get_functiondef(p.oid) definition,p.proacl::text acl
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','app_private') order by 1`);
      const previous = (await admin(routines)).rows;
      await admin(() => db.exec(migrations[11].sql));
      assert.deepEqual(await snapshot(tables), before);
      const current = (await admin(routines)).rows;
      for (const old of previous)
        assert.deepEqual(
          current.find((row) => row.signature === old.signature),
          old,
        );
    },
  );
  const businessBefore = await snapshot();
  const auditBefore = await snapshot(['audit_events']);
  await check(
    'No health or events means offline/not ready and unknown telemetry without backfill',
    async () => {
      assert.deepEqual(await runtime(sim), {
        listener: { online: false, ready: false, heartbeat_at: null },
        telemetry: null,
        diagnostics: null,
      });
      assert.equal((await runtime()).telemetry, null);
    },
  );
  await check(
    'Existing comment-only session exposes event freshness with unknown viewers',
    async () => {
      const result = await runtime(ctx.session);
      assert.equal(result.telemetry.session_id, ctx.session);
      assert.equal(result.telemetry.current_viewer_count, null);
      assert.equal(result.telemetry.peak_viewer_count, null);
      assert.equal(result.telemetry.member_event_count, 0);
      assert.ok(Date.parse(result.telemetry.last_provider_event_at));
      assert.ok(Date.parse(result.telemetry.last_ingest_at));
      assert.equal(
        (await db.query('select count(*)::int n from public.live_session_telemetry')).rows[0].n,
        0,
      );
    },
  );
  await check(
    'Health heartbeat uses server time, retains instance start/actor and distinguishes readiness',
    async () => {
      const first = await health();
      assert.equal(first.instance_id, instance);
      let result = await runtime();
      const started = result.diagnostics.started_at;
      assert.equal(result.listener.online, true);
      assert.equal(result.listener.ready, true);
      assert.equal(result.diagnostics.provider_version, '2.5.0');
      await health({
        ready: false,
        active_listener_count: 0,
        last_error_code: 'TIKTOK_PROVIDER_UNAVAILABLE',
      });
      result = await runtime();
      assert.equal(result.listener.online, true);
      assert.equal(result.listener.ready, false);
      assert.equal(result.diagnostics.started_at, started);
      assert.equal(result.diagnostics.last_error_code, 'TIKTOK_PROVIDER_UNAVAILABLE');
    },
  );
  await check(
    'Stale health expires after45s; another fresh ready instance keeps workspace ready',
    async () => {
      await admin(() =>
        db.query(
          "update public.live_listener_health set started_at=clock_timestamp()-interval '2 minutes',heartbeat_at=clock_timestamp()-interval '46 seconds' where instance_id=$1",
          [instance],
        ),
      );
      let result = await runtime();
      assert.equal(result.listener.online, false);
      assert.equal(result.listener.ready, false);
      assert.ok(result.listener.heartbeat_at);
      await health({}, otherInstance);
      result = await runtime();
      assert.equal(result.listener.online, true);
      assert.equal(result.listener.ready, true);
      assert.equal(result.diagnostics.active_listener_count, 1);
    },
  );
  await check(
    'Health rejects unknown fields, arbitrary errors, false types and out-of-range values atomically',
    async () => {
      for (const payload of [
        { access_token: 'never-store' },
        { heartbeat_at: new Date().toISOString() },
        { ready: 'true' },
        { provider_version: '9.9.9' },
        { active_listener_count: -1 },
        { active_listener_count: 1001 },
        { active_listener_count: 1.2 },
        { active_listener_count: '1' },
        { last_error_code: 'secret/raw-provider-error' },
        { last_error_code: {} },
      ])
        await rejectUnchanged(() => health(payload));
      await rejectUnchanged(() => health({}, null));
    },
  );
  await check(
    'Member-only events preserve unknown viewers and count distinct events without inventing customers',
    async () => {
      const member = event('MEMBER_JOIN', 'member-only', time());
      assert.deepEqual(await events([member], manual), { inserted: 1, duplicates: 0 });
      assert.deepEqual(await events([member], manual), { inserted: 0, duplicates: 1 });
      const t = (await runtime(manual)).telemetry;
      assert.equal(t.current_viewer_count, null);
      assert.equal(t.peak_viewer_count, null);
      assert.equal(t.last_viewer_update_at, null);
      assert.equal(t.member_event_count, 1);
      assert.equal(Date.parse(t.last_member_at), Date.parse(member.occurred_at));
    },
  );
  const zero = event('VIEWER_COUNT', 'zero-observed', time(), 0);
  await check(
    'Viewer-only zero is an observation, distinct from unknown, with no comment required',
    async () => {
      assert.deepEqual(await events([zero]), { inserted: 1, duplicates: 0 });
      const t = (await runtime(sim)).telemetry;
      assert.equal(t.current_viewer_count, 0);
      assert.equal(t.peak_viewer_count, 0);
      assert.equal(t.member_event_count, 0);
      assert.equal(Date.parse(t.last_provider_event_at), Date.parse(zero.occurred_at));
    },
  );
  await check(
    'Duplicates do not emit another update or alter counts; equivalent ISO offsets replay',
    async () => {
      const before = await observationSnapshot();
      assert.deepEqual(
        await events([zero, { ...zero, occurred_at: zero.occurred_at.replace('Z', '+00:00') }]),
        { inserted: 0, duplicates: 2 },
      );
      assert.deepEqual(await observationSnapshot(), before);
    },
  );
  await check(
    'Out-of-order viewer event changes peak only, never current count or last viewer time',
    async () => {
      await events([event('VIEWER_COUNT', 'newer', time(2000), 30)]);
      await events([event('VIEWER_COUNT', 'older-peak', time(1000), 200)]);
      const t = (await runtime(sim)).telemetry;
      assert.equal(t.current_viewer_count, 30);
      assert.equal(t.peak_viewer_count, 200);
      assert.equal(Date.parse(t.last_viewer_update_at), Date.parse(time(2000)));
    },
  );
  await check(
    'Equal-time viewer events resolve deterministically by source ID, independent of arrival order',
    async () => {
      await events([
        event('VIEWER_COUNT', 'tie-z', time(3000), 15),
        event('VIEWER_COUNT', 'tie-a', time(3000), 10),
      ]);
      assert.equal((await runtime(sim)).telemetry.current_viewer_count, 15);
      const separate = await localSession();
      await events(
        [
          event('VIEWER_COUNT', 'tie-a', time(3000), 10),
          event('VIEWER_COUNT', 'tie-z', time(3000), 15),
        ],
        separate,
      );
      assert.equal((await runtime(separate)).telemetry.current_viewer_count, 15);
    },
  );
  await check(
    'Member events have their own dedupe namespace and cannot replace viewer metrics',
    async () => {
      await events([
        event('MEMBER_JOIN', zero.event_id, time(6000)),
        event('MEMBER_JOIN', 'old-member', time(5000)),
      ]);
      const t = (await runtime(sim)).telemetry;
      assert.equal(t.member_event_count, 2);
      assert.equal(t.current_viewer_count, 15);
      assert.equal(Date.parse(t.last_member_at), Date.parse(time(6000)));
      assert.equal(Date.parse(t.last_provider_event_at), Date.parse(time(6000)));
    },
  );
  await check(
    'Conflicting event ID rolls back prior inserts and aggregate updates in the same batch',
    async () => {
      await rejectUnchanged(
        () => events([event('MEMBER_JOIN', 'rollback-first'), { ...zero, viewer_count: 5 }]),
        /LIVE_EVENT_CONFLICT/,
      );
      await rejectUnchanged(
        () => events([{ ...zero, occurred_at: time(10000) }]),
        /LIVE_EVENT_CONFLICT/,
      );
    },
  );
  await check(
    'Malformed event IDs, payloads, times, types and viewer counts are rejected without writes',
    async () => {
      for (const batch of [null, {}, [], Array.from({ length: 101 }, () => zero)])
        await rejectUnchanged(() => events(batch));
      const invalid = [
        {},
        null,
        { ...zero, event_id: 123 },
        { ...zero, event_id: '' },
        { ...zero, event_id: ' padded' },
        { ...zero, event_id: 'control\n' },
        { ...zero, event_id: 'x'.repeat(201) },
        { ...zero, type: 'GIFT' },
        { ...zero, rawPayload: {} },
        { ...zero, author_external_id: 'PII' },
        { ...zero, occurred_at: 'infinity' },
        { ...zero, occurred_at: '2026-09-25' },
        { ...zero, occurred_at: '2026-02-30T00:00:00Z' },
        { ...zero, occurred_at: '1899-12-31T23:59:59Z' },
        { ...zero, occurred_at: new Date(Date.now() + 3600000).toISOString() },
        { ...zero, viewer_count: null },
        { ...zero, viewer_count: '1' },
        { ...zero, viewer_count: true },
        { ...zero, viewer_count: -1 },
        { ...zero, viewer_count: 1.5 },
        { ...zero, viewer_count: 2147483648 },
        { ...event('MEMBER_JOIN'), viewer_count: 0 },
      ];
      for (const value of invalid)
        await rejectUnchanged(() => events([event('MEMBER_JOIN'), value]));
    },
  );
  await check('A full100-event batch is accepted and exactly replayable', async () => {
    const batch = Array.from({ length: 100 }, (_, i) =>
      event('MEMBER_JOIN', `batch-${i}`, time(7000)),
    );
    assert.deepEqual(await events(batch), { inserted: 100, duplicates: 0 });
    assert.deepEqual(await events(batch), { inserted: 0, duplicates: 100 });
    assert.equal((await runtime(sim)).telemetry.member_event_count, 102);
  });
  await check(
    'TikTok events require current lease and remain separate from comments/business commits',
    async () => {
      assert.deepEqual(
        await tiktok([
          event('VIEWER_COUNT', 'provider-viewers', time(8000), 42),
          event('MEMBER_JOIN', 'provider-member', time(9000)),
        ]),
        { inserted: 2, duplicates: 0 },
      );
      const t = (await runtime(ctx.session)).telemetry;
      assert.equal(t.current_viewer_count, 42);
      assert.equal(t.member_event_count, 1);
      await rejectUnchanged(() => events([zero], ctx.session), /LIVE_EVENT_PROVIDER/);
    },
  );
  await check(
    'Wrong or missing TikTok revision/token/session is rejected even for duplicate events',
    async () => {
      for (const override of [
        { p_revision: null },
        { p_revision: Number(ctx.revision) + 1 },
        { p_lease_token: null },
        { p_lease_token: uuid() },
        { p_session_id: sim },
        { p_session_id: foreignSession },
        { p_channel_id: uuid() },
      ])
        await rejectUnchanged(
          () => tiktok([event('VIEWER_COUNT', 'provider-viewers', time(8000), 42)], override),
          /TIKTOK_EVENT_STALE/,
        );
    },
  );
  await check(
    'Expired TikTok lease and mismatched owner/manager actor cannot ingest metadata',
    async () => {
      await user(users.manager);
      await assert.rejects(() => tiktok([event()]), /TIKTOK_EVENT_STALE/);
      await assert.rejects(() => health({}, instance), /LIVE_HEALTH_ACTOR/);
      await user();
      await admin(() =>
        db.query(
          "update public.live_channel_connections set lease_expires_at=clock_timestamp()-interval '1 second' where channel_id=$1",
          [ctx.id],
        ),
      );
      await rejectUnchanged(() => tiktok([event()]), /TIKTOK_EVENT_STALE/);
      await admin(() =>
        db.query(
          "update public.live_channel_connections set lease_expires_at=clock_timestamp()+interval '90 seconds' where channel_id=$1",
          [ctx.id],
        ),
      );
    },
  );
  await check(
    'Staff can ingest simulator observations but cannot report listener health or use TikTok path',
    async () => {
      await user(users.staff);
      assert.deepEqual(await events([event('MEMBER_JOIN')]), { inserted: 1, duplicates: 0 });
      await assert.rejects(() => health());
      await assert.rejects(() => tiktok([event()]));
      assert.equal((await runtime(sim)).diagnostics, null);
      assert.equal((await db.query('select * from public.live_listener_health')).rows.length, 0);
      await user();
    },
  );
  await check(
    'Viewer sees scoped telemetry only, no diagnostics, and has no write or helper capability',
    async () => {
      await user(users.viewer);
      const result = await runtime(sim);
      assert.equal(result.diagnostics, null);
      assert.equal(result.telemetry.current_viewer_count, 15);
      assert.equal((await db.query('select * from public.live_listener_health')).rows.length, 0);
      await assert.rejects(() => health());
      await assert.rejects(() => events([event()]));
      await assert.rejects(() => tiktok([event()]));
      await assert.rejects(() =>
        db.query('select app_private.ingest_live_runtime_events($1,$2,$3)', [
          w,
          sim,
          JSON.stringify([event()]),
        ]),
      );
      await user();
    },
  );
  await check(
    'All runtime RPCs reject cross-workspace access and scoped table FK prevents foreign session mapping',
    async () => {
      await assert.rejects(() => runtime(null, foreignW));
      await assert.rejects(() => runtime(foreignSession), /LIVE_RUNTIME_SESSION/);
      await assert.rejects(() => health({}, uuid(), foreignW));
      await assert.rejects(() => events([event()], foreignSession, foreignW));
      await assert.rejects(() => events([event()], foreignSession, w));
      await assert.rejects(() => tiktok([event()], { p_workspace_id: foreignW }));
      await admin(() =>
        assert.rejects(
          () =>
            db.query(
              'insert into public.live_session_telemetry(workspace_id,session_id) values($1,$2)',
              [w, foreignSession],
            ),
          /foreign key/i,
        ),
      );
      await user(users.other);
      assert.equal((await db.query('select * from public.live_session_telemetry')).rows.length, 0);
      assert.equal((await db.query('select * from public.live_listener_health')).rows.length, 0);
      await user();
    },
  );
  await check(
    'Direct authenticated writes cannot bypass RPCs; anon cannot read or execute runtime APIs',
    async () => {
      await assert.rejects(() =>
        db.query(
          'update public.live_session_telemetry set current_viewer_count=0 where workspace_id=$1',
          [w],
        ),
      );
      await assert.rejects(() =>
        db.query('delete from public.live_listener_health where workspace_id=$1', [w]),
      );
      await assert.rejects(() => db.query('select * from app_private.live_runtime_event_keys'));
      await admin(async () => {
        await db.exec('set role anon');
        try {
          await assert.rejects(() => db.query('select public.get_live_runtime($1,null)', [w]));
          await assert.rejects(() => db.query('select * from public.live_session_telemetry'));
        } finally {
          await db.exec('reset role');
        }
      });
    },
  );
  await check(
    '012 RLS, exact signatures, security definer/search_path and helper ACL are enforced',
    async () => {
      await admin(async () => {
        const tables = (
          await db.query(
            "select relname,relrowsecurity from pg_class where oid in('public.live_listener_health'::regclass,'public.live_session_telemetry'::regclass,'app_private.live_runtime_event_keys'::regclass)",
          )
        ).rows;
        assert.equal(tables.length, 3);
        assert.ok(tables.every((r) => r.relrowsecurity));
        for (const signature of [
          'public.report_live_listener_health(uuid,uuid,jsonb)',
          'public.get_live_runtime(uuid,uuid)',
          'public.ingest_live_events(uuid,uuid,jsonb)',
          'public.ingest_tiktok_events(uuid,uuid,bigint,uuid,uuid,jsonb)',
        ]) {
          const row = (
            await db.query(
              `select p.prosecdef,p.proconfig,
          has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated,
          has_function_privilege('anon',p.oid,'EXECUTE') anon from pg_proc p where p.oid=$1::regprocedure`,
              [signature],
            )
          ).rows[0];
          assert.equal(row.prosecdef, true);
          assert.ok(row.proconfig.includes('search_path=""'));
          assert.equal(row.authenticated, true);
          assert.equal(row.anon, false);
        }
        assert.equal(
          (
            await db.query(
              "select has_function_privilege('authenticated','app_private.ingest_live_runtime_events(uuid,uuid,jsonb)','EXECUTE') allowed",
            )
          ).rows[0].allowed,
          false,
        );
      });
    },
  );
  await check(
    'Draft/ended session or closed campaign rejects new observation batches',
    async () => {
      for (const status of ['draft', 'ended']) {
        await admin(() =>
          db.query('update public.live_sessions set status=$1 where id=$2', [status, manual]),
        );
        await rejectUnchanged(() => events([event()], manual), /LIVE_EVENT_SESSION/);
      }
      await admin(() =>
        db.query("update public.live_sessions set status='live' where id=$1", [manual]),
      );
      await admin(() =>
        db.query(
          "update public.live_campaigns set status='closed' where id=(select campaign_id from public.live_sessions where id=$1)",
          [manual],
        ),
      );
      await rejectUnchanged(() => events([event()], manual), /LIVE_EVENT_SESSION/);
      await admin(() =>
        db.query(
          "update public.live_campaigns set status='active' where id=(select campaign_id from public.live_sessions where id=$1)",
          [manual],
        ),
      );
    },
  );
  await check(
    'All observations preserve original ledger, holds, ticket/cart/print rows and create no packet audit',
    async () => {
      assert.deepEqual(await snapshot(), businessBefore);
      // Fixture session creation changes audit intentionally; packet ingestion does not.
      const audit = await snapshot(['audit_events']);
      const newAudits = audit.audit_events.filter(
        (r) => !auditBefore.audit_events.some((old) => old.id === r.id),
      );
      assert.ok(
        newAudits.every((r) => ['live_campaign.saved', 'live_session.saved'].includes(r.action)),
        JSON.stringify(newAudits),
      );
      const before = await snapshot(['audit_events']);
      await health();
      await events([event('MEMBER_JOIN')]);
      assert.deepEqual(await snapshot(['audit_events']), before);
    },
  );
  await check(
    'Disconnect invalidates old event token; reconnect same room requires the new lease',
    async () => {
      await connect(ctx.id, 'disconnected');
      await rejectUnchanged(() => tiktok([event()]), /TIKTOK_EVENT_STALE/);
      const old = { ...ctx };
      const request = await connect(ctx.id);
      const claim = await rpc('claim_tiktok_connection', {
        p_workspace_id: w,
        p_channel_id: ctx.id,
        p_revision: request.revision,
      });
      const result = await rpc('report_tiktok_connection', {
        p_workspace_id: w,
        p_channel_id: ctx.id,
        p_revision: request.revision,
        p_lease_token: claim.lease_token,
        p_status: 'live',
        p_provider_room_id: `room-${ctx.id}`,
      });
      assert.equal(result.session_id, old.session);
      await rejectUnchanged(() => tiktok([event()]), /TIKTOK_EVENT_STALE/);
      ctx = { ...ctx, revision: request.revision, token: claim.lease_token };
      assert.deepEqual(await tiktok([event('MEMBER_JOIN')]), { inserted: 1, duplicates: 0 });
      assert.deepEqual(await snapshot(), businessBefore);
    },
  );
  await check(
    'Legacy commit/VOID still works after012 and does not mutate observation receipts',
    async () => {
      const before = await observationSnapshot();
      await rpc('void_live_sale_ticket', {
        p_workspace_id: w,
        p_ticket_id: initialTicket.ticket_id,
        p_date: date,
        p_reason: 'Đảo phiếu kiểm thử sau nâng cấp telemetry.',
        p_request_id: uuid(),
      });
      assert.deepEqual(await observationSnapshot(), before);
      const row = (
        await db.query('select status from public.live_sale_tickets where id=$1', [
          initialTicket.ticket_id,
        ])
      ).rows[0];
      assert.equal(row.status, 'voided');
    },
  );
  await check(
    'Read-only012 verifier returns one healthy metadata JSON without identifiers or mutation',
    async () => {
      const before = await observationSnapshot();
      const business = await snapshot();
      const result = await admin(() => verify());
      healthy(result);
      assert.equal(result.metadata.validated_foreign_keys, 6);
      assert.equal(result.metadata.expected_routines, 5);
      assert.doesNotMatch(
        JSON.stringify(result),
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu,
      );
      for (const secret of [ctx.token, instance, 'runtime.history2', 'Khách kiểm tra'])
        assert.ok(!JSON.stringify(result).includes(secret));
      assert.deepEqual(await observationSnapshot(), before);
      assert.deepEqual(await snapshot(), business);
    },
  );
  await check(
    'Verifier detects helper misgrant and disabled RLS, then fixture rollback restores health',
    async () => {
      await corrupt(
        () =>
          db.exec(
            'grant execute on function app_private.ingest_live_runtime_events(uuid,uuid,jsonb) to authenticated',
          ),
        'security',
        'routine_acl_or_configuration_mismatch',
      );
      await corrupt(
        () => db.exec('alter table public.live_session_telemetry disable row level security'),
        'security',
        'table_acl_rls_or_policy_mismatch',
      );
    },
  );
  await check(
    'Verifier scans all publications for private health/receipts and FOR ALL TABLES exposure',
    async () => {
      await corrupt(
        () =>
          db.exec(
            'create publication runtime_private_leak for table public.live_listener_health,app_private.live_runtime_event_keys',
          ),
        'security',
        'publication_exposes_runtime_private_metadata',
      );
      await corrupt(
        () => db.exec('create publication runtime_all_leak for all tables'),
        'security',
        'publication_for_all_tables',
      );
    },
  );
  await check(
    'Verifier detects aggregate corruption against immutable dedupe receipts',
    async () => {
      await corrupt(
        () =>
          db.query(
            'update public.live_session_telemetry set member_event_count=member_event_count+1 where session_id=$1',
            [sim],
          ),
        'reconciliation',
        'telemetry_receipts_mismatch',
      );
    },
  );
} finally {
  await mkdir(new URL('../test-results/', import.meta.url), { recursive: true });
  await writeFile(
    new URL('../test-results/live-runtime.json', import.meta.url),
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        engine: 'PGlite PostgreSQL',
        isolated: true,
        real_cloud: false,
        real_tiktok: false,
        status: checks.some((r) => r.status === 'FAIL') ? 'FAIL' : 'PASS',
        passed: checks.filter((r) => r.status === 'PASS').length,
        migrations: migrations.map(({ name, sha256 }) => ({ name, sha256 })),
        checks,
      },
      null,
      2,
    ) + '\n',
  );
  await db.close();
}
console.log(`${checks.length} live runtime checks passed.`);
