// Disposable PGlite only: no .env, Supabase, external providers or printer traffic.
import { PGlite } from '@electric-sql/pglite';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID as uid, createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const directory = new URL('../supabase/migrations/', import.meta.url);
const names = (await readdir(directory)).filter((name) => /^00[1-9]_.*\.sql$/u.test(name)).sort();
assert.equal(names.length, 9);
const migrations = await Promise.all(
  names.map(async (name) => {
    const sql = await readFile(new URL(name, directory), 'utf8');
    assert.match(sql.trim(), /commit;$/iu, `${name} must be complete`);
    return { name, sql, sha256: createHash('sha256').update(sql).digest('hex') };
  }),
);
const authSql = `create role anon;create role authenticated;create schema auth;
create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema auth to authenticated,anon;grant execute on function auth.uid() to authenticated,anon;`;
const db = new PGlite();
const users = Object.fromEntries(
  ['owner', 'manager', 'staff', 'viewer', 'other'].map((role) => [role, uid()]),
);
let actor = users.owner;
let w, foreignW, warehouse, product, campaign, manual, tiktok, tiktok2, account;
const checks = [];
const newTables = [
  'live_session_controls',
  'live_control_events',
  'live_comment_reviews',
  'live_provider_message_keys',
  'print_templates',
  'printer_devices',
  'printer_profiles',
];
const financeTables = [
  'products',
  'customers',
  'purchase_receipts',
  'stock_movements',
  'inventory_lots',
  'sales_orders',
  'sales_order_lines',
  'sales_events',
  'sales_allocations',
  'cash_accounts',
  'cash_transactions',
  'cash_movements',
];
const holdTables = ['inventory_reservations', 'reservation_lots'];
const businessTables = [
  ...financeTables,
  ...holdTables,
  'live_sale_tickets',
  'customer_carts',
  'customer_cart_items',
  'live_print_jobs',
  'live_print_attempts',
];
async function ok(name, action) {
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
async function admin(fn) {
  const prior = actor;
  await db.exec('reset role');
  try {
    return await fn();
  } finally {
    await user(prior);
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
async function snapshot(tables = businessTables) {
  return admin(async () =>
    Object.fromEntries(await Promise.all(tables.map(async (table) => [table, await rows(table)]))),
  );
}
function oldColumns(after, before) {
  return after
    .map((row) =>
      Object.fromEntries(
        Object.keys(before.find((prior) => prior.id === row.id) || before[0] || {}).map((key) => [
          key,
          row[key],
        ]),
      ),
    )
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
const message = (message_id = uid(), extra = {}) => ({
  message_id,
  author_external_id: '9223372036854775807001',
  author_display_name: 'Khách Nguyễn kiểm thử',
  text: '49 xanh m 2c',
  occurred_at: '2026-08-18T01:00:00Z',
  ...extra,
});
async function ingest(payload = message(), session = manual, version = false, workspace = w) {
  return rpc(version ? 'ingest_live_comments_v2' : 'ingest_live_comments', {
    p_workspace_id: workspace,
    p_session_id: session,
    p_comments: [payload],
  });
}
const claim = async (id) => rpc('claim_live_comment', { p_workspace_id: w, p_comment_id: id });
const commit = (payload, request = uid()) =>
  rpc('commit_live_sale_ticket', { p_workspace_id: w, p_payload: payload, p_request_id: request });
async function ticket(extra = {}, payload = message(), session = manual) {
  const comment = (await ingest(payload, session, Boolean(payload.username))).ids[0];
  const lease = await claim(comment);
  const input = {
    comment_id: comment,
    claim_token: lease.claim_token,
    product_id: product.id,
    qty: 2,
    unit_price: '120000',
    date: '2026-08-18',
    customer_id: null,
    review_note: 'Đã kiểm tra màu cỡ, số lượng và đơn giá.',
    ...extra,
  };
  return { input, result: await commit(input) };
}
const voidTicket = (id) =>
  rpc('void_live_sale_ticket', {
    p_workspace_id: w,
    p_ticket_id: id,
    p_date: '2026-08-18',
    p_reason: 'Khách đã xác nhận hủy phiếu thử nghiệm.',
    p_request_id: uid(),
  });
const review = (id, status, request = uid(), reason = 'Đã đọc và đối chiếu bình luận.') =>
  rpc('set_live_comment_review', {
    p_workspace_id: w,
    p_comment_id: id,
    p_status: status,
    p_reason: reason,
    p_request_id: request,
  });
const requestConnection = (
  desired = 'connected',
  request = uid(),
  session = tiktok,
  workspace = w,
) =>
  rpc('request_live_connection', {
    p_workspace_id: workspace,
    p_session_id: session,
    p_desired_state: desired,
    p_request_id: request,
  });
const printerPayload = (extra = {}) => ({
  name: 'ZYWELL thử nghiệm',
  driver: 'ESC_POS',
  ip_address: '192.168.1.25',
  paper_width: 80,
  port: 9100,
  is_default: true,
  enabled: true,
  settings: { show_username: true, font_scale_customer: 2, copies: 1, auto_cut: true },
  ...extra,
});
const savePrinter = (payload = printerPayload(), request = uid(), workspace = w) =>
  rpc('save_live_printer', {
    p_workspace_id: workspace,
    p_payload: payload,
    p_request_id: request,
  });
const operations = (workspace = w) => rpc('get_live_operations', { p_workspace_id: workspace });
const preview = (date = '2026-08-18', session = manual, pid = product.id, workspace = w) =>
  rpc('get_live_stock_preview', {
    p_workspace_id: workspace,
    p_session_id: session,
    p_product_id: pid,
    p_date: date,
  });
const finishPrint = (lease) =>
  rpc('finish_live_print_job', {
    p_workspace_id: w,
    p_job_id: lease.job_id,
    p_lease_token: lease.lease_token,
    p_outcome: 'printed',
    p_detail: 'Đã nhìn thấy và kiểm tra giấy đúng phiếu.',
    p_request_id: uid(),
  });
const requeuePrint = (job) =>
  rpc('requeue_live_print_job', {
    p_workspace_id: w,
    p_job_id: job,
    p_reason: 'Đã đối chiếu giấy trước khi in lại.',
    p_request_id: uid(),
  });
const configuredClaim = (job, request = uid(), workspace = w) =>
  rpc('claim_live_print_job_configured', {
    p_workspace_id: workspace,
    p_job_id: job,
    p_request_id: request,
  });
const resetCounter = (cid, request = uid(), workspace = w) =>
  rpc('reset_live_campaign_counter', {
    p_workspace_id: workspace,
    p_campaign_id: cid,
    p_request_id: request,
  });
async function session(code, provider = 'manual', status = 'live', cid = campaign) {
  return rpc('save_live_session', {
    p_workspace_id: w,
    p_payload: {
      code,
      title: `Phiên ${code}`,
      provider,
      campaign_id: cid,
      status,
      room_id: provider === 'tiktok_live' ? 'chidi_test' : '',
      integration_account_id: provider === 'tiktok_live' ? account : null,
    },
  });
}
async function updateSession(id, status) {
  const row = (await rows('live_sessions')).find((row) => row.id === id);
  return rpc('save_live_session', { p_workspace_id: w, p_payload: { ...row, status } });
}

try {
  await ok('Clean synthetic database accepts complete migrations 001..009', async () => {
    const clean = new PGlite();
    try {
      await clean.exec(authSql);
      for (const migration of migrations) await clean.exec(migration.sql);
    } finally {
      await clean.close();
    }
  });
  await db.exec(authSql);
  for (const [role, id] of Object.entries(users))
    await db.query('insert into auth.users values($1,$2,now())', [id, `${role}@operations.test`]);
  for (const migration of migrations.slice(0, 8)) await db.exec(migration.sql);
  await user();
  w = (await rpc('bootstrap_workspace', { p_name: '009 populated fixture' })).id;
  for (const role of ['manager', 'staff', 'viewer'])
    await rpc('add_workspace_member', {
      p_workspace_id: w,
      p_email: `${role}@operations.test`,
      p_role: role,
    });
  await user(users.other);
  foreignW = (await rpc('bootstrap_workspace', { p_name: 'Foreign workspace' })).id;
  await user();
  warehouse = (await rows('warehouses')).find((row) => row.workspace_id === w).id;
  const supplier = await rpc('save_master', {
    p_kind: 'suppliers',
    p_payload: { workspace_id: w, code: 'SUP', name: 'NCC thử nghiệm' },
  });
  product = await rpc('save_master', {
    p_kind: 'products',
    p_payload: {
      workspace_id: w,
      code: 'SKU-009',
      name: 'Quần xanh M',
      supplier_id: supplier.id,
      unit_cost: 80000,
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
      review_note: 'Đã kiểm tra hàng thực tế và mã cỡ.',
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
  await rpc('post_purchase', { p_id: receipt.id, p_request_id: uid() });
  const customer = await rpc('save_customer', {
    p_workspace_id: w,
    p_payload: { code: 'BUYER', name: 'Khách ERP cũ' },
  });
  const order = await rpc('save_sales_order', {
    p_workspace_id: w,
    p_payload: {
      code: 'OLD-ORDER',
      customer_id: customer,
      warehouse_id: warehouse,
      order_date: '2026-08-18',
      lines: [{ product_id: product.id, qty: 4, unit_price: '120000' }],
    },
  });
  await rpc('transition_sales_order', {
    p_workspace_id: w,
    p_order_id: order,
    p_action: 'confirm',
    p_payload: { date: '2026-08-18' },
    p_request_id: uid(),
  });
  await rpc('reserve_inventory', {
    p_workspace_id: w,
    p_payload: {
      product_id: product.id,
      warehouse_id: warehouse,
      qty: 3,
      date: '2026-08-18',
      reason: 'Phiếu giữ hàng thủ công trước migration.',
    },
    p_request_id: uid(),
  });
  campaign = await rpc('save_live_campaign', {
    p_workspace_id: w,
    p_payload: {
      code: 'C1',
      name: 'Chiến dịch trước 009',
      warehouse_id: warehouse,
      status: 'active',
    },
  });
  account = await rpc('save_live_integration_account', {
    p_workspace_id: w,
    p_payload: { name: 'ChiDi Test', username: 'chidi_test', enabled: true },
  });
  manual = await session('OLD-MANUAL');
  tiktok = await session('OLD-TIKTOK', 'tiktok_live');
  tiktok2 = await session('OLD-TIKTOK-2', 'tiktok_live');
  const duplicate = message('legacy-duplicate');
  await ingest(duplicate, tiktok);
  await ingest(duplicate, tiktok2);
  const legacyUnique = (await ingest(message('legacy-unique'), tiktok)).ids[0];
  const oldTicket = await ticket();
  const beforeUpgrade = await snapshot([
    ...businessTables,
    'live_sessions',
    'live_comments',
    'audit_events',
    'live_outbox_events',
  ]);
  const definitions = await admin(
    async () =>
      (
        await db.query(
          "select proname,pg_get_functiondef(oid) definition from pg_proc where pronamespace='public'::regnamespace and proname in('commit_live_sale_ticket','void_live_sale_ticket') order by proname",
        )
      ).rows,
  );
  await ok(
    'Populated 008 upgrade preserves every legacy row, financial IDs, holds and snapshots',
    async () => {
      await admin(() => db.exec(migrations[8].sql));
      const after = await snapshot(Object.keys(beforeUpgrade));
      for (const table of Object.keys(beforeUpgrade)) {
        assert.equal(after[table].length, beforeUpgrade[table].length, table);
        const expected = [...beforeUpgrade[table]].sort((a, b) =>
          JSON.stringify(a).localeCompare(JSON.stringify(b)),
        );
        assert.deepEqual(oldColumns(after[table], beforeUpgrade[table]), expected, table);
      }
      assert.deepEqual(
        await admin(
          async () =>
            (
              await db.query(
                "select proname,pg_get_functiondef(oid) definition from pg_proc where pronamespace='public'::regnamespace and proname in('commit_live_sale_ticket','void_live_sale_ticket') order by proname",
              )
            ).rows,
        ),
        definitions,
      );
    },
  );
  await ok(
    'Historical TikTok duplicates are flagged without deleting or selecting one comment',
    async () => {
      const keys = await rows('live_provider_message_keys');
      assert.deepEqual(
        keys.find((row) => row.external_comment_id === 'legacy-duplicate'),
        {
          workspace_id: w,
          provider: 'tiktok_live',
          external_comment_id: 'legacy-duplicate',
          comment_id: null,
          needs_review: true,
        },
      );
      assert.equal(
        keys.find((row) => row.external_comment_id === 'legacy-unique').comment_id,
        legacyUnique,
      );
      assert.equal((await operations()).source_conflicts, 1);
    },
  );
  await ok(
    'Old session clocks remain unknown; real new transitions set immutable timestamps',
    async () => {
      assert.ok(
        (await rows('live_sessions')).every(
          (row) => row.started_at === null && row.ended_at === null,
        ),
      );
      const fresh = await session('NEW-CLOCK', 'manual', 'draft');
      await updateSession(fresh, 'live');
      const live = (await rows('live_sessions')).find((row) => row.id === fresh);
      assert.ok(live.started_at && live.ended_at === null);
      await updateSession(fresh, 'live');
      assert.equal(
        (await rows('live_sessions')).find((row) => row.id === fresh).started_at,
        live.started_at,
      );
      await updateSession(fresh, 'ended');
      const ended = (await rows('live_sessions')).find((row) => row.id === fresh);
      assert.equal(ended.started_at, live.started_at);
      assert.ok(Date.parse(ended.ended_at) >= Date.parse(ended.started_at));
      const insertedLive = await session('INSERT-LIVE');
      assert.ok((await rows('live_sessions')).find((row) => row.id === insertedLive).started_at);
    },
  );
  await ok(
    'Connection commands are monotonic, idempotent, actor-bound and durably journaled',
    async () => {
      await user(users.manager);
      const request = uid();
      const first = await requestConnection('connected', request);
      assert.equal(first.revision, 1);
      assert.deepEqual(await requestConnection('connected', request), first);
      await assert.rejects(
        () => requestConnection('disconnected', request),
        /CONFLICT|payload|khác/i,
      );
      const second = await requestConnection('disconnected');
      assert.equal(second.revision, 2);
      const events = await rows('live_control_events');
      assert.equal(events.length, 2);
      assert.ok(events.every((row) => row.actor_id === users.manager));
      assert.equal((await rows('live_session_controls'))[0].requested_by, users.manager);
      await user();
      await assert.rejects(
        () => requestConnection('connected', request),
        /ACTOR|người|khác|quyền/i,
      );
    },
  );
  await ok(
    'Requested connection remains separate from real connection and rejects invalid session state',
    async () => {
      await requestConnection();
      assert.equal(
        (await rows('live_sessions')).find((row) => row.id === tiktok).connection_status,
        'disconnected',
      );
      await assert.rejects(() => requestConnection('connecting'), /LIVE_CONTROL/);
      await assert.rejects(() => requestConnection('connected', uid(), manual), /LIVE_CONTROL/);
      await rpc('save_live_integration_account', {
        p_workspace_id: w,
        p_payload: { id: account, name: 'ChiDi Test', username: 'chidi_test', enabled: false },
      });
      assert.equal(
        (await operations()).session_controls.find((row) => row.session_id === tiktok)
          .desired_state,
        'disconnected',
      );
      await assert.rejects(() => requestConnection(), /LIVE_CONTROL/);
      await rpc('save_live_integration_account', {
        p_workspace_id: w,
        p_payload: { id: account, name: 'ChiDi Test', username: 'chidi_test', enabled: true },
      });
    },
  );
  await ok(
    'Stock preview subtracts legacy order allocations and manual/live holds without mutation',
    async () => {
      const before = await snapshot();
      assert.deepEqual(await preview(), {
        product_id: product.id,
        warehouse_id: warehouse,
        date: '2026-08-18',
        on_hand: 100,
        reserved: 9,
        available: 91,
        preview_only: true,
      });
      assert.equal((await preview('2026-08-17')).available, 0);
      assert.deepEqual(await snapshot(), before);
      await assert.rejects(() => preview('infinity'));
      await assert.rejects(() => preview('2999-01-01'));
    },
  );
  await ok(
    'Ignoring a comment releases only its claim, blocks claim/commit, and supports explicit restore',
    async () => {
      await user(users.staff);
      const id = (await ingest()).ids[0];
      const lease = await claim(id);
      const request = uid();
      const before = await snapshot();
      await review(id, 'ignored', request);
      await review(id, 'ignored', request);
      assert.equal(
        (
          await db.query('select comment_id from public.live_comment_claims where comment_id=$1', [
            id,
          ])
        ).rows.length,
        0,
      );
      await assert.rejects(() => claim(id), /LIVE_IGNORED/);
      await assert.rejects(() =>
        commit({ ...oldTicket.input, comment_id: id, claim_token: lease.claim_token }),
      );
      assert.deepEqual(await snapshot(), before);
      assert.equal(
        (await rows('live_comment_reviews')).find((row) => row.comment_id === id).actor_id,
        users.staff,
      );
      await review(id, 'new');
      assert.ok((await claim(id)).claim_token);
      await user();
    },
  );
  await ok('Review cannot override another active claim or committed ticket', async () => {
    await user(users.staff);
    const id = (await ingest()).ids[0];
    await claim(id);
    await user();
    await assert.rejects(() => review(id, 'ignored'), /LIVE_CLAIM_BUSY/);
    await assert.rejects(() => review(oldTicket.input.comment_id, 'ignored'), /LIVE_REVIEW/);
    await assert.rejects(() => review(id, 'deleted'), /LIVE_REVIEW/);
    await assert.rejects(() => review(id, 'ignored', uid(), 'x'), /LIVE_REVIEW/);
  });
  await ok(
    'Source IDs deduplicate globally for new TikTok comments while manual IDs remain session-scoped',
    async () => {
      const payload = message('new-global-id');
      const first = await ingest(payload, tiktok);
      const repeated = await ingest(payload, tiktok);
      assert.equal(repeated.duplicates, 1);
      assert.deepEqual(first.ids, repeated.ids);
      await assert.rejects(() => ingest(payload, tiktok2), /LIVE_SOURCE_DUPLICATE/);
      const third = await session('TIKTOK-THIRD', 'tiktok_live');
      await assert.rejects(
        () => ingest(message('legacy-duplicate'), third),
        /LIVE_SOURCE_DUPLICATE/,
      );
      const secondManual = await session('MANUAL-SECOND');
      const manualPayload = message('same-manual-id');
      assert.equal((await ingest(manualPayload, manual)).inserted, 1);
      assert.equal((await ingest(manualPayload, secondManual)).inserted, 1);
    },
  );

  // Initial 009 checkpoint only; the user narrowed further work to TikTok setup.
} catch (error) {
  console.error('FAIL', error.code || '', error.message);
  process.exitCode = 1;
} finally {
  await mkdir(new URL('../test-results/', import.meta.url), { recursive: true });
  await writeFile(
    new URL('../test-results/live-operations.json', import.meta.url),
    JSON.stringify(
      {
        checked_at: new Date().toISOString(),
        engine: 'PGlite isolated PostgreSQL',
        cloud: false,
        status:
          checks.some((check) => check.status === 'FAIL') || process.exitCode ? 'FAIL' : 'PASS',
        checks,
        migrations: migrations.map(({ name, sha256 }) => ({ name, sha256 })),
      },
      null,
      2,
    ),
  );
  await db.close();
}
