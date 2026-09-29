// Disposable synthetic PGlite only. No .env, cloud, TikTok, printer or user data.
import { PGlite } from '@electric-sql/pglite';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID as uuid, createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const directory = new URL('../supabase/migrations/', import.meta.url);
const names = (await readdir(directory))
  .filter((name) => /^(00[1-9]|01[01])_.*\.sql$/u.test(name))
  .sort();
assert.equal(names.length, 11);
const migrations = await Promise.all(
  names.map(async (name) => {
    const sql = await readFile(new URL(name, directory), 'utf8');
    assert.match(sql.trim(), /commit;$/iu, `${name} must be complete`);
    return { name, sql, sha256: createHash('sha256').update(sql).digest('hex') };
  }),
);
const auth = `create role anon;create role authenticated;create schema auth;
create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema auth to authenticated,anon;grant execute on function auth.uid() to authenticated,anon;`;
const verification = await readFile(
  new URL('../supabase/verification/verify_tiktok_lifecycle.sql', import.meta.url),
  'utf8',
);
const verificationQuery = verification
  .replace(/^begin transaction isolation level repeatable read read only;\s*$/gimu, '')
  .replace(/^commit;\s*$/gimu, '');
const users = Object.fromEntries(
  ['owner', 'manager', 'staff', 'viewer', 'other'].map((name) => [name, uuid()]),
);
const db = new PGlite();
const checks = [];
let actor = users.owner,
  w,
  foreignW,
  product,
  initial,
  initialTicket,
  finishResult,
  terminal;
const businessDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(
  new Date(),
);
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
        .map((key, index) => `${key}=>$${index + 1}`)
        .join(',')}) result`,
      Object.values(args).map((value) =>
        value !== null && typeof value === 'object' ? JSON.stringify(value) : value,
      ),
    )
  ).rows[0].result;
}
async function snapshot(tables = businessTables) {
  return admin(async () =>
    Object.fromEntries(
      await Promise.all(
        tables.map(async (table) => [
          table,
          (
            await db.query(
              `select to_jsonb(t) row from public.${table} t order by to_jsonb(t)::text`,
            )
          ).rows.map((row) => row.row),
        ]),
      ),
    ),
  );
}
const save = (payload, requestId = uuid()) =>
  rpc('save_tiktok_channel', { p_workspace_id: w, p_payload: payload, p_request_id: requestId });
const connect = (id, desired = 'connected', requestId = uuid()) =>
  rpc('request_tiktok_connection', {
    p_workspace_id: w,
    p_channel_id: id,
    p_desired_state: desired,
    p_request_id: requestId,
  });
const claim = (id, revision) =>
  rpc('claim_tiktok_connection', { p_workspace_id: w, p_channel_id: id, p_revision: revision });
const report = (context, status = 'live', room = context.room) =>
  rpc('report_tiktok_connection', {
    p_workspace_id: w,
    p_channel_id: context.id,
    p_revision: context.revision,
    p_lease_token: context.token,
    p_status: status,
    p_provider_room_id: room,
  });
const finishArgs = (context, requestId = uuid()) => ({
  p_workspace_id: w,
  p_channel_id: context.id,
  p_revision: context.revision,
  p_lease_token: context.token,
  p_request_id: requestId,
});
const finish = (context, requestId) => rpc('finish_tiktok_live', finishArgs(context, requestId));
const connectionRow = (id) =>
  admin(
    async () =>
      (
        await db.query(
          'select to_jsonb(c) row from public.live_channel_connections c where workspace_id=$1 and channel_id=$2',
          [w, id],
        )
      ).rows[0]?.row,
  );
const sessionRow = (id) =>
  admin(
    async () =>
      (await db.query('select to_jsonb(s) row from public.live_sessions s where id=$1', [id]))
        .rows[0]?.row,
  );
async function live(username, room = uuid(), id = null) {
  id ||= await save({ username, is_active: true });
  const request = await connect(id);
  const lease = await claim(id, request.revision);
  const context = { id, room, revision: request.revision, token: lease.lease_token };
  context.session = (await report(context)).session_id;
  context.campaign = (await sessionRow(context.session)).campaign_id;
  return context;
}
const commentArgs = (context, author = 'synthetic-buyer-1') => ({
  p_workspace_id: w,
  p_channel_id: context.id,
  p_revision: context.revision,
  p_lease_token: context.token,
  p_session_id: context.session,
  p_comments: [
    {
      message_id: uuid(),
      author_external_id: author,
      author_display_name: 'Khách kiểm tra',
      text: '49 xanh m 1c',
      occurred_at: new Date().toISOString(),
    },
  ],
});
async function ticket(context, author) {
  const comment = (await rpc('ingest_tiktok_comments', commentArgs(context, author))).ids[0];
  const held = await rpc('claim_live_comment', { p_workspace_id: w, p_comment_id: comment });
  return rpc('commit_live_sale_ticket', {
    p_workspace_id: w,
    p_request_id: uuid(),
    p_payload: {
      comment_id: comment,
      claim_token: held.claim_token,
      product_id: product.id,
      qty: 1,
      unit_price: '120000',
      date: businessDate,
      customer_id: null,
      review_note: 'Đã kiểm tra mã hàng, số lượng và giá trong kiểm thử tổng hợp.',
    },
  });
}
async function verify(query = verification) {
  const results = await db.exec(query);
  const rows = results
    .flatMap((result) => result.rows)
    .filter((row) => row.tiktok_lifecycle_verification);
  assert.equal(rows.length, 1);
  return rows[0].tiktok_lifecycle_verification;
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
      assert.ok(result[group][key] > 0, `${group}.${key} must detect corruption`);
    } finally {
      await db.exec('rollback');
    }
  });
  healthy(await admin(() => verify()));
}

try {
  await check(
    'Clean 001..011 install and exact read-only verifier pass without external services',
    async () => {
      const clean = new PGlite();
      try {
        await clean.exec(auth);
        for (const migration of migrations) await clean.exec(migration.sql);
        const result = (await clean.exec(verification))
          .flatMap((entry) => entry.rows)
          .find((row) => row.tiktok_lifecycle_verification);
        healthy(result.tiktok_lifecycle_verification);
      } finally {
        await clean.close();
      }
    },
  );
  await db.exec(auth);
  for (const [role, id] of Object.entries(users))
    await db.query('insert into auth.users values($1,$2,now())', [id, `${role}@lifecycle.test`]);
  for (const migration of migrations.slice(0, 10)) await db.exec(migration.sql);
  await user();
  w = (await rpc('bootstrap_workspace', { p_name: 'Synthetic LIVE lifecycle' })).id;
  for (const role of ['manager', 'staff', 'viewer'])
    await rpc('add_workspace_member', {
      p_workspace_id: w,
      p_email: `${role}@lifecycle.test`,
      p_role: role,
    });
  await user(users.other);
  foreignW = (await rpc('bootstrap_workspace', { p_name: 'Other tenant' })).id;
  await user();
  const warehouse = (await db.query('select id from public.warehouses where workspace_id=$1', [w]))
    .rows[0].id;
  const supplier = await rpc('save_master', {
    p_kind: 'suppliers',
    p_payload: { workspace_id: w, code: 'TEST', name: 'NCC kiểm tra' },
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
      color: 'Xanh',
      size: 'M',
      mapping_status: 'confirmed',
      review_note: 'Đã đối chiếu mã hàng trong kiểm thử tổng hợp.',
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
      additional_cost: 1,
    },
  });
  await rpc('post_purchase', { p_id: receipt.id, p_request_id: uuid() });
  initial = await live('live.history1', 'first-source-room');
  initialTicket = await ticket(initial, 'stable-same-customer');
  await check(
    'Populated 010 upgrade preserves every existing public row and unchanged routine definition/ACL',
    async () => {
      const tables = await admin(async () =>
        (
          await db.query(
            "select tablename from pg_tables where schemaname='public' order by tablename",
          )
        ).rows.map((row) => row.tablename),
      );
      const before = await snapshot(tables);
      const routines = () =>
        db.query(`select p.oid::regprocedure::text signature,pg_get_functiondef(p.oid) definition,p.proacl::text acl
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','app_private') order by 1`);
      const beforeRoutines = (await admin(routines)).rows;
      await admin(() => db.exec(migrations[10].sql));
      assert.deepEqual(await snapshot(tables), before);
      const afterRoutines = (await admin(routines)).rows;
      const allowed = ['save_tiktok_channel(', 'app_private.protect_tiktok_channel('];
      for (const previous of beforeRoutines) {
        if (allowed.some((prefix) => previous.signature.startsWith(prefix))) continue;
        assert.deepEqual(
          afterRoutines.find((row) => row.signature === previous.signature),
          previous,
          previous.signature,
        );
      }
    },
  );
  await check(
    'Finish rejects anonymous, staff, viewer, other workspace, wrong actor/token and changed revision',
    async () => {
      const before = await snapshot();
      for (const id of [users.staff, users.viewer, users.other, null]) {
        await user(id);
        await assert.rejects(() => finish(initial));
      }
      await user(users.manager);
      await assert.rejects(() => finish(initial), /TIKTOK_LISTENER_STALE/);
      await user();
      for (const change of [
        { p_workspace_id: foreignW },
        { p_channel_id: uuid() },
        { p_lease_token: uuid() },
        { p_lease_token: null },
        { p_revision: initial.revision + 1 },
        { p_revision: null },
      ])
        await assert.rejects(() =>
          rpc('finish_tiktok_live', { ...finishArgs(initial), ...change }),
        );
      await admin(async () => {
        await db.exec('set role anon');
        await assert.rejects(() => finish(initial), /permission denied/);
        await db.exec('reset role');
      });
      assert.equal((await sessionRow(initial.session)).status, 'live');
      assert.deepEqual(await snapshot(), before);
    },
  );
  const finishRequest = uuid();
  await check(
    'STREAM_END ends the current session once and keeps committed ticket, hold, stock and cash rows unchanged',
    async () => {
      const before = await snapshot();
      finishResult = await finish(initial, finishRequest);
      assert.equal(finishResult.status, 'OFFLINE');
      assert.equal(finishResult.session_id, initial.session);
      assert.equal(finishResult.revision, initial.revision + 1);
      const row = await connectionRow(initial.id),
        session = await sessionRow(initial.session);
      assert.deepEqual(
        [row.desired_state, row.connection_status, row.message_code],
        ['disconnected', 'OFFLINE', 'live_ended'],
      );
      assert.deepEqual(
        [row.lease_token, row.lease_actor, row.lease_expires_at, row.connected_since],
        [null, null, null, null],
      );
      assert.equal(session.status, 'ended');
      assert.equal(session.connection_status, 'disconnected');
      assert.ok(session.ended_at && new Date(session.ended_at) >= new Date(session.started_at));
      assert.deepEqual(await snapshot(), before);
      const counts = await admin(() =>
        db.query(
          `select
      (select count(*)::int from public.audit_events where workspace_id=$1 and entity_id=$2 and action='tiktok.live_ended') audits,
      (select count(*)::int from public.live_channel_commands where workspace_id=$1 and channel_id=$2 and revision=$3 and desired_state='disconnected') commands`,
          [w, initial.id, finishResult.revision],
        ),
      );
      assert.deepEqual(counts.rows[0], { audits: 1, commands: 1 });
    },
  );
  await check(
    'Terminal retry returns its original result and rejects changed request payload or actor',
    async () => {
      const before = await snapshot([
        ...businessTables,
        'audit_events',
        'live_channel_commands',
        'live_sessions',
        'live_channel_connections',
      ]);
      assert.deepEqual(await finish(initial, finishRequest), finishResult);
      await assert.rejects(
        () =>
          rpc('finish_tiktok_live', {
            ...finishArgs(initial, finishRequest),
            p_lease_token: uuid(),
          }),
        /LIVE_REQUEST_REUSED/,
      );
      await user(users.manager);
      await assert.rejects(() => finish(initial, finishRequest), /LIVE_REQUEST_REUSED/);
      await user();
      await assert.rejects(() => finish(initial), /TIKTOK_LISTENER_STALE/);
      assert.deepEqual(
        await snapshot([
          ...businessTables,
          'audit_events',
          'live_channel_commands',
          'live_sessions',
          'live_channel_connections',
        ]),
        before,
      );
    },
  );
  await check(
    'New source room on the same day reuses campaign/STT while ended source room remains closed',
    async () => {
      const next = await live('live.history1', 'next-source-room', initial.id);
      assert.notEqual(next.session, initial.session);
      assert.equal(next.campaign, initial.campaign);
      const sameCustomer = await ticket(next, 'stable-same-customer');
      const newCustomer = await ticket(next, 'different-stable-customer');
      assert.equal(sameCustomer.customer_no, initialTicket.customer_no);
      assert.equal(sameCustomer.cart_id, initialTicket.cart_id);
      assert.equal(newCustomer.customer_no, initialTicket.customer_no + 1);
      await assert.rejects(() => report(next, 'live', initial.room), /TIKTOK_ROOM_ENDED/);
      assert.equal((await sessionRow(initial.session)).status, 'ended');
      assert.equal((await sessionRow(next.session)).status, 'live');
      assert.deepEqual(await finish(initial, finishRequest), finishResult);
      assert.equal((await connectionRow(initial.id)).current_session_id, next.session);
    },
  );
  await check('Ordinary network disconnection never marks a LIVE session ended', async () => {
    const context = await live('network.loss1');
    const before = await snapshot();
    await report(context, 'disconnected', null);
    const row = await sessionRow(context.session);
    assert.equal(row.status, 'live');
    assert.equal(row.ended_at, null);
    assert.equal((await connectionRow(context.id)).message_code, 'disconnected');
    assert.deepEqual(await snapshot(), before);
  });
  await check(
    'Expired unchanged current token can record terminal evidence but cannot ingest or refresh LIVE',
    async () => {
      terminal = await live('late.end1');
      await admin(() =>
        db.query(
          "update public.live_channel_connections set lease_expires_at=clock_timestamp()-interval '1 second' where workspace_id=$1 and channel_id=$2",
          [w, terminal.id],
        ),
      );
      await assert.rejects(
        () => rpc('ingest_tiktok_comments', commentArgs(terminal)),
        /TIKTOK_INGEST_STALE/,
      );
      await assert.rejects(() => report(terminal), /TIKTOK_LISTENER_STALE/);
      const before = await snapshot();
      await finish(terminal);
      assert.equal((await sessionRow(terminal.session)).status, 'ended');
      assert.deepEqual(await snapshot(), before);
    },
  );
  await check(
    'Replacement lease rejects the previous token; the new authorized listener can end its session',
    async () => {
      const context = await live('replaced.end1');
      await admin(() =>
        db.query(
          "update public.live_channel_connections set lease_expires_at=clock_timestamp()-interval '1 second' where workspace_id=$1 and channel_id=$2",
          [w, context.id],
        ),
      );
      await user(users.manager);
      const replacement = await claim(context.id, context.revision);
      await user();
      await assert.rejects(() => finish(context), /TIKTOK_LISTENER_STALE/);
      assert.equal((await sessionRow(context.session)).status, 'live');
      await user(users.manager);
      await finish({ ...context, token: replacement.lease_token });
      assert.equal((await sessionRow(context.session)).status, 'ended');
      await user();
    },
  );
  await check(
    'Seller disconnect and newer reconnect revisions fence delayed STREAM_END callbacks',
    async () => {
      const context = await live('manual.disconnect1');
      await connect(context.id, 'disconnected');
      await assert.rejects(() => finish(context), /TIKTOK_LISTENER_STALE/);
      const next = await connect(context.id);
      const lease = await claim(context.id, next.revision);
      await assert.rejects(() => finish(context), /TIKTOK_LISTENER_STALE/);
      assert.equal((await connectionRow(context.id)).lease_token, lease.lease_token);
      assert.equal((await sessionRow(context.session)).status, 'live');
    },
  );
  await check(
    'Digits in TikTok ID are accepted for adding and editing an unused channel',
    async () => {
      const id = await save({ username: '@digits.shop1', is_active: true });
      assert.equal(await save({ id, username: 'digits.shop2', is_active: true }), id);
      const state = await rpc('get_tiktok_channels', { p_workspace_id: w });
      assert.equal(state.channels.find((row) => row.id === id).username, 'digits.shop2');
    },
  );
  await check(
    'Pending and offline channels can rename chidi.vibes to chidi.vibes2 while revoking the old listener',
    async () => {
      const id = await save({ username: 'chidi.vibes' });
      const request = await connect(id);
      const lease = await claim(id, request.revision);
      const before = await snapshot();
      assert.equal(await save({ id, username: 'chidi.vibes2' }), id);
      const row = await connectionRow(id);
      assert.equal(row.desired_state, 'disconnected');
      assert.equal(row.lease_token, null);
      assert.ok(row.revision > request.revision);
      await assert.rejects(
        () =>
          report({
            id,
            revision: request.revision,
            token: lease.lease_token,
            room: 'renamed-old-room',
          }),
        /TIKTOK_LISTENER_STALE/,
      );
      const next = await connect(id),
        nextLease = await claim(id, next.revision);
      await report({ id, revision: next.revision, token: nextLease.lease_token }, 'offline', null);
      assert.equal(await save({ id, username: 'chidi.vibes3' }), id);
      assert.deepEqual(await snapshot(), before);
    },
  );
  await check(
    'Channel with actual session history cannot rename through either current or legacy save RPC',
    async () => {
      await assert.rejects(
        () => save({ id: initial.id, username: 'live.history2' }),
        /TIKTOK_CHANNEL_USED/,
      );
      await assert.rejects(
        () =>
          rpc('save_live_integration_account', {
            p_workspace_id: w,
            p_payload: {
              id: initial.id,
              username: 'live.history2',
              name: 'Rename attempt',
              enabled: true,
            },
          }),
        /LIVE_ACCOUNT: Tài khoản đã có phiên/,
      );
    },
  );
  await check(
    'Failed reconnect cannot rewrite the terminal state of the previous ended LIVE',
    async () => {
      const previous = await live('ended.reconnect1');
      await finish(previous);
      const ended = await sessionRow(previous.session);
      const next = await connect(previous.id),
        held = await claim(previous.id, next.revision);
      const context = { id: previous.id, revision: next.revision, token: held.lease_token };
      await report(context, 'error', null);
      assert.deepEqual(await sessionRow(previous.session), ended);
      await report(context, 'offline', null);
      assert.deepEqual(await sessionRow(previous.session), ended);
      healthy(await admin(() => verify()));
    },
  );
  await check(
    'Read-only lifecycle verifier passes real ended/reconnected data and returns no identifiers or secrets',
    async () => {
      const before = await snapshot([
        ...businessTables,
        'audit_events',
        'live_channel_connections',
        'live_channel_commands',
      ]);
      const result = await admin(() => verify());
      healthy(result);
      assert.equal(result.metadata.present_routines, 4);
      const output = JSON.stringify(result);
      for (const secret of [
        w,
        initial.id,
        initial.session,
        initial.token,
        'chidi.vibes2',
        'Khách kiểm tra',
        'first-source-room',
      ])
        assert.ok(!output.includes(secret));
      assert.deepEqual(
        await snapshot([
          ...businessTables,
          'audit_events',
          'live_channel_connections',
          'live_channel_commands',
        ]),
        before,
      );
    },
  );
  await check(
    'Verifier detects anonymous/PUBLIC execute grants and weakened message constraint',
    async () => {
      await corrupt(
        () =>
          db.exec(
            'grant execute on function public.finish_tiktok_live(uuid,uuid,bigint,uuid,uuid) to anon',
          ),
        'security_checks',
        'routine_grants_or_configuration_mismatch',
      );
      await corrupt(
        () =>
          db.exec(
            'grant execute on function public.finish_tiktok_live(uuid,uuid,bigint,uuid,uuid) to public',
          ),
        'security_checks',
        'routine_grants_or_configuration_mismatch',
      );
      await corrupt(
        () =>
          db.exec(
            'alter table public.live_channel_connections drop constraint live_channel_connections_message_code_check; alter table public.live_channel_connections add constraint live_channel_connections_message_code_check check(true)',
          ),
        'security_checks',
        'message_code_constraint_mismatch',
      );
    },
  );
  await check(
    'Verifier detects disabled end clock, corrupted terminal status and missing terminal command',
    async () => {
      await corrupt(
        () =>
          db.exec(
            'alter table public.live_channel_connections disable trigger clear_ended_tiktok_connection',
          ),
        'security_checks',
        'ended_connection_guard_missing_or_disabled',
      );
      await corrupt(
        () => db.exec('alter table public.live_sessions disable trigger live_session_clock'),
        'security_checks',
        'session_clock_missing_or_disabled',
      );
      await corrupt(
        () =>
          db.query(
            "update public.live_channel_connections set connection_status='CONNECTING' where workspace_id=$1 and channel_id=$2",
            [w, terminal.id],
          ),
        'reconciliation',
        'terminal_connection_mismatch',
      );
      await corrupt(
        () =>
          db.query(
            'delete from public.live_channel_commands where workspace_id=$1 and channel_id=$2 and desired_state=$3',
            [w, terminal.id, 'disconnected'],
          ),
        'reconciliation',
        'terminal_connection_mismatch',
      );
    },
  );
  await check(
    'Verifier detects an ended audit pointing to an unended session and duplicate terminal audit',
    async () => {
      await corrupt(
        () =>
          db.query("update public.live_sessions set status='live' where id=$1", [initial.session]),
        'reconciliation',
        'terminal_audit_mapping_mismatch',
      );
      await corrupt(
        () =>
          db.exec(
            "insert into public.audit_events(workspace_id,actor_id,action,entity_id,details) select workspace_id,actor_id,action,entity_id,details from public.audit_events where action='tiktok.live_ended' limit 1",
          ),
        'reconciliation',
        'duplicate_terminal_audit',
      );
    },
  );
  await check('Historical SQL files stay unchanged throughout lifecycle verification', async () => {
    for (const migration of migrations)
      assert.equal(
        createHash('sha256')
          .update(await readFile(new URL(migration.name, directory), 'utf8'))
          .digest('hex'),
        migration.sha256,
        migration.name,
      );
  });
} catch (error) {
  if (!checks.some((entry) => entry.status === 'FAIL'))
    checks.push({ name: 'Fixture preparation', status: 'FAIL', detail: error.message });
  console.error('FAIL', error.message);
  process.exitCode = 1;
} finally {
  await db.close();
  await mkdir(new URL('../test-results/', import.meta.url), { recursive: true });
  await writeFile(
    new URL('../test-results/tiktok-lifecycle.json', import.meta.url),
    JSON.stringify(
      {
        checked_at: new Date().toISOString(),
        engine: 'PGlite PostgreSQL',
        cloud_tested: false,
        physical_devices_tested: false,
        migrations: migrations.map(({ name, sha256 }) => ({ name, sha256 })),
        status: checks.some((entry) => entry.status === 'FAIL') ? 'FAIL' : 'PASS',
        checks,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    `TikTok lifecycle: ${checks.filter((entry) => entry.status === 'PASS').length} PASS, ${checks.filter((entry) => entry.status === 'FAIL').length} FAIL`,
  );
}
