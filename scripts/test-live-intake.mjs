// Phase C intake tests: disposable PostgreSQL/PGlite, simulated auth, no cloud.
import { PGlite } from '@electric-sql/pglite';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const directory = new URL('../supabase/migrations/', import.meta.url);
const files = (await readdir(directory)).filter((name) => /^00[1-7]_.*\.sql$/.test(name)).sort();
const migrations = await Promise.all(
  files.map(async (name) => {
    const bytes = await readFile(new URL(name, directory));
    return {
      name,
      sql: bytes.toString('utf8'),
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  }),
);
const db = new PGlite();
const checks = [];
const users = Object.fromEntries(
  ['owner', 'other', 'manager', 'staff', 'viewer'].map((role) => [role, randomUUID()]),
);
const protectedTables = [
  'products',
  'customers',
  'purchase_receipts',
  'stock_movements',
  'inventory_lots',
  'cash_transactions',
  'cash_movements',
  'sales_orders',
  'sales_order_lines',
  'sales_events',
  'sales_allocations',
  'inventory_reservations',
  'reservation_lots',
];
const liveTables = [
  'live_integration_accounts',
  'live_campaigns',
  'live_sessions',
  'live_comments',
  'live_comment_claims',
];
let stage = 'setup';
async function ok(name, run) {
  try {
    await run();
    checks.push({ name, status: 'PASS' });
    console.log('PASS', name);
  } catch (error) {
    checks.push({ name, status: 'FAIL', detail: error.message, code: error.code });
    throw error;
  }
}
async function user(id = users.owner) {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
  await db.exec('set role authenticated');
}
async function rpc(name, args) {
  const keys = Object.keys(args);
  return (
    await db.query(
      `select public.${name}(${keys.map((key, i) => `${key}=>$${i + 1}`).join(',')}) as value`,
      Object.values(args).map((v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v)),
    )
  ).rows[0].value;
}
async function snapshot(tables = protectedTables) {
  await db.exec('reset role');
  const result = {};
  for (const table of tables)
    result[table] = (
      await db.query(`select to_jsonb(t) row from public.${table} t order by to_jsonb(t)::text`)
    ).rows;
  await user();
  return result;
}
const message = (id, overrides = {}) => ({
  message_id: id,
  author_external_id: '9223372036854775807123',
  author_display_name: 'Khách mẫu',
  text: '  CV27 size M x2  ',
  occurred_at: '2026-08-20T10:00:00Z',
  ...overrides,
});

try {
  await db.exec(`create role anon;create role authenticated;create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to authenticated,anon;grant execute on function auth.uid() to authenticated,anon;`);
  for (const [role, id] of Object.entries(users))
    await db.query('insert into auth.users values($1,$2,now())', [id, `${role}@live-intake.test`]);
  for (const migration of migrations.slice(0, 6)) await db.exec(migration.sql);
  await user();
  const w = (await rpc('bootstrap_workspace', { p_name: 'Synthetic intake workspace' })).id;
  const warehouse = (await db.query('select id from public.warehouses where workspace_id=$1', [w]))
    .rows[0].id;
  const supplier = (
    await rpc('save_master', {
      p_kind: 'suppliers',
      p_payload: { workspace_id: w, code: 'NCC', name: 'Test supplier' },
    })
  ).id;
  const product = (
    await rpc('save_master', {
      p_kind: 'products',
      p_payload: {
        workspace_id: w,
        code: 'CV27',
        name: 'Synthetic jeans',
        supplier_id: supplier,
        provisional: false,
      },
    })
  ).id;
  const receipt = await rpc('create_purchase', {
    p_payload: {
      workspace_id: w,
      product_id: product,
      supplier_id: supplier,
      warehouse_id: warehouse,
      received_date: '2026-08-18',
      date_estimated: false,
      qty: 10,
      unit_cost: 100000,
      additional_cost: 0,
    },
  });
  await rpc('post_purchase', { p_id: receipt.id, p_request_id: randomUUID() });
  await rpc('reserve_inventory', {
    p_workspace_id: w,
    p_payload: {
      product_id: product,
      warehouse_id: warehouse,
      qty: 1,
      date: '2026-08-19',
      reason: 'Existing pre-live reservation',
    },
    p_request_id: randomUUID(),
  });
  await user(users.other);
  const otherW = (await rpc('bootstrap_workspace', { p_name: 'Other synthetic workspace' })).id;
  const otherWarehouse = (
    await db.query('select id from public.warehouses where workspace_id=$1', [otherW])
  ).rows[0].id;
  await db.exec('reset role');
  for (const role of ['manager', 'staff', 'viewer'])
    await db.query('insert into public.workspace_members values($1,$2,$3)', [w, users[role], role]);
  await db.exec('create publication supabase_realtime for table public.products');
  const before = await snapshot([...protectedTables, 'audit_events']);
  stage = 'migration 007';
  await db.exec('reset role');
  await ok(
    '007 upgrades populated Phase B without changing existing products, ledgers, holds or audits',
    async () => {
      await db.exec(migrations[6].sql);
      assert.deepEqual(await snapshot(Object.keys(before)), before);
    },
  );
  const campaignPayload = {
    code: 'LIVE-AUG',
    name: 'Synthetic campaign',
    warehouse_id: warehouse,
    status: 'active',
  };
  const campaign = await rpc('save_live_campaign', {
    p_workspace_id: w,
    p_payload: campaignPayload,
  });
  const sessionPayload = {
    campaign_id: campaign,
    code: 'SESSION-1',
    title: 'Synthetic manual session',
    provider: 'manual',
    room_id: '',
    status: 'live',
  };
  const session = await rpc('save_live_session', { p_workspace_id: w, p_payload: sessionPayload });
  const intake = (args = {}) =>
    rpc('get_live_intake', { p_workspace_id: w, p_session_id: session, ...args });
  const ingest = (comments, sessionId = session, workspace = w) =>
    rpc('ingest_live_comments', {
      p_workspace_id: workspace,
      p_session_id: sessionId,
      p_comments: comments,
    });
  const claim = (id) => rpc('claim_live_comment', { p_workspace_id: w, p_comment_id: id });
  const release = (id, token) =>
    rpc('release_live_comment_claim', {
      p_workspace_id: w,
      p_comment_id: id,
      p_claim_token: token,
    });
  const saveCampaign = (p) => rpc('save_live_campaign', { p_workspace_id: w, p_payload: p });
  const saveSession = (p) => rpc('save_live_session', { p_workspace_id: w, p_payload: p });
  const saveAccount = (p) =>
    rpc('save_live_integration_account', { p_workspace_id: w, p_payload: p });
  const connection = (id, status, messageCode) =>
    rpc('report_live_connection', {
      p_workspace_id: w,
      p_session_id: id,
      p_status: status,
      p_message: messageCode,
    });
  stage = 'intake and account contracts';

  await ok(
    'Campaign and session reject cross-workspace parents, warehouse changes and immutable identity edits',
    async () => {
      await assert.rejects(() =>
        saveCampaign({ ...campaignPayload, code: 'FOREIGN', warehouse_id: otherWarehouse }),
      );
      await assert.rejects(() =>
        saveSession({ ...sessionPayload, code: 'BAD', campaign_id: randomUUID() }),
      );
      await assert.rejects(() =>
        saveCampaign({ ...campaignPayload, id: campaign, code: 'RENAMED' }),
      );
      await assert.rejects(() =>
        saveSession({ ...sessionPayload, id: session, provider: 'simulator' }),
      );
      await assert.rejects(() =>
        saveCampaign({ ...campaignPayload, id: campaign, status: 'closed' }),
      );
    },
  );
  let first;
  await ok(
    'Ingestion preserves large string IDs and raw text, creating observations only',
    async () => {
      const result = await ingest([message('9223372036854775807999')]);
      assert.deepEqual([result.inserted, result.duplicates, result.ids.length], [1, 0, 1]);
      first = result.ids[0];
      const row = (await intake()).comments[0];
      assert.equal(row.provider_message_id, '9223372036854775807999');
      assert.equal(row.author_external_id, '9223372036854775807123');
      assert.equal(row.raw_text, '  CV27 size M x2  ');
      assert.equal(row.state, 'new');
      assert.deepEqual(
        await snapshot(),
        Object.fromEntries(protectedTables.map((t) => [t, before[t]])),
      );
    },
  );
  await ok(
    'Exact duplicate ingestion is idempotent and equivalent timestamp offsets match',
    async () => {
      const result = await ingest([
        message('9223372036854775807999', { occurred_at: '2026-08-20T17:00:00+07:00' }),
      ]);
      assert.deepEqual(result, { inserted: 0, duplicates: 1, ids: [first] });
    },
  );
  await ok(
    'Changed duplicate rejects the whole batch and leaves no preceding inserted comment',
    async () => {
      const beforeRows = (await intake()).comments;
      await assert.rejects(
        () =>
          ingest([message('atomic-new'), message('9223372036854775807999', { text: 'Changed' })]),
        /LIVE_DUPLICATE_CONFLICT/,
      );
      assert.deepEqual((await intake()).comments, beforeRows);
    },
  );
  await ok(
    'Same ID repeated inside one batch creates one observation and returns aligned IDs',
    async () => {
      const result = await ingest([message('inside-batch'), message('inside-batch')]);
      assert.equal(result.inserted, 1);
      assert.equal(result.duplicates, 1);
      assert.equal(result.ids[0], result.ids[1]);
    },
  );
  await ok(
    'Malformed input, numeric IDs, controls, blank text, excessive batches and missing timezone are rejected',
    async () => {
      for (const payload of [
        [],
        Array.from({ length: 101 }, (_, i) => message(`large-${i}`)),
        {},
        [message('bad-number', { author_external_id: 9223372036854775807 })],
        [message('bad-padding', { author_external_id: ' '.repeat(201) + '123' })],
        [message('bad-type', { text: { nested: true } })],
        [message('bad-blank', { text: '   ' })],
        [message('bad-control', { text: 'one\ntwo' })],
        [message('bad-bidi', { author_display_name: 'a\u202Eb' })],
        [message('bad-long', { text: 'x'.repeat(2001) })],
        [message('bad-time', { occurred_at: '2026-08-20 10:00:00' })],
        [message('bad-future', { occurred_at: '2099-01-01T00:00:00Z' })],
      ])
        await assert.rejects(() => ingest(payload));
    },
  );
  await ok(
    'Staff ingestion cannot choose workspace, actor, comment state or provider from payload',
    async () => {
      await user(users.staff);
      const result = await ingest([
        message('staff-ingest', {
          workspace_id: otherW,
          created_by: users.other,
          state: 'committed',
          provider: 'fake',
        }),
      ]);
      const row = (await intake()).comments.find((r) => r.id === result.ids[0]);
      assert.equal(row.workspace_id, w);
      assert.equal(row.state, 'new');
      assert.equal(row.session_id, session);
      await assert.rejects(() => saveCampaign({ ...campaignPayload, code: 'STAFF-DENIED' }), {
        code: '42501',
      });
      await assert.rejects(
        () => saveAccount({ name: 'Denied', username: 'staff', enabled: true }),
        { code: '42501' },
      );
    },
  );
  let held;
  await ok(
    'Claim has a 120-second server lease; same holder renews using the same token',
    async () => {
      held = await claim(first);
      assert.equal(held.claimed_by, users.staff);
      const renewed = await claim(first);
      assert.equal(renewed.claim_token, held.claim_token);
      const seconds = (
        await db.query(
          'select extract(epoch from (expires_at-clock_timestamp())) remaining from public.live_comment_claims where comment_id=$1',
          [first],
        )
      ).rows[0].remaining;
      assert.ok(Number(seconds) > 115 && Number(seconds) <= 120);
    },
  );
  await ok(
    'Another operator sees claim metadata without token and cannot steal or release its active lease',
    async () => {
      await user();
      const state = await intake();
      assert.equal(state.claims[0].claimed_by, users.staff);
      assert.ok(!Object.hasOwn(state.claims[0], 'claim_token'));
      await assert.rejects(() => db.query('select claim_token from public.live_comment_claims'), {
        code: '42501',
      });
      await assert.rejects(() => claim(first), /LIVE_CLAIM_BUSY/);
      await assert.rejects(() => release(first, held.claim_token), { code: '42501' });
    },
  );
  await ok(
    'Expired lease can be reclaimed with a new token; old holder cannot release the replacement',
    async () => {
      await db.exec('reset role');
      await db.query(
        "update public.live_comment_claims set expires_at=clock_timestamp()-interval '1 second' where comment_id=$1",
        [first],
      );
      await user();
      const fresh = await claim(first);
      assert.notEqual(fresh.claim_token, held.claim_token);
      await user(users.staff);
      await assert.rejects(() => release(first, held.claim_token), { code: '42501' });
      await user();
      assert.equal((await intake()).claims[0].claim_token, fresh.claim_token);
      await release(first, fresh.claim_token);
      await release(first, fresh.claim_token);
      assert.equal((await intake()).claims.length, 0);
    },
  );
  await ok(
    'Claiming a committed or voided comment is rejected without creating a lease',
    async () => {
      await db.exec('reset role');
      await db.query("update public.live_comments set state='committed' where id=$1", [first]);
      await user();
      await assert.rejects(() => claim(first), /LIVE_CLAIM/);
      await db.exec('reset role');
      await db.query("update public.live_comments set state='voided' where id=$1", [first]);
      await user();
      await assert.rejects(() => claim(first), /LIVE_CLAIM/);
      await db.exec('reset role');
      await db.query("update public.live_comments set state='new' where id=$1", [first]);
      await user();
    },
  );
  await ok(
    'Pagination uses timestamp plus UUID and loses no comments with equal timestamps',
    async () => {
      await ingest(Array.from({ length: 8 }, (_, i) => message(`page-${i}`)));
      await db.exec('reset role');
      await db.query(
        "update public.live_comments set received_at='2026-08-21T00:00:00Z' where workspace_id=$1",
        [w],
      );
      await user();
      const expected = (
        await db.query(
          'select id from public.live_comments where workspace_id=$1 order by received_at desc,id desc',
          [w],
        )
      ).rows.map((r) => r.id);
      const seen = [];
      let cursor = {};
      for (let i = 0; i < 20; i++) {
        const page = await intake({ p_limit: 3, ...cursor });
        assert.ok(page.comments.length <= 3);
        seen.push(...page.comments.map((r) => r.id));
        if (!page.has_more) {
          assert.equal(page.next_before, null);
          assert.equal(page.next_before_id, null);
          break;
        }
        cursor = { p_before: page.next_before, p_before_id: page.next_before_id };
      }
      assert.deepEqual(seen, expected);
      assert.equal(new Set(seen).size, expected.length);
      await assert.rejects(() => intake({ p_limit: 201 }));
      await assert.rejects(() => intake({ p_before: '2026-08-21T00:00:00Z' }));
    },
  );
  let account, tiktokSession;
  const accountPayload = { name: 'Public shop profile', username: '@ChiDi.Shop', enabled: true };
  await ok(
    'TikTok account is a normalized public handle with no password/token fields',
    async () => {
      account = await saveAccount(accountPayload);
      const row = (await intake()).integration_accounts.find((r) => r.id === account);
      assert.equal(row.username, 'chidi.shop');
      assert.equal(row.provider, 'tiktok_live');
      await assert.rejects(() => saveAccount({ ...accountPayload, username: 'CHIDI.SHOP' }), {
        code: '23505',
      });
      for (const username of ['https://tiktok.com/@user', 'contains space', 'x'.repeat(25), 'end.'])
        await assert.rejects(() => saveAccount({ ...accountPayload, username }));
      assert.ok(!Object.keys(row).some((k) => /password|secret|token|cookie/.test(k)));
    },
  );
  const tiktokPayload = {
    ...sessionPayload,
    code: 'TIKTOK-1',
    provider: 'tiktok_live',
    integration_account_id: null,
    room_id: 'chidi.shop',
  };
  await ok(
    'TikTok session requires the correct enabled account and exact room handle',
    async () => {
      await assert.rejects(() => saveSession(tiktokPayload));
      await assert.rejects(() =>
        saveSession({ ...tiktokPayload, integration_account_id: account, room_id: 'wrong' }),
      );
      tiktokSession = await saveSession({ ...tiktokPayload, integration_account_id: account });
      await assert.rejects(() =>
        saveAccount({ ...accountPayload, id: account, username: 'different' }),
      );
    },
  );
  await ok(
    'Connection heartbeat accepts safe status codes and rejects raw errors or secrets',
    async () => {
      await connection(tiktokSession, 'connected', 'connected');
      const s = (await intake()).sessions.find((r) => r.id === tiktokSession);
      assert.equal(s.connection_status, 'connected');
      assert.ok(s.heartbeat_at);
      await assert.rejects(
        () => connection(tiktokSession, 'error', 'Authorization: token private'),
        /LIVE_CONNECTION/,
      );
      await user(users.staff);
      await assert.rejects(() => connection(tiktokSession, 'connected', 'connected'), {
        code: '42501',
      });
      await user();
    },
  );
  await ok(
    'Disabling account stops new TikTok ingestion and connected reports without losing history',
    async () => {
      await ingest([message('tiktok-first')], tiktokSession);
      await saveAccount({ ...accountPayload, id: account, enabled: false });
      await assert.rejects(() => ingest([message('tiktok-new')], tiktokSession), /LIVE_ACCOUNT/);
      await assert.rejects(
        () => connection(tiktokSession, 'connected', 'connected'),
        /LIVE_CONNECTION/,
      );
      assert.equal((await ingest([message('tiktok-first')], tiktokSession)).duplicates, 1);
      assert.equal(
        (await intake()).sessions.find((r) => r.id === tiktokSession).connection_status,
        'disconnected',
      );
      await saveSession({
        ...tiktokPayload,
        id: tiktokSession,
        integration_account_id: account,
        status: 'ended',
      });
    },
  );
  await ok(
    'Ended sessions allow immutable retries but reject new intake, claims and reopening',
    async () => {
      await saveSession({ ...sessionPayload, id: session, status: 'ended' });
      assert.equal((await ingest([message('9223372036854775807999')])).duplicates, 1);
      await assert.rejects(() => ingest([message('ended-new')]), /LIVE_NOT_ACTIVE/);
      await assert.rejects(() => claim(first), /LIVE_CLAIM/);
      await assert.rejects(
        () => connection(session, 'error', 'connection_failed'),
        /LIVE_CONNECTION/,
      );
      await assert.rejects(() => saveSession({ ...sessionPayload, id: session }), /LIVE_SESSION/);
      await saveCampaign({ ...campaignPayload, id: campaign, status: 'closed' });
      await assert.rejects(
        () => saveCampaign({ ...campaignPayload, id: campaign }),
        /LIVE_CAMPAIGN/,
      );
    },
  );
  await user(users.viewer);
  await ok(
    'Viewer can read intake but cannot ingest, claim, configure or report connection',
    async () => {
      assert.ok((await intake()).comments.length);
      await assert.rejects(() => ingest([message('viewer')]), { code: '42501' });
      await assert.rejects(() => claim(first), { code: '42501' });
      await assert.rejects(() => saveSession({ ...sessionPayload, code: 'VIEWER' }), {
        code: '42501',
      });
      await assert.rejects(() => connection(tiktokSession, 'error', 'connection_failed'), {
        code: '42501',
      });
    },
  );
  await user(users.other);
  await ok(
    'Another workspace cannot read or mutate intake or claims through table or RPC paths',
    async () => {
      for (const t of liveTables) {
        const columns = t === 'live_comment_claims' ? 'workspace_id,comment_id' : '*';
        assert.equal(
          (await db.query(`select ${columns} from public.${t} where workspace_id=$1`, [w])).rows
            .length,
          0,
        );
      }
      await assert.rejects(() => intake(), { code: '42501' });
      await assert.rejects(() => ingest([message('foreign')]), { code: '42501' });
      await assert.rejects(
        () => rpc('get_live_intake', { p_workspace_id: otherW, p_session_id: session }),
        /LIVE_PAGE/,
      );
      await assert.rejects(
        () => ingest([message('wrong-session')], session, otherW),
        /LIVE_SESSION/,
      );
    },
  );
  await user();
  await ok(
    'Direct table writes and private helper calls are denied even for workspace owners',
    async () => {
      for (const t of liveTables) {
        await assert.rejects(() => db.exec(`insert into public.${t} default values`), {
          code: '42501',
        });
        await assert.rejects(() => db.exec(`delete from public.${t} where false`), {
          code: '42501',
        });
      }
      await assert.rejects(
        () => db.query('select app_private.live_text(\'{"x":"value"}\',\'x\',20,true)'),
        { code: '42501' },
      );
    },
  );
  await db.exec('reset role;set role anon');
  await ok('Anonymous users have neither intake RPC access nor live table reads', async () => {
    await assert.rejects(() => intake(), { code: '42501' });
    await assert.rejects(() => db.exec('select * from public.live_comments'), { code: '42501' });
  });
  await user();
  await ok(
    'All ingestion and claim activity leaves pre-existing ERP stock/sales/cash rows unchanged',
    async () => {
      assert.deepEqual(
        await snapshot(),
        Object.fromEntries(protectedTables.map((t) => [t, before[t]])),
      );
    },
  );
  await db.exec('reset role');
  await ok(
    'Realtime preserves previous tables and excludes claim tokens from published columns',
    async () => {
      const published = (
        await db.query(
          "select tablename,attnames from pg_publication_tables where pubname='supabase_realtime' and schemaname='public'",
        )
      ).rows;
      assert.ok(published.some((r) => r.tablename === 'products'));
      for (const table of liveTables)
        assert.ok(
          published.some((r) => r.tablename === table),
          table,
        );
      assert.ok(
        !published
          .find((r) => r.tablename === 'live_comment_claims')
          .attnames.includes('claim_token'),
      );
    },
  );
  await ok('All migration files remain byte-identical throughout tests', async () => {
    for (const migration of migrations)
      assert.equal(
        createHash('sha256')
          .update(await readFile(new URL(migration.name, directory)))
          .digest('hex'),
        migration.sha256,
      );
  });
} catch (error) {
  if (!checks.some((c) => c.status === 'FAIL'))
    checks.push({ name: stage, status: 'FAIL', detail: error.message, code: error.code });
  console.error('FAIL', stage, error.code || error.name, error.message);
  process.exitCode = 1;
} finally {
  await db.close();
  await mkdir(new URL('../test-results/', import.meta.url), { recursive: true });
  await writeFile(
    new URL('../test-results/live-intake.json', import.meta.url),
    JSON.stringify(
      {
        checked_at: new Date().toISOString(),
        engine: 'PGlite PostgreSQL',
        cloud_tested: false,
        simultaneous_sessions_tested: false,
        migrations: migrations.map(({ name, sha256 }) => ({ name, sha256 })),
        status: checks.some((c) => c.status === 'FAIL') ? 'FAIL' : 'PASS',
        checks,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    `Live intake: ${checks.filter((c) => c.status === 'PASS').length} PASS, ${checks.filter((c) => c.status === 'FAIL').length} FAIL`,
  );
}
