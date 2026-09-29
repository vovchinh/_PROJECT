// Disposable local PostgreSQL only. Never reads .env or connects to Supabase.
import { PGlite } from '@electric-sql/pglite';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';

const migrationNames = [
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
  migrationNames.map((name) =>
    readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'),
  ),
);
const verification = await readFile(
  new URL('../supabase/verification/verify_phase_c.sql', import.meta.url),
  'utf8',
);
const db = new PGlite();
const owner = '11111111-1111-4111-8111-111111111111';
const uid = () => crypto.randomUUID();
const checks = [];
let w, campaign, session, product, warehouse, healthy;
const sensitive = [
  'PRIVATE_AUTHOR_NAME',
  'PRIVATE_COMMENT_BODY',
  'PRIVATE_PRODUCT_NAME',
  'PRIVATE_CAMPAIGN_NAME',
];
async function ok(name, fn) {
  await fn();
  checks.push(name);
  console.log('PASS', name);
}
async function rpc(name, args) {
  return (
    await db.query(
      `select public.${name}(${Object.keys(args)
        .map((key, i) => `${key}=>$${i + 1}`)
        .join(',')}) result`,
      Object.values(args).map((v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v)),
    )
  ).rows[0].result;
}
async function verify() {
  const results = await db.exec(verification);
  const result = results
    .flatMap((r) => r.rows)
    .find((r) => r.phase_c_verification)?.phase_c_verification;
  assert.ok(result, 'One aggregate JSON result is required');
  return result;
}
function pass(result) {
  assert.equal(
    result.status,
    'PASS',
    JSON.stringify({ security: result.security_checks, reconciliation: result.reconciliation }),
  );
  assert.equal(result.failed_checks, 0);
}
function failure(result, group, name, minimum = 1) {
  assert.equal(result.status, 'FAIL');
  assert.ok(result[group][name] >= minimum, `${name}: ${JSON.stringify(result[group])}`);
}
async function snapshot() {
  const names = (
    await db.query(
      "select schemaname,tablename from pg_tables where schemaname in ('public','app_private') order by schemaname,tablename",
    )
  ).rows;
  const result = {};
  for (const { schemaname, tablename } of names)
    result[`${schemaname}.${tablename}`] = (
      await db.query(
        `select to_jsonb(t) row from ${schemaname}.${tablename} t order by to_jsonb(t)::text`,
      )
    ).rows;
  return result;
}
async function ticket(author = uid()) {
  const comment = (
    await rpc('ingest_live_comments', {
      p_workspace_id: w,
      p_session_id: session,
      p_comments: [
        {
          message_id: uid(),
          author_external_id: author,
          author_display_name: sensitive[0],
          text: sensitive[1],
          occurred_at: '2026-08-18T01:00:00Z',
        },
      ],
    })
  ).ids[0];
  const claim = await rpc('claim_live_comment', { p_workspace_id: w, p_comment_id: comment });
  sensitive.push(comment, claim.claim_token, author);
  return rpc('commit_live_sale_ticket', {
    p_workspace_id: w,
    p_payload: {
      comment_id: comment,
      claim_token: claim.claim_token,
      product_id: product.id,
      qty: 2,
      unit_price: '120000',
      date: '2026-08-18',
      customer_id: null,
      review_note: 'Seller reviewed exact SKU and price.',
    },
    p_request_id: uid(),
  });
}
async function claimPrint(job) {
  const claim = await rpc('claim_live_print_job', {
    p_workspace_id: w,
    p_job_id: job,
    p_request_id: uid(),
  });
  sensitive.push(claim.lease_token, claim.attempt_id);
  return claim;
}
async function finish(job, token, outcome) {
  return rpc('finish_live_print_job', {
    p_workspace_id: w,
    p_job_id: job,
    p_lease_token: token,
    p_outcome: outcome,
    p_detail: 'Operator checked the physical print result.',
    p_request_id: uid(),
  });
}

