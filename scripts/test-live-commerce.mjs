// Local PostgreSQL/PGlite tests. No .env, real customers, cloud or printer calls.
import { PGlite } from '@electric-sql/pglite';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const names = [
  '001_core.sql',
  '002_operations.sql',
  '003_sales_inventory.sql',
  '004_catalog_variants_aliases.sql',
  '005_customer_order_foundation.sql',
  '006_inventory_reservations.sql',
  '007_live_intake.sql',
  '008_live_tickets_print.sql',
];
const migrations = await Promise.all(
  names.map((n) => readFile(new URL(`../supabase/migrations/${n}`, import.meta.url), 'utf8')),
);
for (let i = 0; i < migrations.length; i++)
  assert.match(
    migrations[i].trim(),
    /commit;$/i,
    `${names[i]} must be complete before verification`,
  );
const db = new PGlite();
const uid = () => crypto.randomUUID();
const users = {
  owner: '11111111-1111-4111-8111-111111111111',
  other: '22222222-2222-4222-8222-222222222222',
  staff: '33333333-3333-4333-8333-333333333333',
  viewer: '44444444-4444-4444-8444-444444444444',
  manager: '55555555-5555-4555-8555-555555555555',
};
let actor = users.owner,
  w,
  otherW,
  campaign,
  session,
  session2,
  warehouse,
  product,
  style,
  customer,
  customer2;
const checks = [];
const authSql = `create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated,anon;grant execute on function auth.uid() to authenticated,anon;`;
async function ok(name, fn) {
  await fn();
  checks.push(name);
  console.log('PASS', name);
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
  const keys = Object.keys(args);
  return (
    await db.query(
      `select public.${name}(${keys.map((k, i) => `${k}=>$${i + 1}`).join(',')}) result`,
      Object.entries(args).map(([k, v]) =>
        k === 'p_reservation_ids' ? v : v !== null && typeof v === 'object' ? JSON.stringify(v) : v,
      ),
    )
  ).rows[0].result;
}
async function select(table) {
  return (await db.query(`select to_jsonb(t) row from public.${table} t order by id`)).rows.map(
    (r) => r.row,
  );
}
const financeTables = [
  'products',
  'purchase_receipts',
  'stock_movements',
  'inventory_lots',
  'sales_orders',
  'sales_order_lines',
  'sales_events',
  'cash_accounts',
  'cash_transactions',
  'cash_movements',
  'payment_intents',
];
const liveTables = [
  'live_campaign_customers',
  'customer_carts',
  'live_sale_tickets',
  'customer_cart_items',
  'live_print_jobs',
  'live_print_attempts',
  'live_outbox_events',
];
async function snapshot(tables) {
  return admin(async () => {
    const result = {};
    for (const table of tables)
      result[table] = (
        await db.query(
          `select to_jsonb(t) row from ${table.includes('.') ? table : `public.${table}`} t order by to_jsonb(t)::text`,
        )
      ).rows;
    return result;
  });
}
async function state() {
  return rpc('get_live_commerce', { p_workspace_id: w, p_campaign_id: campaign });
}
async function seedComment(author = 'author-A', sessionId = session, extra = {}) {
  const payload = {
    message_id: uid(),
    author_external_id: author,
    author_display_name: 'Khách livestream',
    text: 'SKU-A xanh M 2',
    occurred_at: '2026-08-18T01:00:00Z',
    ...extra,
  };
  return (
    await rpc('ingest_live_comments', {
      p_workspace_id: w,
      p_session_id: sessionId,
      p_comments: [payload],
    })
  ).ids[0];
}
async function claim(commentId) {
  return (await rpc('claim_live_comment', { p_workspace_id: w, p_comment_id: commentId }))
    .claim_token;
}
async function command(commentId, token, extra = {}) {
  return {
    comment_id: commentId,
    claim_token: token,
    product_id: product.id,
    qty: 2,
    unit_price: '120000',
    date: '2026-08-18',
    customer_id: null,
    review_note: 'Người bán đã kiểm tra SKU, màu cỡ và giá.',
    ...extra,
  };
}
async function commit(payload, request = uid(), workspace = w) {
  return rpc('commit_live_sale_ticket', {
    p_workspace_id: workspace,
    p_payload: payload,
    p_request_id: request,
  });
}
async function createTicket(author, extra = {}) {
  const comment = await seedComment(author),
    token = await claim(comment);
  const payload = await command(comment, token, extra);
  return { comment, token, payload, result: await commit(payload) };
}
async function printClaim(job, request = uid()) {
  return rpc('claim_live_print_job', { p_workspace_id: w, p_job_id: job, p_request_id: request });
}
async function finish(job, token, outcome = 'printed', request = uid()) {
  return rpc('finish_live_print_job', {
    p_workspace_id: w,
    p_job_id: job,
    p_lease_token: token,
    p_outcome: outcome,
    p_detail: 'Người vận hành đã đối chiếu kết quả in thực tế.',
    p_request_id: request,
  });
}
async function requeue(job, request = uid()) {
  return rpc('requeue_live_print_job', {
    p_workspace_id: w,
    p_job_id: job,
    p_reason: 'Đã đối chiếu giấy thực tế, yêu cầu xếp lại lần in.',
    p_request_id: request,
  });
}
async function voidTicket(id, request = uid()) {
  return rpc('void_live_sale_ticket', {
    p_workspace_id: w,
    p_ticket_id: id,
    p_date: '2026-08-18',
    p_reason: 'Khách yêu cầu hủy mẫu đã chốt, có đối chiếu.',
    p_request_id: request,
  });
}

