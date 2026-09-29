// Synthetic local PostgreSQL/PGlite acceptance checks. No TikTok, cloud, env or printer I/O.
import { PGlite } from '@electric-sql/pglite';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID as uuid, createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const path = new URL('../supabase/migrations/', import.meta.url);
const names = (await readdir(path)).filter((name) => /^(00[1-9]|010)_.*\.sql$/u.test(name)).sort();
assert.equal(names.length, 10, 'Complete migrations 001..010 are required');
const migrations = await Promise.all(
  names.map(async (name) => {
    const sql = await readFile(new URL(name, path), 'utf8');
    assert.match(sql.trim(), /commit;$/iu, `${name} must be complete`);
    return { name, sql, sha256: createHash('sha256').update(sql).digest('hex') };
  }),
);
const auth = `create role anon;create role authenticated;create schema auth;
create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema auth to authenticated,anon;grant execute on function auth.uid() to authenticated,anon;`;
const db = new PGlite();
const verification = await readFile(
  new URL('../supabase/verification/verify_tiktok_channels.sql', import.meta.url),
  'utf8',
);
// Corruption checks run the exact read query inside an outer rollback-only
// fixture transaction. Strip only its standalone transaction wrapper.
const verificationQuery = verification
  .replace(/^begin transaction isolation level repeatable read read only;\s*$/gimu, '')
  .replace(/^commit;\s*$/gimu, '');
const users = Object.fromEntries(
  ['owner', 'manager', 'staff', 'viewer', 'other', 'legacy'].map((key) => [key, uuid()]),
);
const checks = [];
let actor = users.owner,
  w,
  foreignW,
  legacyW,
  foreignChannel,
  channel,
  channel2,
  warehouse,
  product;
let connection,
  lease,
  activeSession,
  activeCampaign,
  firstTicket,
  migrated = false;