try {
  await db.exec(`create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to authenticated,anon; grant execute on function auth.uid() to authenticated,anon;
    create publication supabase_realtime;`);
  await db.query('insert into auth.users values($1,$2,now())', [owner, 'owner@private.example']);
  for (const migration of migrations) await db.exec(migration);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [owner]);
  await ok(
    'Installed 001–008 empty database passes metadata, grants, masked tokens and reconciliation',
    async () => {
      const result = await verify();
      pass(result);
      assert.equal(result.tables.length, 12);
      assert.equal(result.routines.length, 20);
      assert.equal(result.workspace_links.length, 22);
      assert.equal(result.duplicate_protection.length, 12);
      assert.equal(result.immutable_triggers.length, 3);
      assert.equal(result.publications.length, 1);
      assert.equal(result.publications[0].exposed_token_tables, 0);
    },
  );
  w = (await rpc('bootstrap_workspace', { p_name: 'PRIVATE_WORKSPACE_NAME' })).id;
  warehouse = (await db.query('select id from public.warehouses where workspace_id=$1', [w]))
    .rows[0].id;
  const supplier = await rpc('save_master', {
    p_kind: 'suppliers',
    p_payload: { workspace_id: w, code: 'SUP', name: 'PRIVATE_SUPPLIER_NAME' },
  });
  product = await rpc('save_master', {
    p_kind: 'products',
    p_payload: {
      workspace_id: w,
      code: 'PRIVATE_SKU',
      name: sensitive[2],
      supplier_id: supplier.id,
      unit_cost: 80000,
      provisional: false,
    },
  });
  const style = await rpc('save_product_style', {
    p_workspace_id: w,
    p_payload: { code: 'STYLE', name: 'PRIVATE_STYLE_NAME' },
  });
  await rpc('save_product_variant', {
    p_workspace_id: w,
    p_payload: {
      product_id: product.id,
      style_id: style,
      size: 'M',
      color: 'Blue',
      mapping_status: 'confirmed',
      review_note: 'Variant mapping checked against source.',
    },
  });
  const purchase = await rpc('create_purchase', {
    p_payload: {
      workspace_id: w,
      supplier_id: supplier.id,
      product_id: product.id,
      warehouse_id: warehouse,
      received_date: '2026-08-18',
      date_estimated: false,
      qty: 30,
      unit_cost: 80000,
      additional_cost: 0,
    },
  });
  await rpc('post_purchase', { p_id: purchase.id, p_request_id: uid() });
  campaign = await rpc('save_live_campaign', {
    p_workspace_id: w,
    p_payload: { code: 'LIVE', name: sensitive[3], warehouse_id: warehouse, status: 'active' },
  });
  session = await rpc('save_live_session', {
    p_workspace_id: w,
    p_payload: {
      campaign_id: campaign,
      code: 'SESSION',
      title: 'PRIVATE_SESSION_NAME',
      provider: 'manual',
      room_id: '',
      status: 'live',
    },
  });
  const first = await ticket('PRIVATE_STABLE_AUTHOR');
  const second = await ticket('PRIVATE_STABLE_AUTHOR');
  const third = await ticket();
  sensitive.push(
    owner,
    w,
    campaign,
    session,
    product.id,
    first.ticket_id,
    first.ticket_no,
    first.print_job_id,
    first.cart_id,
    first.reservation_id,
  );
  await ok(
    'Committed and VOID tickets reconcile exact items, holds, carts, print jobs and outbox',
    async () => {
      await rpc('void_live_sale_ticket', {
        p_workspace_id: w,
        p_ticket_id: second.ticket_id,
        p_date: '2026-08-18',
        p_reason: 'Customer explicitly cancelled this ticket.',
        p_request_id: uid(),
      });
      healthy = await verify();
      pass(healthy);
      assert.deepEqual(healthy.counts, {
        comments: 3,
        committed_tickets: 2,
        voided_tickets: 1,
        carts: 2,
        committed_ticket_qty: 4,
        active_cart_item_qty: 4,
        active_live_hold_qty: 4,
        print_jobs: 3,
        print_attempts: 0,
        outbox_events: 4,
      });
    },
  );
  await ok(
    'Printing, operator-confirmed paper, failure and explicit retry all reconcile',
    async () => {
      const firstClaim = await claimPrint(first.print_job_id);
      pass(await verify());
      await finish(first.print_job_id, firstClaim.lease_token, 'printed');
      const failedClaim = await claimPrint(third.print_job_id);
      await finish(third.print_job_id, failedClaim.lease_token, 'failed');
      const failed = await verify();
      pass(failed);
      assert.equal(failed.warnings.failed_or_unknown_print_jobs_need_operator_review, 1);
      await rpc('requeue_live_print_job', {
        p_workspace_id: w,
        p_job_id: third.print_job_id,
        p_reason: 'Operator checked paper before retry.',
        p_request_id: uid(),
      });
      const nextClaim = await claimPrint(third.print_job_id);
      await db.query(
        "update public.live_print_jobs set lease_expires_at=now()-interval '1 second' where id=$1",
        [third.print_job_id],
      );
      const expired = await verify();
      pass(expired);
      assert.equal(expired.warnings.expired_print_leases_need_operator_reconciliation, 1);
      await finish(third.print_job_id, nextClaim.lease_token, 'printed');
      pass(await verify());
    },
  );
  await ok(
    'Verification has no data side effects and exports no names, IDs, comments, receipt text or tokens',
    async () => {
      const before = await snapshot();
      healthy = await verify();
      pass(healthy);
      assert.deepEqual(await snapshot(), before);
      const output = JSON.stringify(healthy);
      for (const value of sensitive)
        assert.ok(!output.includes(value), `Sensitive fixture value leaked: ${value}`);
      assert.match(verification, /begin transaction isolation level repeatable read read only;/i);
      assert.doesNotMatch(
        verification,
        /(?:create|alter|drop|insert|update|delete)\s+(?:table|function|trigger|into|from|public\.)/i,
      );
    },
  );
  await ok(
    'Snapshot reconciliation compares timestamp instants across operator time zones',
    async () => {
      await db.exec("set time zone 'Asia/Bangkok'");
      try {
        pass(await verify());
      } finally {
        await db.exec("set time zone 'UTC'");
      }
    },
  );
  await ok(
    'Broad table SELECT exposing a claim token and writable columns are detected',
    async () => {
      await db.exec(
        'grant select on public.live_comment_claims to authenticated; grant update(raw_text) on public.live_comments to authenticated',
      );
      const result = await verify();
      failure(result, 'security_checks', 'table_rls_grants_or_policy_mismatch', 2);
      assert.equal(
        result.tables.find((t) => t.name === 'live_comment_claims').masked_column_readable,
        true,
      );
      await db.exec(
        'revoke select on public.live_comment_claims from authenticated; grant select(workspace_id,comment_id,claimed_by,expires_at,created_at,updated_at) on public.live_comment_claims to authenticated; revoke update(raw_text) on public.live_comments from authenticated',
      );
      pass(await verify());
    },
  );
  await ok('Disabled RLS and an overbroad authenticated policy are detected', async () => {
    await db.exec(
      'alter table public.customer_carts disable row level security; create policy unsafe_qa on public.live_comments for select to authenticated using(true)',
    );
    failure(await verify(), 'security_checks', 'table_rls_grants_or_policy_mismatch', 2);
    await db.exec(
      'alter table public.customer_carts enable row level security; drop policy unsafe_qa on public.live_comments',
    );
    pass(await verify());
  });
  await ok(
    'PUBLIC RPC execution, direct private helper execution and registry SELECT are detected',
    async () => {
      await db.exec(
        'grant execute on function public.commit_live_sale_ticket(uuid,jsonb,uuid) to public; grant execute on function app_private.protect_live_hold() to authenticated; grant select on app_private.live_requests to authenticated',
      );
      const result = await verify();
      failure(result, 'security_checks', 'routine_grants_or_configuration_mismatch', 2);
      failure(result, 'security_checks', 'private_request_registry_exposed');
      await db.exec(
        'revoke execute on function public.commit_live_sale_ticket(uuid,jsonb,uuid) from public; revoke execute on function app_private.protect_live_hold() from authenticated; revoke select on app_private.live_requests from authenticated',
      );
      pass(await verify());
    },
  );
  await ok('A dropped tenant FK and disabled hold trigger are detected', async () => {
    await db.exec(
      'alter table public.inventory_reservations drop constraint inventory_reservation_live_ticket; alter table public.inventory_reservations disable trigger protect_live_hold',
    );
    const result = await verify();
    failure(result, 'security_checks', 'missing_or_unvalidated_workspace_links');
    failure(result, 'security_checks', 'missing_immutable_or_hold_trigger');
    await db.exec(
      'alter table public.inventory_reservations add constraint inventory_reservation_live_ticket foreign key(workspace_id,live_ticket_id) references public.live_sale_tickets(workspace_id,id); alter table public.inventory_reservations enable trigger protect_live_hold',
    );
    pass(await verify());
  });
  await ok(
    'Every publication is audited, including accidental token publication outside Supabase Realtime',
    async () => {
      await db.exec(
        'create publication unsafe_qa for table public.live_print_jobs,public.live_comment_claims,app_private.live_requests',
      );
      const result = await verify();
      failure(result, 'security_checks', 'publication_exposes_private_tokens_or_requests', 3);
      const unsafe = result.publications.find((p) => p.name === 'unsafe_qa');
      assert.equal(unsafe.exposed_token_tables, 2);
      assert.equal(unsafe.exposed_request_registry, 1);
      await db.exec('drop publication unsafe_qa');
      pass(await verify());
    },
  );
  await ok(
    'FOR ALL TABLES publication is flagged; missing Realtime alone is an honest polling warning',
    async () => {
      await db.exec('create publication unsafe_all_qa for all tables');
      const result = await verify();
      failure(result, 'security_checks', 'publication_exposes_private_tokens_or_requests', 3);
      assert.equal(result.publications.find((p) => p.name === 'unsafe_all_qa').all_tables, true);
      await db.exec('drop publication unsafe_all_qa; drop publication supabase_realtime');
      const polling = await verify();
      pass(polling);
      assert.equal(polling.warnings.realtime_not_configured_polling_required, 1);
      assert.equal(polling.warnings.claims_or_print_jobs_unpublished_polling_required, 2);
      await db.exec('create publication supabase_realtime');
      const incomplete = await verify();
      pass(incomplete);
      assert.equal(incomplete.warnings.realtime_expected_tables_missing_polling_required, 6);
    },
  );
  await ok(
    'Cart item quantity corruption is detected even when database row constraints still pass',
    async () => {
      await db.query(
        'update public.customer_cart_items set qty=qty+1,line_total=(qty+1)*unit_price where ticket_id=$1',
        [first.ticket_id],
      );
      const result = await verify();
      failure(result, 'reconciliation', 'ticket_item_mismatch');
      failure(result, 'reconciliation', 'cart_quantity_or_amount_mismatch');
      await db.query(
        'update public.customer_cart_items set qty=qty-1,line_total=(qty-1)*unit_price where ticket_id=$1',
        [first.ticket_id],
      );
      pass(await verify());
    },
  );
  await ok(
    'Missing outbox event and excess reserved lot quantity are detected without exporting rows',
    async () => {
      const event = (
        await db.query(
          "delete from public.live_outbox_events where ticket_id=$1 and event_type='committed' returning *",
          [first.ticket_id],
        )
      ).rows[0];
      await db.query('update public.reservation_lots set qty=qty+100 where reservation_id=$1', [
        first.reservation_id,
      ]);
      const result = await verify();
      failure(result, 'reconciliation', 'ticket_outbox_mismatch');
      failure(result, 'reconciliation', 'hold_allocation_quantity_mismatch');
      failure(result, 'reconciliation', 'negative_available_lots');
      await db.query(
        'insert into public.live_outbox_events select * from jsonb_populate_record(null::public.live_outbox_events,$1::jsonb)',
        [JSON.stringify(event)],
      );
      await db.query('update public.reservation_lots set qty=qty-100 where reservation_id=$1', [
        first.reservation_id,
      ]);
      pass(await verify());
    },
  );
  await ok(
    'RLS-filtered authenticated execution cannot produce a misleading administrator PASS',
    async () => {
      await db.exec('set role authenticated');
      try {
        failure(await verify(), 'security_checks', 'administrator_visibility_required');
      } finally {
        await db.exec('reset role');
      }
      pass(await verify());
    },
  );
  await mkdir(new URL('../test-results/', import.meta.url), { recursive: true });
  await writeFile(
    new URL('../test-results/live-verification.json', import.meta.url),
    JSON.stringify(
      {
        status: 'PASS',
        checks: checks.length,
        names: checks,
        engine: 'Disposable PGlite PostgreSQL; simulated Auth; no external calls',
        limitations:
          'Schema/aggregate verification only. Real Auth transport, independent concurrent connections, provider access and physical print require separate acceptance.',
        healthy_verification: healthy,
      },
      null,
      2,
    ),
  );
  console.log(`Live operator verification: ${checks.length}/${checks.length} PASS`);
} catch (error) {
  console.error('FAIL', error.message, error.code || '', error.where || '');
  process.exitCode = 1;
} finally {
  await db.close();
}