try {
  await db.exec(authSql);
  for (const [name, id] of Object.entries(users))
    await db.query('insert into auth.users values($1,$2,now())', [id, `${name}@chidi.test`]);
  for (const sql of migrations.slice(0, 7)) await db.exec(sql);
  await user();
  w = (await rpc('bootstrap_workspace', { p_name: 'Live Commerce QA' })).id;
  for (const role of ['staff', 'viewer', 'manager'])
    await rpc('add_workspace_member', {
      p_workspace_id: w,
      p_email: `${role}@chidi.test`,
      p_role: role,
    });
  await user(users.other);
  otherW = (await rpc('bootstrap_workspace', { p_name: 'Other QA' })).id;
  await user();
  warehouse = (await select('warehouses')).find((r) => r.workspace_id === w).id;
  const supplier = await rpc('save_master', {
    p_kind: 'suppliers',
    p_payload: { workspace_id: w, code: 'SUP', name: 'NCC QA' },
  });
  product = await rpc('save_master', {
    p_kind: 'products',
    p_payload: {
      workspace_id: w,
      code: 'SKU-A',
      name: 'Áo <script>alert(1)</script>',
      supplier_id: supplier.id,
      unit_cost: 80000,
      provisional: false,
    },
  });
  style = await rpc('save_product_style', {
    p_workspace_id: w,
    p_payload: { code: 'STYLE-A', name: 'Áo kiểu A' },
  });
  await rpc('save_product_variant', {
    p_workspace_id: w,
    p_payload: {
      product_id: product.id,
      style_id: style,
      size: 'M',
      color: 'Xanh',
      mapping_status: 'confirmed',
      review_note: 'Đã đối chiếu mã màu và kích cỡ.',
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
      qty: 30,
      unit_cost: 80000,
      additional_cost: 1,
    },
  });
  await rpc('post_purchase', { p_id: receipt.id, p_request_id: uid() });
  customer = await rpc('save_customer', {
    p_workspace_id: w,
    p_payload: { code: 'KH-1', name: 'Khách chính xác' },
  });
  customer2 = await rpc('save_customer', {
    p_workspace_id: w,
    p_payload: { code: 'KH-2', name: 'Khách chính xác' },
  });
  campaign = await rpc('save_live_campaign', {
    p_workspace_id: w,
    p_payload: {
      code: 'LIVE-01',
      name: 'Chiến dịch QA',
      warehouse_id: warehouse,
      status: 'active',
    },
  });
  session = await rpc('save_live_session', {
    p_workspace_id: w,
    p_payload: {
      campaign_id: campaign,
      code: 'AM',
      title: 'Buổi sáng',
      provider: 'manual',
      room_id: '',
      status: 'live',
    },
  });
  session2 = await rpc('save_live_session', {
    p_workspace_id: w,
    p_payload: {
      campaign_id: campaign,
      code: 'PM',
      title: 'Buổi chiều',
      provider: 'manual',
      room_id: '',
      status: 'live',
    },
  });
  const oldOrder = await rpc('save_sales_order', {
    p_workspace_id: w,
    p_payload: {
      code: 'BEFORE-LIVE',
      customer_id: customer,
      warehouse_id: warehouse,
      order_date: '2026-08-18',
      lines: [{ product_id: product.id, qty: 1, unit_price: '120000' }],
    },
  });
  await rpc('transition_sales_order', {
    p_workspace_id: w,
    p_order_id: oldOrder,
    p_action: 'confirm',
    p_payload: { date: '2026-08-18' },
    p_request_id: uid(),
  });
  const oldHold = await rpc('reserve_inventory', {
    p_workspace_id: w,
    p_payload: {
      product_id: product.id,
      warehouse_id: warehouse,
      qty: 1,
      date: '2026-08-18',
      reason: 'Phiếu giữ tồn tại trước migration live',
    },
    p_request_id: uid(),
  });
  const beforeMigration = await snapshot([
    ...financeTables,
    'inventory_reservations',
    'reservation_lots',
    'audit_events',
  ]);
  // The only additive change on old reservation rows is a NULL live-ticket link.
  for (const entry of beforeMigration.inventory_reservations) entry.row.live_ticket_id = null;
  await admin(() => db.exec(migrations[7]));
  await ok(
    '008 upgrades populated Phase B without modifying money, stock, orders or audit',
    async () => {
      const after = await snapshot([
        ...financeTables,
        'inventory_reservations',
        'reservation_lots',
        'audit_events',
      ]);
      assert.deepEqual(after, beforeMigration);
    },
  );
  await ok(
    'Migrations 001–008 also apply cleanly, including optional Realtime publication',
    async () => {
      const clean = new PGlite();
      try {
        await clean.exec(authSql);
        await clean.exec('create publication supabase_realtime');
        for (const sql of migrations) await clean.exec(sql);
        const cols = (
          await clean.query(
            "select attnames from pg_publication_tables where pubname='supabase_realtime' and tablename='live_print_jobs'",
          )
        ).rows[0].attnames;
        assert.ok(!cols.includes('lease_token'));
      } finally {
        await clean.close();
      }
    },
  );
  await ok('Existing manual hold and confirmed order remain operable after 008', async () => {
    await rpc('release_inventory_reservation', {
      p_workspace_id: w,
      p_reservation_id: oldHold,
      p_date: '2026-08-18',
      p_reason: 'Giải phóng phiếu cũ sau kiểm tra nâng cấp',
      p_request_id: uid(),
    });
    await rpc('transition_sales_order', {
      p_workspace_id: w,
      p_order_id: oldOrder,
      p_action: 'cancel',
      p_payload: { date: '2026-08-18', reason: 'Hủy đơn cũ sau nghiệm thu nâng cấp' },
      p_request_id: uid(),
    });
    assert.equal(
      (await select('inventory_reservations')).find((r) => r.id === oldHold).live_ticket_id,
      null,
    );
  });
  const financeBefore = await snapshot(financeTables);
  let first, firstPayload, firstRequest, firstComment;
  await ok(
    'Comment and claim alone never create a sale, cart item, print job or stock hold',
    async () => {
      firstComment = await seedComment();
      const token = await claim(firstComment);
      firstPayload = await command(firstComment, token);
      firstRequest = uid();
      const s = await state();
      assert.equal(s.tickets.length, 0);
      assert.equal(s.carts.length, 0);
      assert.equal(s.print_jobs.length, 0);
      assert.equal(
        (await select('inventory_reservations')).filter((r) => r.status === 'active').length,
        0,
      );
      assert.deepEqual(await snapshot(financeTables), financeBefore);
    },
  );
  await ok(
    'Seller commit atomically creates one ticket/cart/item/hold/job/outbox and no revenue or cash',
    async () => {
      first = await commit(firstPayload, firstRequest);
      const s = await state();
      assert.equal(first.ticket_status, 'committed');
      for (const key of ['campaign_customers', 'carts', 'items', 'tickets', 'print_jobs', 'outbox'])
        assert.equal(s[key].length, 1, key);
      assert.equal(s.carts[0].active_qty, 2);
      assert.equal(s.carts[0].total_amount, '240000');
      assert.equal(s.tickets[0].unit_price, '120000');
      const stock = await rpc('get_sales_state', { p_workspace_id: w });
      assert.equal(stock.inventory[0].on_hand, 30);
      assert.equal(stock.inventory[0].reserved, 2);
      assert.equal(stock.inventory[0].available, 28);
      assert.deepEqual(await snapshot(financeTables), financeBefore);
      assert.equal(s.print_jobs[0].snapshot.lines[0].sku, 'SKU-A');
      assert.equal(s.print_jobs[0].snapshot.total_amount, '240000');
      assert.equal(
        (await select('live_comments')).find((c) => c.id === firstComment).state,
        'committed',
      );
    },
  );
  await ok(
    'Commit retry returns original entities; changed payload or request from another actor is rejected',
    async () => {
      const before = await snapshot([
        ...liveTables,
        'inventory_reservations',
        'reservation_lots',
        'audit_events',
      ]);
      assert.deepEqual(await commit(firstPayload, firstRequest), first);
      assert.deepEqual(
        await snapshot([
          ...liveTables,
          'inventory_reservations',
          'reservation_lots',
          'audit_events',
        ]),
        before,
      );
      await assert.rejects(
        () => commit({ ...firstPayload, qty: 3 }, firstRequest),
        /LIVE_REQUEST_REUSED/,
      );
      await user(users.staff);
      await assert.rejects(() => commit(firstPayload, firstRequest), /LIVE_REQUEST_REUSED/);
      await user();
      await assert.rejects(() => commit(firstPayload), /LIVE_COMMENT_USED/);
    },
  );
  await ok(
    'Claim token, actor and expiry are all enforced before any business mutation',
    async () => {
      const comment = await seedComment('claim-tests');
      const token = await claim(comment);
      const payload = await command(comment, token);
      await assert.rejects(() => commit({ ...payload, claim_token: uid() }), /LIVE_CLAIM_INVALID/);
      await user(users.staff);
      await assert.rejects(() => commit(payload), /LIVE_CLAIM_INVALID/);
      await user();
      await admin(() =>
        db.query(
          "update public.live_comment_claims set expires_at=clock_timestamp()-interval '1 second' where comment_id=$1",
          [comment],
        ),
      );
      const before = await snapshot([...liveTables, 'inventory_reservations', 'audit_events']);
      await assert.rejects(() => commit(payload), /LIVE_CLAIM_INVALID/);
      assert.deepEqual(
        await snapshot([...liveTables, 'inventory_reservations', 'audit_events']),
        before,
      );
    },
  );
  await ok(
    'Stock failure rolls back campaign numbering, cart, hold, audit and request registry together',
    async () => {
      const comment = await seedComment('insufficient'),
        token = await claim(comment);
      const payload = await command(comment, token, { qty: 100 });
      const tables = [
        ...liveTables,
        'inventory_reservations',
        'reservation_lots',
        'audit_events',
        'live_comments',
        'app_private.live_requests',
        'app_private.posting_requests',
        'app_private.inventory_timeline',
      ];
      const before = await snapshot(tables);
      await assert.rejects(() => commit(payload), /LIVE_INSUFFICIENT/);
      assert.deepEqual(await snapshot(tables), before);
    },
  );
  await ok(
    'Staff can commit a properly claimed ticket but still cannot call public manual reserve or VOID',
    async () => {
      await user(users.staff);
      const entry = await createTicket('staff-author', { qty: 1 });
      assert.equal(entry.result.customer_no, 2);
      await assert.rejects(
        () =>
          rpc('reserve_inventory', {
            p_workspace_id: w,
            p_payload: {
              product_id: product.id,
              warehouse_id: warehouse,
              qty: 1,
              date: '2026-08-18',
              reason: 'Direct manual reserve forbidden',
            },
            p_request_id: uid(),
          }),
        /không có quyền/,
      );
      await assert.rejects(() => voidTicket(entry.result.ticket_id), /không có quyền/);
      await user();
    },
  );
  await ok(
    'Same stable author across campaign sessions keeps customer number/cart; display-name matches never merge',
    async () => {
      const c = await seedComment('author-A', session2, {
        author_display_name: 'Tên hiển thị thay đổi',
      });
      const t = await claim(c);
      const second = await commit(await command(c, t, { qty: 1 }));
      assert.equal(second.customer_no, first.customer_no);
      assert.equal(second.cart_id, first.cart_id);
      const third = await createTicket('another-stable-id', { qty: 1 });
      assert.notEqual(third.result.customer_no, first.customer_no);
      assert.notEqual(third.result.cart_id, first.cart_id);
      assert.equal(
        (await state()).carts.find((x) => x.id === first.cart_id).total_amount,
        '360000',
      );
      assert.equal((await select('customers')).length, 2);
    },
  );
  await ok(
    'Committed live holds cannot be released or transferred through Phase B inventory RPCs',
    async () => {
      await assert.rejects(
        () =>
          rpc('release_inventory_reservation', {
            p_workspace_id: w,
            p_reservation_id: first.reservation_id,
            p_date: '2026-08-18',
            p_reason: 'Attempt bypass live ticket ownership',
            p_request_id: uid(),
          }),
        /LIVE_HOLD_PROTECTED/,
      );
      const order = await rpc('save_sales_order', {
        p_workspace_id: w,
        p_payload: {
          code: 'BYPASS',
          customer_id: customer,
          warehouse_id: warehouse,
          order_date: '2026-08-18',
          lines: [{ product_id: product.id, qty: 2, unit_price: '120000' }],
        },
      });
      await assert.rejects(
        () =>
          rpc('transfer_inventory_reservations', {
            p_workspace_id: w,
            p_order_id: order,
            p_reservation_ids: [first.reservation_id],
            p_date: '2026-08-18',
            p_request_id: uid(),
          }),
        /LIVE_HOLD_PROTECTED/,
      );
      assert.equal((await select('sales_orders')).find((o) => o.id === order).status, 'draft');
    },
  );
  await ok(
    'Print snapshot and ticket values remain immutable when SKU/customer master labels change',
    async () => {
      const before = (await state()).print_jobs[0].snapshot;
      await rpc('save_master', {
        p_kind: 'products',
        p_payload: { ...product, workspace_id: w, name: 'Tên sản phẩm mới', unit_cost: 99000 },
      });
      assert.deepEqual(
        (await state()).print_jobs.find((j) => j.id === first.print_job_id).snapshot,
        before,
      );
      await admin(async () => {
        await assert.rejects(
          () =>
            db.query('update public.live_sale_tickets set qty=qty+1 where id=$1', [
              first.ticket_id,
            ]),
          /LIVE_IMMUTABLE/,
        );
        await assert.rejects(
          () =>
            db.query("update public.live_print_jobs set snapshot='{}' where id=$1", [
              first.print_job_id,
            ]),
          /LIVE_PRINT_IMMUTABLE/,
        );
      });
    },
  );
  let lease;
  await ok(
    'Print claim is exclusive and replay-safe; fencing tokens do not appear in shared reads or REST',
    async () => {
      const request = uid();
      lease = await printClaim(first.print_job_id, request);
      assert.deepEqual(await printClaim(first.print_job_id, request), lease);
      await assert.rejects(() => printClaim(first.print_job_id), /LIVE_PRINT_STATE/);
      await user(users.staff);
      await assert.rejects(() => finish(first.print_job_id, lease.lease_token), /LIVE_PRINT_LEASE/);
      await user();
      assert.equal(
        (await state()).print_jobs.find((j) => j.id === first.print_job_id).lease_token,
        undefined,
      );
      await assert.rejects(
        () => db.query('select lease_token from public.live_print_jobs'),
        /permission denied/,
      );
      await assert.rejects(() => voidTicket(first.ticket_id), /LIVE_PRINT_IN_PROGRESS/);
      await assert.rejects(() => requeue(first.print_job_id), /LIVE_PRINT_BUSY/);
    },
  );
  await ok(
    'Direct hold relinking or quantity mutation cannot bypass its committed live ticket',
    async () => {
      await admin(async () => {
        await assert.rejects(
          () =>
            db.query('update public.inventory_reservations set live_ticket_id=null where id=$1', [
              first.reservation_id,
            ]),
          /LIVE_HOLD_PROTECTED/,
        );
        await assert.rejects(
          () =>
            db.query('update public.inventory_reservations set qty=qty+1 where id=$1', [
              first.reservation_id,
            ]),
          /LIVE_HOLD_PROTECTED/,
        );
      });
    },
  );
  await ok(
    'Printer failure preserves ticket/cart/hold; requeue and successful reprint never duplicate a sale',
    async () => {
      const business = await snapshot([
        'live_sale_tickets',
        'customer_cart_items',
        'inventory_reservations',
        'reservation_lots',
      ]);
      await finish(first.print_job_id, lease.lease_token, 'failed');
      assert.equal(
        (await state()).print_jobs.find((j) => j.id === first.print_job_id).status,
        'failed',
      );
      const request = uid();
      await requeue(first.print_job_id, request);
      await requeue(first.print_job_id, request);
      lease = await printClaim(first.print_job_id);
      const done = uid();
      await finish(first.print_job_id, lease.lease_token, 'printed', done);
      await finish(first.print_job_id, lease.lease_token, 'printed', done);
      let s = await state();
      assert.equal(s.print_jobs.find((j) => j.id === first.print_job_id).status, 'printed');
      assert.equal(s.print_jobs.find((j) => j.id === first.print_job_id).reprint_count, 1);
      assert.equal(s.print_attempts.filter((a) => a.job_id === first.print_job_id).length, 2);
      assert.deepEqual(
        await snapshot([
          'live_sale_tickets',
          'customer_cart_items',
          'inventory_reservations',
          'reservation_lots',
        ]),
        business,
      );
    },
  );
  await ok(
    'Expired print can finish using its still-current fencing token after a long dialog',
    async () => {
      await requeue(first.print_job_id);
      const claimRequest = uid();
      lease = await printClaim(first.print_job_id, claimRequest);
      await admin(() =>
        db.query(
          "update public.live_print_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",
          [first.print_job_id],
        ),
      );
      await finish(first.print_job_id, lease.lease_token, 'printed');
      assert.equal(
        (await state()).print_jobs.find((j) => j.id === first.print_job_id).status,
        'printed',
      );
      await assert.rejects(
        () => printClaim(first.print_job_id, claimRequest),
        /LIVE_PRINT_REQUEST_STALE/,
      );
    },
  );
  await ok(
    'Expired requeue records unknown paper outcome; old tokens cannot finish or overwrite a replacement attempt',
    async () => {
      await requeue(first.print_job_id);
      const old = await printClaim(first.print_job_id);
      await admin(() =>
        db.query(
          "update public.live_print_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",
          [first.print_job_id],
        ),
      );
      await assert.rejects(() => printClaim(first.print_job_id), /LIVE_PRINT_STATE/);
      await assert.rejects(() => voidTicket(first.ticket_id), /LIVE_PRINT_IN_PROGRESS/);
      await requeue(first.print_job_id);
      lease = await printClaim(first.print_job_id);
      await assert.rejects(() => finish(first.print_job_id, old.lease_token), /LIVE_PRINT_LEASE/);
      assert.equal(
        (await state()).print_attempts.find((a) => a.id === old.attempt_id).status,
        'unknown',
      );
      await finish(first.print_job_id, lease.lease_token, 'unknown');
    },
  );
  await ok(
    'VOID retains ticket/comment history, releases once, cancels print, and removes only its active cart item',
    async () => {
      const before = await snapshot(financeTables),
        request = uid();
      await voidTicket(first.ticket_id, request);
      await voidTicket(first.ticket_id, request);
      await voidTicket(first.ticket_id);
      const s = await state();
      assert.equal(s.tickets.find((t) => t.id === first.ticket_id).status, 'voided');
      assert.equal(s.print_jobs.find((j) => j.id === first.print_job_id).status, 'cancelled');
      assert.equal(s.items.find((i) => i.ticket_id === first.ticket_id).status, 'voided');
      assert.equal(s.carts.find((c) => c.id === first.cart_id).total_amount, '120000');
      assert.equal(
        (await select('inventory_reservations')).find((r) => r.id === first.reservation_id).status,
        'released',
      );
      assert.equal(
        s.outbox.filter((e) => e.ticket_id === first.ticket_id && e.event_type === 'voided').length,
        1,
      );
      assert.deepEqual(await snapshot(financeTables), before);
      const replay = await commit(firstPayload, firstRequest);
      assert.equal(replay.ticket_id, first.ticket_id);
      assert.equal(replay.ticket_status, 'voided');
      await assert.rejects(() => commit(firstPayload), /LIVE_COMMENT_USED/);
      await assert.rejects(() => printClaim(first.print_job_id), /LIVE_PRINT_STATE/);
      await assert.rejects(() => requeue(first.print_job_id), /LIVE_PRINT_STATE/);
    },
  );
  await ok(
    'Duplicate provider delivery after VOID returns the original comment and cannot reclaim/recommit it',
    async () => {
      const c = (await select('live_comments')).find((c) => c.id === firstComment);
      const replay = await rpc('ingest_live_comments', {
        p_workspace_id: w,
        p_session_id: session,
        p_comments: [
          {
            message_id: c.provider_message_id,
            author_external_id: c.author_external_id,
            author_display_name: c.author_display_name,
            text: c.raw_text,
            occurred_at: c.occurred_at,
          },
        ],
      });
      assert.deepEqual(replay.ids, [firstComment]);
      assert.equal(replay.duplicates, 1);
      await assert.rejects(() => claim(firstComment));
      assert.equal((await state()).tickets.filter((t) => t.comment_id === firstComment).length, 1);
    },
  );
  await ok('A previous V2 request UUID cannot be reused by a new live commit', async () => {
    const request = uid();
    const hold = await rpc('reserve_inventory', {
      p_workspace_id: w,
      p_payload: {
        product_id: product.id,
        warehouse_id: warehouse,
        qty: 1,
        date: '2026-08-18',
        reason: 'Manual hold before request reuse test',
      },
      p_request_id: request,
    });
    assert.ok(hold);
    const c = await seedComment('request-reuse'),
      token = await claim(c);
    const before = await snapshot([...liveTables, 'inventory_reservations', 'audit_events']);
    const payload = await command(c, token);
    await assert.rejects(() => commit(payload, request), /request_id/);
    assert.deepEqual(
      await snapshot([...liveTables, 'inventory_reservations', 'audit_events']),
      before,
    );
  });
  await ok(
    'Invalid quantities/prices/evidence and future dates create no partial sale',
    async () => {
      const c = await seedComment('invalid-input'),
        token = await claim(c),
        base = await command(c, token);
      const before = await snapshot([...liveTables, 'inventory_reservations', 'audit_events']);
      for (const patch of [
        { qty: 0 },
        { qty: 1.5 },
        { qty: true },
        { qty: '1000001' },
        { unit_price: 0 },
        { unit_price: '1.5' },
        { qty: 1000000, unit_price: '9000000000000' },
        { review_note: 'short' },
        { date: '2099-01-01' },
        { customer_id: uid() },
      ])
        await assert.rejects(() => commit({ ...base, ...patch }));
      assert.deepEqual(
        await snapshot([...liveTables, 'inventory_reservations', 'audit_events']),
        before,
      );
    },
  );
  await ok('Unreviewed variant, provisional SKU and ended session cannot commit', async () => {
    const c = await seedComment('master-gates'),
      token = await claim(c),
      payload = await command(c, token);
    await rpc('save_product_variant', {
      p_workspace_id: w,
      p_payload: {
        product_id: product.id,
        style_id: style,
        size: 'M',
        color: 'Xanh',
        mapping_status: 'needs_review',
        review_note: '',
      },
    });
    await assert.rejects(() => commit(payload), /LIVE_VARIANT/);
    await rpc('save_product_variant', {
      p_workspace_id: w,
      p_payload: {
        product_id: product.id,
        style_id: style,
        size: 'M',
        color: 'Xanh',
        mapping_status: 'confirmed',
        review_note: 'Đã kiểm tra lại mã và màu cỡ.',
      },
    });
    await rpc('save_master', {
      p_kind: 'products',
      p_payload: { ...product, workspace_id: w, provisional: true },
    });
    await assert.rejects(() => commit(payload), /LIVE_SKU/);
    await rpc('save_master', {
      p_kind: 'products',
      p_payload: { ...product, workspace_id: w, provisional: false },
    });
    await admin(() =>
      db.query("update public.live_sessions set status='ended' where id=$1", [session]),
    );
    await assert.rejects(() => commit(payload), /LIVE_NOT_ACTIVE/);
    await admin(() =>
      db.query("update public.live_sessions set status='live' where id=$1", [session]),
    );
  });
  await ok(
    'Exact TikTok identity forbids selecting a different customer; known names never create a customer',
    async () => {
      await rpc('save_customer_identity', {
        p_workspace_id: w,
        p_payload: {
          customer_id: customer,
          channel: 'TIKTOK_LIVE_USER',
          external_id: 'tiktok-stable-1',
          verified: true,
          verification_note: 'Khách xác minh tài khoản TikTok này.',
        },
      });
      const account = await rpc('save_live_integration_account', {
        p_workspace_id: w,
        p_payload: { name: 'Tài khoản thử', username: 'chidi.qa', enabled: true },
      });
      const sid = await rpc('save_live_session', {
        p_workspace_id: w,
        p_payload: {
          campaign_id: campaign,
          code: 'TIKTOK',
          title: 'Phiên TikTok QA',
          provider: 'tiktok_live',
          integration_account_id: account,
          room_id: 'chidi.qa',
          status: 'live',
        },
      });
      const c = await seedComment('tiktok-stable-1', sid),
        token = await claim(c),
        payload = await command(c, token, { customer_id: customer2, qty: 1 });
      await assert.rejects(() => commit(payload), /LIVE_IDENTITY_CONFLICT/);
      const valid = await commit({ ...payload, customer_id: customer });
      const t = (await state()).tickets.find((t) => t.id === valid.ticket_id);
      assert.equal(t.customer_id, customer);
      assert.equal(t.customer_snapshot.name, 'Khách chính xác');
      assert.equal((await select('customers')).length, 2);
    },
  );
  await ok(
    'Two serialized claims contesting the last available unit result in exactly one ticket',
    async () => {
      const p = await rpc('save_master', {
        p_kind: 'products',
        p_payload: {
          workspace_id: w,
          code: 'LAST-ONE',
          name: 'Một sản phẩm',
          unit_cost: 1,
          provisional: false,
        },
      });
      await rpc('save_product_variant', {
        p_workspace_id: w,
        p_payload: {
          product_id: p.id,
          style_id: style,
          size: 'XL',
          color: 'Đen',
          mapping_status: 'confirmed',
          review_note: 'Mã hàng duy nhất đã được kiểm đếm.',
        },
      });
      const receipt = await rpc('create_purchase', {
        p_payload: {
          workspace_id: w,
          supplier_id: supplier.id,
          product_id: p.id,
          warehouse_id: warehouse,
          received_date: '2026-08-18',
          date_estimated: false,
          qty: 1,
          unit_cost: 1,
          additional_cost: 0,
        },
      });
      await rpc('post_purchase', { p_id: receipt.id, p_request_id: uid() });
      const a = await seedComment('last-a'),
        b = await seedComment('last-b');
      const at = await claim(a),
        bt = await claim(b);
      const commandB = await command(b, bt, { product_id: p.id, qty: 1, unit_price: 1 });
      await commit(await command(a, at, { product_id: p.id, qty: 1, unit_price: 1 }));
      await assert.rejects(() => commit(commandB), /LIVE_INSUFFICIENT/);
      assert.equal((await state()).tickets.filter((t) => t.product_id === p.id).length, 1);
    },
  );
  await ok(
    'Viewer cannot claim/commit/print/void while safe state reads remain available',
    async () => {
      await user(users.viewer);
      assert.ok((await state()).tickets.length);
      await assert.rejects(() => commit(firstPayload), /không có quyền/);
      await assert.rejects(() => printClaim(first.print_job_id), /không có quyền/);
      await assert.rejects(() => finish(first.print_job_id, uid()), /không có quyền/);
      await assert.rejects(() => requeue(first.print_job_id), /không có quyền/);
      await assert.rejects(() => voidTicket(first.ticket_id), /không có quyền/);
      await user();
    },
  );
  await ok(
    'Workspace isolation blocks reads and mutations even with known IDs; clients cannot write tables directly',
    async () => {
      await user(users.other);
      await assert.rejects(() => state(), /không có quyền/);
      await assert.rejects(() => commit(firstPayload), /không có quyền/);
      await assert.rejects(() => printClaim(first.print_job_id), /không có quyền/);
      for (const table of liveTables)
        assert.equal(
          (await db.query(`select id from public.${table} where workspace_id=$1`, [w])).rows.length,
          0,
        );
      await user();
      for (const table of liveTables) {
        await assert.rejects(
          () => db.query(`delete from public.${table} where workspace_id=$1`, [w]),
          /permission denied/,
        );
        await assert.rejects(
          () =>
            db.query(`update public.${table} set workspace_id=workspace_id where workspace_id=$1`, [
              w,
            ]),
          /permission denied/,
        );
      }
      await assert.rejects(
        () =>
          db.query('select app_private.reserve_live_inventory($1,$2,$3,1,$4,$5,$6)', [
            w,
            product.id,
            warehouse,
            '2026-08-18',
            'X',
            'Forbidden direct helper',
          ]),
        /permission denied/,
      );
      await assert.rejects(
        () => db.query('select * from app_private.live_requests'),
        /permission denied/,
      );
    },
  );
  await ok('Anonymous cannot read live tables or execute business RPCs', async () => {
    await db.exec('reset role;set role anon');
    for (const table of liveTables)
      await assert.rejects(() => db.query(`select id from public.${table}`), /permission denied/);
    await assert.rejects(() => state(), /permission denied/);
    await assert.rejects(() => commit(firstPayload), /permission denied/);
    await assert.rejects(() => printClaim(first.print_job_id), /permission denied/);
    await user();
  });
  await mkdir(new URL('../test-results/', import.meta.url), { recursive: true });
  await writeFile(
    new URL('../test-results/live-commerce.json', import.meta.url),
    JSON.stringify(
      {
        status: 'PASS',
        checks: checks.length,
        names: checks,
        migrations: names,
        engine: 'PGlite PostgreSQL, simulated Auth, no external calls',
        limitations:
          'Single connection verifies serial business contention only; real multi-session races, Supabase JWT/RLS transport and physical printer require separate acceptance.',
      },
      null,
      2,
    ),
  );
  console.log(`Live commerce: ${checks.length}/${checks.length} PASS`);
} catch (error) {
  console.error('FAIL', error.message, error.code || '', error.where || '');
  process.exitCode = 1;
} finally {
  await db.close();
}