const financialTables = [
  'products',
  'purchase_receipts',
  'stock_movements',
  'inventory_lots',
  'sales_orders',
  'sales_order_lines',
  'sales_events',
  'cash_transactions',
  'cash_movements',
];
const liveTables = [
  'live_campaigns',
  'live_sessions',
  'live_comments',
  'live_sale_tickets',
  'live_campaign_customers',
  'customer_carts',
  'customer_cart_items',
  'live_print_jobs',
];
async function check(name, run) {
  try {
    await run();
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
async function admin(fn) {
  const previous = actor;
  await db.exec('reset role');
  try {
    return await fn();
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
async function rows(table) {
  return (
    await db.query(`select to_jsonb(t) row from public.${table} t order by to_jsonb(t)::text`)
  ).rows.map((row) => row.row);
}
async function snapshot(tables) {
  return admin(async () =>
    Object.fromEntries(await Promise.all(tables.map(async (table) => [table, await rows(table)]))),
  );
}
const channels = (workspace = w) => rpc('get_tiktok_channels', { p_workspace_id: workspace });
const save = (payload, request = uuid(), workspace = w) =>
  rpc('save_tiktok_channel', {
    p_workspace_id: workspace,
    p_payload: payload,
    p_request_id: request,
  });
const request = (id = channel, desired = 'connected', requestId = uuid(), workspace = w) =>
  rpc('request_tiktok_connection', {
    p_workspace_id: workspace,
    p_channel_id: id,
    p_desired_state: desired,
    p_request_id: requestId,
  });
const claim = (id, revision, workspace = w) =>
  rpc('claim_tiktok_connection', {
    p_workspace_id: workspace,
    p_channel_id: id,
    p_revision: revision,
  });
const report = (id, revision, token, status, room = null, workspace = w) =>
  rpc('report_tiktok_connection', {
    p_workspace_id: workspace,
    p_channel_id: id,
    p_revision: revision,
    p_lease_token: token,
    p_status: status,
    p_provider_room_id: room,
  });
const message = (id = uuid(), author = '9223372036854775807123') => ({
  message_id: id,
  author_external_id: author,
  author_display_name: 'Khách Nguyễn',
  text: '49 xanh m 1c',
  occurred_at: '2026-08-18T09:00:00Z',
});
const ingest = (session, comment = message(), workspace = w) =>
  rpc('ingest_live_comments_v2', {
    p_workspace_id: workspace,
    p_session_id: session,
    p_comments: [comment],
  });
const managedIngest = (
  session,
  comment = message(),
  revision = connection.revision,
  token = lease.lease_token,
  id = channel,
  workspace = w,
) =>
  rpc('ingest_tiktok_comments', {
    p_workspace_id: workspace,
    p_channel_id: id,
    p_revision: revision,
    p_lease_token: token,
    p_session_id: session,
    p_comments: [comment],
  });
async function ticket(session, author = '9223372036854775807123') {
  const comment = (
    await (migrated
      ? managedIngest(session, message(uuid(), author))
      : ingest(session, message(uuid(), author)))
  ).ids[0];
  const token = (await rpc('claim_live_comment', { p_workspace_id: w, p_comment_id: comment }))
    .claim_token;
  return rpc('commit_live_sale_ticket', {
    p_workspace_id: w,
    p_request_id: uuid(),
    p_payload: {
      comment_id: comment,
      claim_token: token,
      product_id: product.id,
      qty: 1,
      unit_price: '120000',
      date: '2026-08-18',
      customer_id: null,
      review_note: 'Đã đối chiếu SKU, số lượng, màu cỡ và giá.',
    },
  });
}
async function businessCounts() {
  const value = await snapshot(liveTables);
  return Object.fromEntries(Object.entries(value).map(([key, rows]) => [key, rows.length]));
}
async function verify(sql = verification) {
  const results = await db.exec(sql);
  const matching = results
    .flatMap((result) => result.rows)
    .filter((row) => row.tiktok_channels_verification);
  assert.equal(matching.length, 1, 'Verifier must return exactly one aggregate JSON cell');
  return matching[0].tiktok_channels_verification;
}
function verified(result) {
  assert.equal(
    result.status,
    'PASS',
    JSON.stringify({ security: result.security_checks, reconciliation: result.reconciliation }),
  );
  assert.equal(result.failed_checks, 0);
}
function detects(result, group, issue) {
  assert.equal(result.status, 'FAIL');
  assert.ok(result[group][issue] > 0, `${group}.${issue} must expose the corruption`);
}
async function corruption(action) {
  await admin(async () => {
    await db.exec('begin');
    try {
      await action();
    } finally {
      await db.exec('rollback');
    }
  });
  verified(await admin(() => verify()));
}

try {
  await check('Clean install accepts 001..010 without existing cloud state', async () => {
    const clean = new PGlite();
    try {
      await clean.exec(auth);
      for (const { sql } of migrations) await clean.exec(sql);
    } finally {
      await clean.close();
    }
  });
  await db.exec(auth);
  for (const [key, id] of Object.entries(users))
    await db.query('insert into auth.users values($1,$2,now())', [id, `${key}@channel.test`]);
  for (const { sql } of migrations.slice(0, 9)) await db.exec(sql);
  await user();
  w = (await rpc('bootstrap_workspace', { p_name: 'TikTok acceptance' })).id;
  for (const role of ['manager', 'staff', 'viewer'])
    await rpc('add_workspace_member', {
      p_workspace_id: w,
      p_email: `${role}@channel.test`,
      p_role: role,
    });
  await user(users.other);
  foreignW = (await rpc('bootstrap_workspace', { p_name: 'Other two channels' })).id;
  foreignChannel = await rpc('save_live_integration_account', {
    p_workspace_id: foreignW,
    p_payload: { username: 'foreign_one', name: 'Foreign one' },
  });
  await rpc('save_live_integration_account', {
    p_workspace_id: foreignW,
    p_payload: { username: 'foreign_two', name: 'Foreign two' },
  });
  await user(users.legacy);
  legacyW = (await rpc('bootstrap_workspace', { p_name: 'Legacy one channel' })).id;
  await rpc('save_live_integration_account', {
    p_workspace_id: legacyW,
    p_payload: { username: 'legacy_one', name: 'Legacy one' },
  });
  await user();
  warehouse = (await rows('warehouses')).find((row) => row.workspace_id === w).id;
  const supplier = await rpc('save_master', {
    p_kind: 'suppliers',
    p_payload: { workspace_id: w, code: 'SUP', name: 'NCC tổng hợp' },
  });
  product = await rpc('save_master', {
    p_kind: 'products',
    p_payload: {
      workspace_id: w,
      code: '49-XANH-M',
      name: 'Quần xanh M',
      unit_cost: 80000,
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
      review_note: 'Đã đối chiếu mã hàng theo chứng từ.',
    },
  });
  const receipt = await rpc('create_purchase', {
    p_payload: {
      workspace_id: w,
      supplier_id: supplier.id,
      product_id: product.id,
      warehouse_id: warehouse,
      received_date: '2026-08-18',
      date_estimated: false,
      qty: 100,
      unit_cost: 80000,
      additional_cost: 1,
    },
  });
  await rpc('post_purchase', { p_id: receipt.id, p_request_id: uuid() });
  const oldCampaign = await rpc('save_live_campaign', {
    p_workspace_id: w,
    p_payload: { code: 'LEGACY', name: 'Chiến dịch cũ', warehouse_id: warehouse, status: 'active' },
  });
  const oldSession = await rpc('save_live_session', {
    p_workspace_id: w,
    p_payload: {
      campaign_id: oldCampaign,
      code: 'LEGACY',
      title: 'Phiên thủ công cũ',
      provider: 'manual',
      status: 'live',
      room_id: '',
    },
  });
  await ticket(oldSession, 'legacy-buyer');
  const oldRows = await snapshot([
    ...financialTables,
    ...liveTables,
    'inventory_reservations',
    'reservation_lots',
    'audit_events',
  ]);
  await check(
    'Populated upgrade preserves old sessions/tickets/ledger and defaults only an unambiguous legacy channel',
    async () => {
      await admin(() => db.exec(migrations[9].sql));
      migrated = true;
      assert.deepEqual(await snapshot(Object.keys(oldRows)), oldRows);
      await user(users.other);
      assert.equal((await channels(foreignW)).channels.filter((row) => row.is_default).length, 0);
      await user(users.legacy);
      assert.equal((await channels(legacyW)).channels[0].is_default, true);
      await user();
    },
  );
  const financialBaseline = await snapshot(financialTables);
  await check(
    '1. Save one TikTok ID without campaign/session/room setup or business side effects',
    async () => {
      const before = await businessCounts();
      const idempotency = uuid();
      const payload = {
        username: ' @ChiDi.ID ',
        display_name: 'Kênh ChiDi',
        actor_id: users.other,
      };
      channel = await save(payload, idempotency);
      assert.equal(await save(payload, idempotency), channel);
      const row = (await channels()).channels[0];
      assert.equal(row.username, 'chidi.id');
      assert.equal(row.is_default, true);
      assert.equal(row.is_active, true);
      assert.equal(row.display_name, 'Kênh ChiDi');
      assert.equal(row.last_connected_at, null);
      assert.equal(row.last_live_at, null);
      assert.equal(
        (await rows('live_integration_accounts')).find((row) => row.id === channel).created_by,
        users.owner,
      );
      assert.deepEqual(await businessCounts(), before);
      await assert.rejects(
        () => save({ ...payload, display_name: 'Changed' }, idempotency),
        /CONFLICT|khác/i,
      );
    },
  );
  await check(
    '2. Duplicate usernames normalize @/case/whitespace; invalid handles are rejected',
    async () => {
      for (const username of ['chidi.id', '@CHIDI.ID', ' chidi.id '])
        await assert.rejects(() => save({ username }), /unique|duplicate/i);
      for (const username of [
        'https://tiktok.com/@chidi.id',
        'hai ten',
        'đỏ',
        'x.',
        'a'.repeat(25),
        'abc\n',
      ])
        await assert.rejects(() => save({ username }));
      assert.equal((await channels()).channels.length, 1);
    },
  );
  await check('3. Every channel RPC and table read isolates workspaces', async () => {
    await assert.rejects(() => channels(foreignW));
    await assert.rejects(() => save({ username: 'new' }, uuid(), foreignW));
    await assert.rejects(() => save({ id: foreignChannel, username: 'foreign_one' }));
    await assert.rejects(() => request(foreignChannel));
    await assert.rejects(() => request(foreignChannel, 'connected', uuid(), foreignW));
    await assert.rejects(() => claim(foreignChannel, 1, foreignW));
    await assert.rejects(() => report(foreignChannel, 1, uuid(), 'live', 'room', foreignW));
    await assert.rejects(() =>
      managedIngest(uuid(), message(), 1, uuid(), foreignChannel, foreignW),
    );
    assert.equal(
      (
        await db.query(
          'select channel_id from public.live_channel_connections where workspace_id=$1',
          [foreignW],
        )
      ).rows.length,
      0,
    );
    assert.ok((await rows('live_integration_accounts')).every((row) => row.workspace_id === w));
  });
  await check(
    '4. Default selection is unique and stable when switching between saved IDs',
    async () => {
      channel2 = await save({ username: 'chidi_second', is_default: true });
      let list = (await channels()).channels;
      assert.equal(list[0].id, channel2);
      assert.equal(list.filter((row) => row.is_default).length, 1);
      await save({ id: channel, username: 'chidi.id', is_default: true });
      list = (await channels()).channels;
      assert.equal(list[0].id, channel);
      assert.equal(list.filter((row) => row.is_default).length, 1);
    },
  );
  await check(
    '5. CONNECT intent and provider OFFLINE/ERROR reports create no campaign or session',
    async () => {
      const before = await businessCounts();
      connection = await request();
      assert.equal(connection.connection_status, 'CONNECTING');
      lease = await claim(channel, connection.revision);
      assert.equal(
        (await report(channel, connection.revision, lease.lease_token, 'offline')).status,
        'OFFLINE',
      );
      assert.equal(
        (await report(channel, connection.revision, lease.lease_token, 'error')).status,
        'ERROR',
      );
      assert.deepEqual(await businessCounts(), before);
      const row = (await channels()).channels.find((row) => row.id === channel);
      assert.equal(row.last_live_at, null);
      assert.equal(row.last_connected_at, null);
      await assert.rejects(() => claim(channel, connection.revision), /LISTENER_BUSY/);
    },
  );
  await check(
    '6. Verified LIVE creates one daily campaign/session using the existing warehouse',
    async () => {
      const before = await businessCounts();
      await assert.rejects(
        () => report(channel, connection.revision, lease.lease_token, 'live'),
        /ROOM_REQUIRED/,
      );
      const result = await report(
        channel,
        connection.revision,
        lease.lease_token,
        'live',
        '9223372036854775807123',
      );
      activeSession = result.session_id;
      assert.equal(result.status, 'LIVE');
      assert.ok(activeSession);
      const row = (await rows('live_sessions')).find((row) => row.id === activeSession);
      activeCampaign = row.campaign_id;
      assert.equal(row.integration_account_id, channel);
      assert.equal(row.status, 'live');
      assert.equal(row.room_id, 'chidi.id');
      assert.equal(
        (await rows('live_campaigns')).find((row) => row.id === activeCampaign).warehouse_id,
        warehouse,
      );
      assert.equal((await businessCounts()).live_sessions, before.live_sessions + 1);
      assert.equal((await businessCounts()).live_campaigns, before.live_campaigns + 1);
      const saved = (await channels()).channels.find((row) => row.id === channel);
      assert.ok(saved.last_connected_at && saved.last_live_at);
    },
  );
  await check(
    '7. Repeated CONNECT and repeated LIVE report reuse active revision/session',
    async () => {
      const before = await businessCounts();
      const events = (await rows('live_channel_commands')).length;
      for (let i = 0; i < 3; i++) {
        assert.equal((await request()).revision, connection.revision);
        assert.equal(
          (
            await report(
              channel,
              connection.revision,
              lease.lease_token,
              'live',
              '9223372036854775807123',
            )
          ).session_id,
          activeSession,
        );
      }
      assert.equal((await rows('live_channel_commands')).length, events);
      assert.deepEqual(await businessCounts(), before);
    },
  );
  const retainedMessage = message('before-disconnect');
  await managedIngest(activeSession, retainedMessage);
  await check(
    '8. DISCONNECT fences new ingestion and stale reports, preserving duplicate acknowledgement/history',
    async () => {
      await user(users.staff);
      const stop = await request(channel, 'disconnected');
      await user();
      assert.ok(stop.revision > connection.revision);
      const before = await businessCounts();
      await assert.rejects(() => ingest(activeSession), /TIKTOK_DISCONNECTED/);
      await assert.rejects(
        () =>
          report(channel, connection.revision, lease.lease_token, 'live', '9223372036854775807123'),
        /LISTENER_STALE/,
      );
      assert.equal((await ingest(activeSession, retainedMessage)).duplicates, 1);
      assert.deepEqual(await businessCounts(), before);
      assert.equal(
        (await channels()).connections.find((row) => row.channel_id === channel).connection_status,
        'OFFLINE',
      );
      assert.equal(
        (await rows('live_channel_commands')).find(
          (row) => row.revision === stop.revision && row.channel_id === channel,
        ).actor_id,
        users.staff,
      );
    },
  );
  await check('9. Reconnect to the same provider room reuses session and start time', async () => {
    const start = (await rows('live_sessions')).find((row) => row.id === activeSession).started_at;
    const before = await businessCounts();
    const oldLease = lease;
    connection = await request();
    lease = await claim(channel, connection.revision);
    await assert.rejects(
      () =>
        report(
          channel,
          connection.revision,
          oldLease.lease_token,
          'live',
          '9223372036854775807123',
        ),
      /LISTENER_STALE/,
    );
    await assert.rejects(
      () => managedIngest(activeSession, message(), connection.revision - 2, oldLease.lease_token),
      /INGEST_STALE/,
    );
    assert.equal(
      (
        await report(
          channel,
          connection.revision,
          lease.lease_token,
          'live',
          '9223372036854775807123',
        )
      ).session_id,
      activeSession,
    );
    assert.equal(
      (await rows('live_sessions')).find((row) => row.id === activeSession).started_at,
      start,
    );
    assert.deepEqual(await businessCounts(), before);
    firstTicket = await ticket(activeSession);
  });
  await check(
    '10. Multiple TikTok IDs maintain separate connections, rooms and campaigns',
    async () => {
      const otherRequest = await request(channel2);
      const otherLease = await claim(channel2, otherRequest.revision);
      const result = await report(
        channel2,
        otherRequest.revision,
        otherLease.lease_token,
        'live',
        'ROOM-SECOND',
      );
      const secondSession = (await rows('live_sessions')).find(
        (row) => row.id === result.session_id,
      );
      assert.notEqual(secondSession.campaign_id, activeCampaign);
      assert.equal(secondSession.integration_account_id, channel2);
      assert.equal(
        (await channels()).connections.find((row) => row.channel_id === channel).current_session_id,
        activeSession,
      );
      await assert.rejects(
        () => report(channel2, otherRequest.revision, lease.lease_token, 'live', 'ROOM-SECOND'),
        /LISTENER_STALE/,
      );
    },
  );
  await check(
    '11. Automatic campaign keys use the Vietnam date and reuse the same day mapping',
    async () => {
      const today = (
        await db.query("select (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date::text d")
      ).rows[0].d;
      const mappings = (await rows('live_channel_campaigns')).filter(
        (row) => row.channel_id === channel,
      );
      assert.equal(mappings.length, 1);
      assert.equal(mappings[0].business_date, today);
      assert.equal(mappings[0].campaign_id, activeCampaign);
      const c = (await rows('live_campaigns')).find((row) => row.id === activeCampaign);
      assert.ok(c.code.endsWith(today.replaceAll('-', '')));
    },
  );
  await check(
    '12. A new room creates a session in the same campaign and actual commits retain customer STT/cart',
    async () => {
      const result = await report(
        channel,
        connection.revision,
        lease.lease_token,
        'live',
        'ROOM-NEXT',
      );
      assert.notEqual(result.session_id, activeSession);
      const old = (await rows('live_sessions')).find((row) => row.id === activeSession);
      assert.equal(old.status, 'ended');
      assert.ok(old.ended_at);
      const current = (await rows('live_sessions')).find((row) => row.id === result.session_id);
      assert.equal(current.campaign_id, activeCampaign);
      const second = await ticket(result.session_id);
      assert.equal(second.customer_no, firstTicket.customer_no);
      assert.equal(second.cart_id, firstTicket.cart_id);
      assert.notEqual(second.ticket_id, firstTicket.ticket_id);
      assert.notEqual(second.reservation_id, firstTicket.reservation_id);
      assert.equal(
        (await rows('live_campaign_customers')).filter((row) => row.campaign_id === activeCampaign)
          .length,
        1,
      );
      activeSession = result.session_id;
    },
  );
  await check(
    'Viewer can read sanitized state; staff cannot manage channels/listener leases',
    async () => {
      await user(users.viewer);
      assert.equal((await channels()).channels.length, 2);
      const state = await channels();
      for (const row of state.connections)
        for (const key of ['lease_token', 'lease_actor', 'lease_expires_at'])
          assert.equal(Object.hasOwn(row, key), false);
      await assert.rejects(() =>
        db.query('select lease_token from public.live_channel_connections'),
      );
      await assert.rejects(() => save({ username: 'viewer_write' }));
      await assert.rejects(() => request());
      await assert.rejects(() => claim(channel, connection.revision));
      await assert.rejects(() =>
        report(channel, connection.revision, lease.lease_token, 'live', 'ROOM-NEXT'),
      );
      await user(users.staff);
      await assert.rejects(() => save({ username: 'staff_write' }));
      await assert.rejects(() => claim(channel, connection.revision));
      await user(users.manager);
      await assert.rejects(
        () => report(channel, connection.revision, lease.lease_token, 'live', 'ROOM-NEXT'),
        /LISTENER_STALE/,
      );
      await user();
    },
  );
  await check(
    'Expired listener leases and stale revisions cannot report or ingest as a new listener',
    async () => {
      await admin(() =>
        db.query(
          "update public.live_channel_connections set lease_expires_at=clock_timestamp()-interval '1 second' where workspace_id=$1 and channel_id=$2",
          [w, channel],
        ),
      );
      await assert.rejects(
        () => report(channel, connection.revision, lease.lease_token, 'live', 'ROOM-NEXT'),
        /LISTENER_STALE/,
      );
      await assert.rejects(() => managedIngest(activeSession), /INGEST_STALE/);
      const old = lease;
      lease = await claim(channel, connection.revision);
      assert.notEqual(lease.lease_token, old.lease_token);
      await assert.rejects(
        () => report(channel, connection.revision - 1, lease.lease_token, 'live', 'ROOM-NEXT'),
        /LISTENER_STALE/,
      );
      await assert.rejects(
        () => report(channel, connection.revision, old.lease_token, 'live', 'ROOM-NEXT'),
        /LISTENER_STALE/,
      );
      await report(channel, connection.revision, lease.lease_token, 'live', 'ROOM-NEXT');
    },
  );
  const checkPendingRename = () =>
    check(
      'Pending connection fences username changes even through the legacy account RPC',
      async () => {
        const pending = await save({ username: 'pending_id' });
        const started = await request(pending);
        await assert.rejects(
          () => save({ id: pending, username: 'renamed_id' }),
          undefined,
          'New channel RPC must fence pending-source rename',
        );
        await assert.rejects(
          () =>
            rpc('save_live_integration_account', {
              p_workspace_id: w,
              p_payload: { id: pending, username: 'renamed_id', name: 'Renamed', enabled: true },
            }),
          undefined,
          'Legacy account RPC must also fence pending-source rename',
        );
        assert.equal(
          (await channels()).connections.find((row) => row.channel_id === pending).revision,
          started.revision,
        );
      },
    );
  await check(
    'Disabling a connected account invalidates worker reports and new ingestion',
    async () => {
      await save({ id: channel, username: 'chidi.id', is_active: false });
      const row = (await channels()).connections.find((row) => row.channel_id === channel);
      assert.equal(row.desired_state, 'disconnected');
      assert.equal(row.connection_status, 'OFFLINE');
      assert.ok(row.revision > connection.revision);
      await assert.rejects(
        () => report(channel, connection.revision, lease.lease_token, 'live', 'ROOM-NEXT'),
        /STALE|DISABLED/,
      );
      await assert.rejects(() => request());
      await assert.rejects(() => ingest(activeSession));
    },
  );
  await check(
    'Channel/session actions and held tickets do not move physical stock, cash or revenue',
    async () => {
      assert.deepEqual(await snapshot(financialTables), financialBaseline);
      const inventory = (await rows('inventory_lots')).filter((row) => row.workspace_id === w);
      assert.equal(
        inventory.reduce((total, row) => total + row.remaining_qty, 0),
        100,
      );
      assert.equal((await rows('live_sale_tickets')).length, 3);
      assert.equal(
        (await rows('inventory_reservations')).filter((row) => row.status === 'active').length,
        3,
      );
    },
  );
  await checkPendingRename();
  await check(
    'Read-only channel verification passes healthy fixtures and returns no PII/IDs/tokens',
    async () => {
      const watched = [
        ...financialTables,
        ...liveTables,
        'live_integration_accounts',
        'live_channel_connections',
        'live_channel_commands',
        'live_channel_campaigns',
        'live_channel_sessions',
      ];
      const before = await snapshot(watched);
      const result = await admin(() => verify());
      verified(result);
      assert.equal(result.metadata.present_public_rpcs, 6);
      assert.equal(result.metadata.validated_foreign_keys, 14);
      assert.equal(result.metadata.enforced_guards, 2);
      assert.deepEqual(await snapshot(watched), before);
      const output = JSON.stringify(result);
      for (const sensitive of [
        w,
        foreignW,
        legacyW,
        channel,
        channel2,
        activeSession,
        firstTicket.ticket_id,
        lease.lease_token,
        'chidi.id',
        'chidi_second',
        'legacy_one',
        'Khách Nguyễn',
        'ROOM-NEXT',
        product.name,
      ])
        assert.equal(
          output.includes(sensitive),
          false,
          'Aggregate verification must not reveal fixture data',
        );
    },
  );
  await check(
    'Verifier detects misgranted lease/RPC permissions and disabled account/RLS guards; rollback restores them',
    async () => {
      await corruption(async () => {
        await db.exec(`grant select(lease_token) on public.live_channel_connections to authenticated;
        grant execute on function public.request_tiktok_connection(uuid,uuid,text,uuid) to public;
        alter table public.live_integration_accounts disable trigger protect_tiktok_channel;
        alter table public.live_channel_sessions disable row level security;`);
        const result = await verify(verificationQuery);
        detects(result, 'security_checks', 'listener_columns_readable');
        detects(result, 'security_checks', 'routine_grants_or_configuration_mismatch');
        detects(result, 'security_checks', 'missing_ingestion_or_account_guard');
        detects(result, 'security_checks', 'table_rls_grants_or_policy_mismatch');
      });
    },
  );
  await check(
    'Verifier inspects every publication, including explicit token exposure and FOR ALL TABLES',
    async () => {
      await corruption(async () => {
        await db.exec(
          'create publication unsafe_channel_qa for table public.live_channel_connections',
        );
        const result = await verify(verificationQuery);
        detects(result, 'security_checks', 'publication_exposes_private_tokens_or_requests');
        assert.equal(result.security_checks.publication_for_all_tables, 0);
      });
      await corruption(async () => {
        await db.exec('create publication unsafe_all_channel_qa for all tables');
        const result = await verify(verificationQuery);
        detects(result, 'security_checks', 'publication_for_all_tables');
        detects(result, 'security_checks', 'publication_exposes_private_tokens_or_requests');
      });
    },
  );
  await check(
    'Verifier detects a wrong channel/session mapping even when ordinary FKs still pass',
    async () => {
      await corruption(async () => {
        await db.query(
          'update public.live_channel_sessions set channel_id=$1 where workspace_id=$2 and session_id=$3',
          [channel2, w, activeSession],
        );
        const result = await verify(verificationQuery);
        detects(result, 'reconciliation', 'session_mapping_mismatch');
        detects(result, 'reconciliation', 'connection_session_mapping_mismatch');
      });
    },
  );
} catch (error) {
  console.error('FAIL', error.code || '', error.message);
  process.exitCode = 1;
} finally {
  await mkdir(new URL('../test-results/', import.meta.url), { recursive: true });
  await writeFile(
    new URL('../test-results/tiktok-channels.json', import.meta.url),
    JSON.stringify(
      {
        checked_at: new Date().toISOString(),
        engine: 'PGlite isolated PostgreSQL',
        cloud: false,
        real_tiktok: false,
        status: process.exitCode || checks.some((row) => row.status === 'FAIL') ? 'FAIL' : 'PASS',
        checks,
        migrations: migrations.map(({ name, sha256 }) => ({ name, sha256 })),
      },
      null,
      2,
    ),
  );
  await db.close();
}
