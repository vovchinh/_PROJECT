// Real PostgreSQL, independent client processes and observed lock contention.
// Uses a NEW synthetic cluster under .tools; never reads .env or existing DB data.
// Override CHIDI_PG_BIN only to select an installed PostgreSQL binary directory.
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { randomUUID, createHash } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const project = fileURLToPath(new URL('../', import.meta.url));
const binaryDir = process.env.CHIDI_PG_BIN || 'C:\\Program Files\\PostgreSQL\\14\\bin';
const executable = (name) => join(binaryDir, name + (process.platform === 'win32' ? '.exe' : ''));
const parentDirectory = resolve(project, '.tools', 'live-concurrency');
const admin = 'chidi_concurrency';
const owner = '11111111-1111-4111-8111-111111111111';
const staffA = '33333333-3333-4333-8333-333333333333';
const staffB = '44444444-4444-4444-8444-444444444444';
const manager = '55555555-5555-4555-8555-555555555555';
const migrations = [];
const checks = [];
const children = new Set();
let runDirectory,
  dataDirectory,
  port,
  startAttempted = false,
  serverVersion;
let observedSessionPairs = 0;
let fixture,
  stage = 'prerequisites',
  stopped = false;
const quote = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const json = (value) => `${quote(JSON.stringify(value))}::jsonb`;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function child(command, args, input, extraEnvironment = {}) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith('PG')) delete env[name];
  Object.assign(env, { PGCLIENTENCODING: 'UTF8', ...extraEnvironment });
  const processHandle = spawn(command, args, {
    cwd: project,
    env,
    windowsHide: true,
    stdio: 'pipe',
  });
  children.add(processHandle);
  let stdout = '',
    stderr = '';
  processHandle.stdout.setEncoding('utf8').on('data', (chunk) => {
    stdout += chunk;
  });
  processHandle.stderr.setEncoding('utf8').on('data', (chunk) => {
    stderr += chunk;
  });
  const done = new Promise((complete) => {
    processHandle.once('error', (error) => {
      children.delete(processHandle);
      complete({ code: -1, stdout, stderr: error.message });
    });
    processHandle.once('close', (code) => {
      children.delete(processHandle);
      complete({ code, stdout, stderr });
    });
    // pg_ctl starts a detached server on Windows whose inherited pipe handles can
    // outlive pg_ctl itself. Waiting for pipe closure would wait until shutdown.
    if (/pg_ctl(?:\.exe)?$/i.test(command))
      processHandle.once('exit', (code) => {
        children.delete(processHandle);
        processHandle.stdout.destroy();
        processHandle.stderr.destroy();
        complete({ code, stdout, stderr });
      });
  });
  if (input !== undefined) processHandle.stdin.end(input);
  return { process: processHandle, done, output: () => stdout };
}
async function command(name, args) {
  const result = await child(executable(name), args, '').done;
  if (result.code !== 0)
    throw new Error(`${name} exited ${result.code}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}
function psql(sql, applicationName = 'chidi_concurrency_admin') {
  return child(
    executable('psql'),
    [
      '-X',
      '-q',
      '-A',
      '-t',
      '-v',
      'ON_ERROR_STOP=1',
      '-h',
      '127.0.0.1',
      '-p',
      String(port),
      '-U',
      admin,
      '-d',
      'postgres',
    ],
    sql,
    {
      PGAPPNAME: applicationName,
      PGCONNECT_TIMEOUT: '5',
      PGOPTIONS: '-c statement_timeout=15000 -c lock_timeout=12000',
    },
  );
}
async function sql(statement) {
  const result = await psql(statement).done;
  if (result.code !== 0) throw new Error(`psql exited ${result.code}: ${result.stderr}`);
  return result.stdout.trim();
}
async function value(statement, actorId = null) {
  const output = await sql((actorId ? session(actorId) : '') + statement);
  const last = output.trim().split(/\r?\n/).at(-1);
  return JSON.parse(last);
}
const session = (actorId = owner) =>
  `set request.jwt.claim.sub=${quote(actorId)}; set role authenticated;\n`;
const rpcSql = (name, args) =>
  `select to_jsonb(public.${name}(${Object.entries(args)
    .map(
      ([key, v]) =>
        `${key}=>${
          key === 'p_reservation_ids'
            ? `array[${v.map(quote).join(',')}]::uuid[]`
            : v !== null && typeof v === 'object'
              ? json(v)
              : v === null
                ? 'null'
                : quote(v)
        }`,
    )
    .join(',')}));\n`;
const rpc = (name, args, actorId = owner) => value(rpcSql(name, args), actorId);
async function ok(name, action) {
  try {
    await action();
    checks.push({ name, status: 'PASS' });
    console.log('PASS', name);
  } catch (error) {
    checks.push({ name, status: 'FAIL', detail: error.message });
    throw error;
  }
}
async function until(check, message, ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(50);
  }
  throw new Error(message);
}
async function freePort() {
  const socket = createServer();
  await new Promise((done, fail) => {
    socket.once('error', fail);
    socket.listen(0, '127.0.0.1', done);
  });
  const selected = socket.address().port;
  await new Promise((done) => socket.close(done));
  return selected;
}
function assertOwnedDirectory(target) {
  const part = relative(parentDirectory, resolve(target));
  if (
    !part ||
    part.startsWith('..' + sep) ||
    part === '..' ||
    dirname(resolve(target)) !== parentDirectory
  )
    throw new Error('Refusing cleanup outside the unique test run directory.');
}
async function race(
  name,
  firstSql,
  secondSql,
  firstActor = staffA,
  secondActor = staffB,
  ordered = false,
) {
  const barrier = psql(undefined, `chidi_barrier_${name}`);
  barrier.process.stdin.write(
    `begin; select id from public.workspaces where id=${quote(fixture.w)} for update; select 'BARRIER_READY';\n`,
  );
  await until(
    () => barrier.output().includes('BARRIER_READY'),
    'Barrier did not acquire the workspace lock.',
  );
  const applications = [`chidi_${name}_a`, `chidi_${name}_b`];
  const jobs = [psql(session(firstActor) + firstSql, applications[0])];
  try {
    // For fence tests, establish the first transaction's lock wait before
    // starting the second. Both still contend through independent connections.
    if (ordered)
      await until(
        async () =>
          Number(
            await sql(
              `select count(*) from pg_stat_activity where application_name=${quote(applications[0])} and wait_event_type='Lock';`,
            ),
          ) === 1,
        'The first ordered transaction was not waiting at the barrier.',
      );
    jobs.push(psql(session(secondActor) + secondSql, applications[1]));
    await until(
      async () =>
        Number(
          await sql(
            `select count(*) from pg_stat_activity where application_name in (${applications.map(quote).join(',')}) and wait_event_type='Lock';`,
          ),
        ) === 2,
      'Two independent PostgreSQL sessions were not simultaneously waiting for a lock.',
    );
    observedSessionPairs++;
    barrier.process.stdin.end('commit;\n');
    const release = await barrier.done;
    assert.equal(release.code, 0, release.stderr);
    const results = await Promise.all(jobs.map((job) => job.done));
    return results.map((result) => ({
      ...result,
      value: result.code === 0 ? JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)) : null,
    }));
  } finally {
    if (!barrier.process.stdin.destroyed) barrier.process.stdin.end('rollback;\n');
  }
}
async function sku(code, quantity = 1) {
  const product = await rpc('save_master', {
    p_kind: 'products',
    p_payload: {
      workspace_id: fixture.w,
      supplier_id: fixture.supplier,
      code,
      name: `Synthetic ${code}`,
      provisional: false,
    },
  });
  const receipt = await rpc('create_purchase', {
    p_payload: {
      workspace_id: fixture.w,
      supplier_id: fixture.supplier,
      warehouse_id: fixture.warehouse,
      product_id: product.id,
      received_date: '2026-08-01',
      date_estimated: false,
      qty: quantity,
      unit_cost: 100,
      additional_cost: 0,
    },
  });
  await rpc('post_purchase', { p_id: receipt.id, p_request_id: randomUUID() });
  await rpc('save_product_variant', {
    p_workspace_id: fixture.w,
    p_payload: {
      product_id: product.id,
      style_id: fixture.style,
      size: code,
      color: 'Synthetic',
      mapping_status: 'confirmed',
      review_note: 'Synthetic catalog mapping verified for concurrency test',
    },
  });
  return product;
}

try {
  for (const name of ['initdb', 'pg_ctl', 'psql']) await access(executable(name));
  await mkdir(parentDirectory, { recursive: true });
  runDirectory = await mkdtemp(join(parentDirectory, 'run-'));
  assertOwnedDirectory(runDirectory);
  dataDirectory = join(runDirectory, 'data');
  port = await freePort();
  stage = 'initializing isolated PostgreSQL';
  await command('initdb', [
    '-D',
    dataDirectory,
    '-U',
    admin,
    '--encoding=UTF8',
    '--locale=C',
    '--auth=trust',
  ]);
  startAttempted = true;
  await command('pg_ctl', [
    '-D',
    dataDirectory,
    '-l',
    join(runDirectory, 'server.log'),
    '-w',
    '-t',
    '20',
    '-o',
    `-h 127.0.0.1 -p ${port} -c max_connections=20 -c shared_buffers=16MB`,
    'start',
  ]);
  serverVersion = await sql('show server_version;');
  assert.equal(
    resolve(await sql('show data_directory;')).toLowerCase(),
    resolve(dataDirectory).toLowerCase(),
  );
  assert.equal(await sql('show listen_addresses;'), '127.0.0.1');
  console.log(`PostgreSQL ${serverVersion}; isolated loopback cluster; no existing service used.`);
  await sql(`create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to authenticated,anon;
    grant execute on function auth.uid() to authenticated,anon;
    insert into auth.users values(${quote(owner)},'owner@concurrency.test',now()),
      (${quote(staffA)},'staffa@concurrency.test',now()),(${quote(staffB)},'staffb@concurrency.test',now()),
      (${quote(manager)},'manager@concurrency.test',now());`);
  stage = 'applying 001 through 012 to a new empty database';
  for (const name of [
    '001_core.sql',
    '002_operations.sql',
    '003_sales_inventory.sql',
    '004_catalog_variants_aliases.sql',
    '005_customer_order_foundation.sql',
    '006_inventory_reservations.sql',
    '007_live_intake.sql',
    '008_live_tickets_print.sql',
    '009_live_operations.sql',
    '010_tiktok_channel_flow.sql',
    '011_tiktok_live_end.sql',
    '012_live_runtime_telemetry.sql',
  ]) {
    const content = await readFile(join(project, 'supabase', 'migrations', name));
    migrations.push({ name, sha256: createHash('sha256').update(content).digest('hex') });
    await sql(content.toString('utf8'));
  }
  fixture = {
    w: (await rpc('bootstrap_workspace', { p_name: 'Isolated native concurrency test' })).id,
  };
  fixture.supplier = (
    await rpc('save_master', {
      p_kind: 'suppliers',
      p_payload: { workspace_id: fixture.w, code: 'TEST', name: 'Synthetic supplier' },
    })
  ).id;
  fixture.warehouse = await value(
    `select to_jsonb(id) from public.warehouses where workspace_id=${quote(fixture.w)};`,
  );
  fixture.customer = await rpc('save_customer', {
    p_workspace_id: fixture.w,
    p_payload: { code: 'TEST', name: 'Synthetic customer' },
  });
  await sql(`insert into public.workspace_members values
    (${quote(fixture.w)},${quote(staffA)},'staff'),
    (${quote(fixture.w)},${quote(staffB)},'staff'),
    (${quote(fixture.w)},${quote(manager)},'manager');`);
  fixture.style = await rpc('save_product_style', {
    p_workspace_id: fixture.w,
    p_payload: { code: 'LIVE-TEST', name: 'Synthetic live variants' },
  });
  fixture.campaign = await rpc('save_live_campaign', {
    p_workspace_id: fixture.w,
    p_payload: {
      code: 'LIVE-RACES',
      name: 'Synthetic concurrency campaign',
      warehouse_id: fixture.warehouse,
      status: 'active',
    },
  });
  fixture.liveSession = await rpc('save_live_session', {
    p_workspace_id: fixture.w,
    p_payload: {
      campaign_id: fixture.campaign,
      code: 'LIVE-TEST',
      title: 'No provider connection',
      provider: 'manual',
      room_id: '',
      status: 'live',
    },
  });
  const claimSql = (id) =>
    rpcSql('claim_live_comment', { p_workspace_id: fixture.w, p_comment_id: id });
  const commitSql = (payload, request = randomUUID()) =>
    rpcSql('commit_live_sale_ticket', {
      p_workspace_id: fixture.w,
      p_payload: payload,
      p_request_id: request,
    });
  const printClaimSql = (id) =>
    rpcSql('claim_live_print_job', {
      p_workspace_id: fixture.w,
      p_job_id: id,
      p_request_id: randomUUID(),
    });
  const requeueSql = (id) =>
    rpcSql('requeue_live_print_job', {
      p_workspace_id: fixture.w,
      p_job_id: id,
      p_reason: 'Synthetic operator checked failed attempt, no physical print',
      p_request_id: randomUUID(),
    });
  const voidSql = (id) =>
    rpcSql('void_live_sale_ticket', {
      p_workspace_id: fixture.w,
      p_ticket_id: id,
      p_date: '2026-08-20',
      p_reason: 'Synthetic customer cancellation checked by operator',
      p_request_id: randomUUID(),
    });
  async function comment(author) {
    const result = await rpc('ingest_live_comments', {
      p_workspace_id: fixture.w,
      p_session_id: fixture.liveSession,
      p_comments: [
        {
          message_id: randomUUID(),
          author_external_id: author,
          author_display_name: 'Synthetic buyer',
          text: 'Review SKU quantity and price',
          occurred_at: '2026-08-20T10:00:00Z',
        },
      ],
    });
    return result.ids[0];
  }
  async function payloadFor(product, author, actorId = staffA) {
    const id = await comment(author);
    const held = await rpc(
      'claim_live_comment',
      { p_workspace_id: fixture.w, p_comment_id: id },
      actorId,
    );
    return {
      comment_id: id,
      claim_token: held.claim_token,
      product_id: product.id,
      qty: 1,
      unit_price: '200',
      customer_id: null,
      date: '2026-08-20',
      review_note: 'Synthetic seller explicitly reviewed SKU, quantity and price',
    };
  }
  async function stock(product) {
    return (await rpc('get_sales_state', { p_workspace_id: fixture.w })).inventory.find(
      (r) => r.product_id === product.id,
    );
  }
  async function counts(ticket) {
    return value(`select jsonb_build_object(
      'tickets',(select count(*) from public.live_sale_tickets where id=${quote(ticket.ticket_id)}),
      'cart_items',(select count(*) from public.customer_cart_items where ticket_id=${quote(ticket.ticket_id)}),
      'holds',(select count(*) from public.inventory_reservations where live_ticket_id=${quote(ticket.ticket_id)}),
      'print_jobs',(select count(*) from public.live_print_jobs where ticket_id=${quote(ticket.ticket_id)}),
      'committed_outbox',(select count(*) from public.live_outbox_events where ticket_id=${quote(ticket.ticket_id)} and event_type='committed'));`);
  }
  const singleBusinessEffect = {
    tickets: 1,
    cart_items: 1,
    holds: 1,
    print_jobs: 1,
    committed_outbox: 1,
  };
  let printTarget, printProduct, leaseActor, printLease;
  stage = 'Phase C independent authenticated-session races';

  await ok(
    'Two staff simultaneously claiming one comment result in one active holder',
    async () => {
      const id = await comment('claim-contention');
      const results = await race('live_claim', claimSql(id), claimSql(id));
      assert.equal(results.filter((r) => r.code === 0).length, 1);
      assert.match(results.find((r) => r.code !== 0).stderr, /LIVE_CLAIM_BUSY/);
      const winner = results.findIndex((r) => r.code === 0),
        expectedActor = [staffA, staffB][winner];
      const row = await value(
        `select to_jsonb(c) from public.live_comment_claims c where comment_id=${quote(id)};`,
      );
      assert.equal(row.claimed_by, expectedActor);
      assert.equal(row.claim_token, results[winner].value.claim_token);
      assert.equal(await sql('select count(*) from public.live_sale_tickets;'), '0');
      assert.equal(await sql('select count(*) from public.inventory_reservations;'), '0');
    },
  );
  await ok(
    'Same claimed comment with different commit UUIDs creates exactly one ticket and stock hold',
    async () => {
      const product = await sku('LIVE-DUP-COMMIT');
      const payload = await payloadFor(product, 'duplicate-commit');
      const results = await race(
        'live_commit',
        commitSql(payload),
        commitSql(payload),
        staffA,
        staffA,
      );
      assert.equal(results.filter((r) => r.code === 0).length, 1);
      assert.match(results.find((r) => r.code !== 0).stderr, /LIVE_COMMENT_USED/);
      assert.deepEqual(await counts(results.find((r) => r.code === 0).value), singleBusinessEffect);
      const after = await stock(product);
      assert.deepEqual([after.on_hand, after.reserved, after.available], [1, 1, 0]);
    },
  );
  await ok(
    'Identical concurrent commit retry returns one ticket, cart item, hold, print job and outbox event',
    async () => {
      printProduct = await sku('LIVE-RETRY', 2);
      const payload = await payloadFor(printProduct, 'identical-retry'),
        request = randomUUID();
      const statement = commitSql(payload, request);
      const results = await race('live_retry', statement, statement, staffA, staffA);
      assert.ok(
        results.every((r) => r.code === 0),
        JSON.stringify(results),
      );
      assert.deepEqual(results[0].value, results[1].value);
      printTarget = results[0].value;
      assert.deepEqual(await counts(printTarget), singleBusinessEffect);
      assert.equal((await stock(printProduct)).available, 1);
      assert.equal(
        await sql(
          `select count(*) from public.audit_events where action='live.ticket_committed' and entity_id=${quote(printTarget.ticket_id)};`,
        ),
        '1',
      );
    },
  );
  await ok(
    'Two separately claimed comments competing for last stock allow one commit and roll back the loser',
    async () => {
      const product = await sku('LIVE-LAST-UNIT');
      const a = await payloadFor(product, 'last-stock-A', staffA),
        b = await payloadFor(product, 'last-stock-B', staffB);
      const results = await race('live_stock', commitSql(a), commitSql(b));
      assert.equal(results.filter((r) => r.code === 0).length, 1);
      assert.match(results.find((r) => r.code !== 0).stderr, /LIVE_INSUFFICIENT/);
      const after = await stock(product);
      assert.deepEqual([after.on_hand, after.reserved, after.available], [1, 1, 0]);
      assert.equal(
        await sql(
          `select count(*) from public.live_sale_tickets where comment_id in(${quote(a.comment_id)},${quote(b.comment_id)});`,
        ),
        '1',
      );
      assert.equal(
        await sql(
          "select count(*) from public.live_campaign_customers where author_external_id in('last-stock-A','last-stock-B');",
        ),
        '1',
      );
      const states = await value(
        `select jsonb_agg(state order by state) from public.live_comments where id in(${quote(a.comment_id)},${quote(b.comment_id)});`,
      );
      assert.deepEqual(states, ['committed', 'new']);
    },
  );
  await ok(
    'Two operators claiming the same print job receive one lease and one print attempt',
    async () => {
      const results = await race(
        'live_print',
        printClaimSql(printTarget.print_job_id),
        printClaimSql(printTarget.print_job_id),
      );
      assert.equal(results.filter((r) => r.code === 0).length, 1);
      assert.match(results.find((r) => r.code !== 0).stderr, /LIVE_PRINT_STATE/);
      const winner = results.findIndex((r) => r.code === 0);
      leaseActor = [staffA, staffB][winner];
      printLease = results[winner].value;
      assert.equal(
        await sql(
          `select count(*) from public.live_print_attempts where job_id=${quote(printTarget.print_job_id)};`,
        ),
        '1',
      );
      assert.equal(
        await sql(
          `select lease_actor from public.live_print_jobs where id=${quote(printTarget.print_job_id)};`,
        ),
        leaseActor,
      );
      assert.deepEqual(await counts(printTarget), singleBusinessEffect);
    },
  );
  await ok(
    'Racing requeue requests increment print retry once without duplicating business documents',
    async () => {
      await rpc(
        'finish_live_print_job',
        {
          p_workspace_id: fixture.w,
          p_job_id: printTarget.print_job_id,
          p_lease_token: printLease.lease_token,
          p_outcome: 'unknown',
          p_detail: 'Synthetic unknown result; no physical printer was contacted',
          p_request_id: randomUUID(),
        },
        leaseActor,
      );
      const results = await race(
        'live_requeue',
        requeueSql(printTarget.print_job_id),
        requeueSql(printTarget.print_job_id),
      );
      assert.equal(results.filter((r) => r.code === 0).length, 1);
      assert.match(results.find((r) => r.code !== 0).stderr, /LIVE_PRINT_STATE/);
      const job = await value(
        `select to_jsonb(j) from public.live_print_jobs j where id=${quote(printTarget.print_job_id)};`,
      );
      assert.equal(job.reprint_count, 1);
      assert.equal(job.status, 'queued');
      assert.equal(job.lease_token, null);
      assert.deepEqual(await counts(printTarget), singleBusinessEffect);
      assert.equal((await stock(printProduct)).available, 1);
    },
  );
  await ok(
    'Concurrent owner/manager VOID requests preserve ticket history and release the hold exactly once',
    async () => {
      const results = await race(
        'live_void',
        voidSql(printTarget.ticket_id),
        voidSql(printTarget.ticket_id),
        owner,
        manager,
      );
      assert.ok(
        results.every((r) => r.code === 0),
        JSON.stringify(results),
      );
      assert.ok(results.every((r) => r.value === printTarget.ticket_id));
      assert.equal(
        await sql(
          `select status from public.live_sale_tickets where id=${quote(printTarget.ticket_id)};`,
        ),
        'voided',
      );
      assert.equal(
        await sql(
          `select status from public.inventory_reservations where id=${quote(printTarget.reservation_id)};`,
        ),
        'released',
      );
      assert.equal(
        await sql(
          `select count(*) from public.audit_events where action='inventory.released' and entity_id=${quote(printTarget.reservation_id)};`,
        ),
        '1',
      );
      assert.equal(
        await sql(
          `select count(*) from public.live_outbox_events where ticket_id=${quote(printTarget.ticket_id)} and event_type='voided';`,
        ),
        '1',
      );
      assert.equal(
        await sql(
          `select status from public.live_print_jobs where id=${quote(printTarget.print_job_id)};`,
        ),
        'cancelled',
      );
      assert.deepEqual(await counts(printTarget), singleBusinessEffect);
      const after = await stock(printProduct);
      assert.deepEqual([after.on_hand, after.reserved, after.available], [2, 0, 2]);
    },
  );
  stage = 'TikTok channel independent-session connect, lease and disconnect races';
  const businessTables = [
    'products',
    'inventory_lots',
    'inventory_reservations',
    'reservation_lots',
    'sales_orders',
    'sales_order_lines',
    'sales_events',
    'sales_allocations',
    'cash_transactions',
    'cash_movements',
    'live_sale_tickets',
    'customer_carts',
    'customer_cart_items',
    'live_print_jobs',
    'live_print_attempts',
  ];
  const businessSnapshot = () =>
    value(
      `select jsonb_build_object(${businessTables
        .map(
          (table) =>
            `${quote(table)},(select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]'::jsonb) from public.${table} x)`,
        )
        .join(',')});`,
    );
  const businessBeforeChannelRaces = await businessSnapshot();
  const channelArgs = (id) => ({ p_workspace_id: fixture.w, p_channel_id: id });
  const connectArgs = (id, desired = 'connected', requestId = randomUUID()) => ({
    ...channelArgs(id),
    p_desired_state: desired,
    p_request_id: requestId,
  });
  const claimArgs = (id, revision) => ({ ...channelArgs(id), p_revision: revision });
  const reportArgs = (id, lease, room = 'synthetic_room') => ({
    ...channelArgs(id),
    p_revision: lease.revision,
    p_lease_token: lease.lease_token,
    p_status: 'live',
    p_provider_room_id: room,
  });
  async function channel(username) {
    return rpc('save_tiktok_channel', {
      p_workspace_id: fixture.w,
      p_payload: { username, is_active: true, is_default: false },
      p_request_id: randomUUID(),
    });
  }
  const channelRow = (id) =>
    value(`select to_jsonb(c) from public.live_channel_connections c
    where workspace_id=${quote(fixture.w)} and channel_id=${quote(id)};`);
  const channelCount = (table, id) =>
    sql(`select count(*) from public.${table}
    where workspace_id=${quote(fixture.w)} and channel_id=${quote(id)};`);
  let contestedChannel, connectionRevision;

  await ok(
    'Same concurrent TikTok connect retry creates one command and no campaign or session',
    async () => {
      const id = await channel('same_connect_retry');
      const args = connectArgs(id);
      const statement = rpcSql('request_tiktok_connection', args);
      const results = await race('channel_retry', statement, statement, staffA, staffA);
      assert.ok(
        results.every((r) => r.code === 0),
        JSON.stringify(results),
      );
      assert.deepEqual(results[0].value, results[1].value);
      assert.equal((await channelRow(id)).revision, 1);
      assert.equal(await channelCount('live_channel_commands', id), '1');
      assert.equal(await channelCount('live_channel_campaigns', id), '0');
      assert.equal(await channelCount('live_channel_sessions', id), '0');
      const changed = await psql(
        session(staffA) +
          rpcSql('request_tiktok_connection', {
            ...args,
            p_desired_state: 'disconnected',
          }),
      ).done;
      assert.notEqual(changed.code, 0, 'Changed payload must not reuse a durable request ID');
      assert.match(changed.stderr, /LIVE_REQUEST_REUSED/);
    },
  );

  await ok(
    'Two staff connect commands with different UUIDs share one pending channel revision',
    async () => {
      contestedChannel = await channel('distinct_connect');
      const results = await race(
        'channel_connect',
        rpcSql('request_tiktok_connection', connectArgs(contestedChannel)),
        rpcSql('request_tiktok_connection', connectArgs(contestedChannel)),
      );
      assert.ok(
        results.every((r) => r.code === 0),
        JSON.stringify(results),
      );
      assert.ok(results.every((r) => r.value.revision === 1));
      const row = await channelRow(contestedChannel);
      connectionRevision = row.revision;
      assert.equal(row.connection_status, 'CONNECTING');
      assert.equal(row.current_session_id, null);
      assert.equal(await channelCount('live_channel_commands', contestedChannel), '1');
      assert.equal(await channelCount('live_channel_sessions', contestedChannel), '0');
    },
  );

  await ok(
    'Two independent listener owners competing for one revision receive exactly one active lease',
    async () => {
      const statement = rpcSql(
        'claim_tiktok_connection',
        claimArgs(contestedChannel, connectionRevision),
      );
      const results = await race('channel_lease', statement, statement, owner, manager);
      assert.equal(results.filter((r) => r.code === 0).length, 1);
      assert.match(results.find((r) => r.code !== 0).stderr, /TIKTOK_LISTENER_BUSY/);
      const winner = results.findIndex((r) => r.code === 0);
      const row = await channelRow(contestedChannel);
      assert.equal(row.lease_actor, [owner, manager][winner]);
      assert.equal(row.lease_token, results[winner].value.lease_token);
      assert.equal(row.current_session_id, null);
      assert.equal(await channelCount('live_channel_sessions', contestedChannel), '0');
    },
  );

  await ok(
    'Duplicate simultaneous verified LIVE reports create one daily campaign and one room session',
    async () => {
      const id = await channel('duplicate_live_report');
      const request = await rpc('request_tiktok_connection', connectArgs(id));
      const lease = await rpc('claim_tiktok_connection', claimArgs(id, request.revision));
      const statement = rpcSql(
        'report_tiktok_connection',
        reportArgs(id, lease, 'same_verified_room'),
      );
      const results = await race('channel_report', statement, statement, owner, owner);
      assert.ok(
        results.every((r) => r.code === 0),
        JSON.stringify(results),
      );
      assert.equal(results[0].value.session_id, results[1].value.session_id);
      assert.ok(results[0].value.session_id);
      assert.equal(await channelCount('live_channel_campaigns', id), '1');
      assert.equal(await channelCount('live_channel_sessions', id), '1');
      const row = await channelRow(id);
      assert.equal(row.connection_status, 'LIVE');
      assert.equal(row.current_session_id, results[0].value.session_id);
      assert.equal(row.lease_token, lease.lease_token);
    },
  );

  await ok(
    'Seller disconnect racing a verified LIVE report always fences the old listener and ends offline',
    async () => {
      const id = await channel('report_disconnect');
      const request = await rpc('request_tiktok_connection', connectArgs(id));
      const lease = await rpc('claim_tiktok_connection', claimArgs(id, request.revision));
      const report = rpcSql(
        'report_tiktok_connection',
        reportArgs(id, lease, 'disconnect_race_room'),
      );
      const results = await race(
        'channel_disconnect',
        report,
        rpcSql('request_tiktok_connection', connectArgs(id, 'disconnected')),
        owner,
        staffA,
      );
      assert.equal(results[1].code, 0, results[1].stderr);
      if (results[0].code !== 0) assert.match(results[0].stderr, /TIKTOK_LISTENER_STALE/);
      const row = await channelRow(id);
      assert.equal(row.desired_state, 'disconnected');
      assert.equal(row.connection_status, 'OFFLINE');
      assert.equal(row.revision, request.revision + 1);
      assert.equal(row.lease_token, null);
      assert.equal(row.lease_actor, null);
      assert.equal(await channelCount('live_channel_commands', id), '2');
      assert.equal(
        await channelCount('live_channel_sessions', id),
        results[0].code === 0 ? '1' : '0',
      );
      const replay = await psql(session(owner) + report).done;
      assert.notEqual(replay.code, 0);
      assert.match(replay.stderr, /TIKTOK_LISTENER_STALE/);
      if (row.current_session_id)
        assert.equal(
          await sql(
            `select connection_status from public.live_sessions where id=${quote(row.current_session_id)};`,
          ),
          'disconnected',
        );
    },
  );

  await ok(
    'Expired listener report loses to replacement lease without resurrecting its stale token',
    async () => {
      const id = await channel('expired_listener');
      const request = await rpc('request_tiktok_connection', connectArgs(id));
      const lease = await rpc('claim_tiktok_connection', claimArgs(id, request.revision));
      // Only synthetic fixture expiry; no production clock or session is changed.
      await sql(`update public.live_channel_connections set lease_expires_at=clock_timestamp()-interval '1 second'
      where workspace_id=${quote(fixture.w)} and channel_id=${quote(id)};`);
      const results = await race(
        'channel_replace',
        rpcSql('report_tiktok_connection', reportArgs(id, lease, 'expired_room')),
        rpcSql('claim_tiktok_connection', claimArgs(id, request.revision)),
        owner,
        manager,
      );
      assert.notEqual(results[0].code, 0);
      assert.match(results[0].stderr, /TIKTOK_LISTENER_STALE/);
      assert.equal(results[1].code, 0, results[1].stderr);
      const row = await channelRow(id);
      assert.equal(row.lease_actor, manager);
      assert.equal(row.lease_token, results[1].value.lease_token);
      assert.notEqual(row.lease_token, lease.lease_token);
      assert.equal(await channelCount('live_channel_sessions', id), '0');
    },
  );

  await ok(
    'Ingest racing disconnect commits before fencing or rolls back fully; late replay cannot insert',
    async () => {
      const id = await channel('ingest_disconnect');
      const request = await rpc('request_tiktok_connection', connectArgs(id));
      const lease = await rpc('claim_tiktok_connection', claimArgs(id, request.revision));
      const live = await rpc('report_tiktok_connection', reportArgs(id, lease, 'ingest_race_room'));
      const input = {
        ...channelArgs(id),
        p_revision: lease.revision,
        p_lease_token: lease.lease_token,
        p_session_id: live.session_id,
        p_comments: [
          {
            message_id: 'native-channel-' + randomUUID(),
            author_external_id: 'synthetic-stable-author',
            author_display_name: 'Synthetic observer',
            text: 'Observation only, never a sale',
            occurred_at: new Date().toISOString(),
          },
        ],
      };
      const ingest = rpcSql('ingest_tiktok_comments', input);
      const results = await race(
        'channel_ingest',
        ingest,
        rpcSql('request_tiktok_connection', connectArgs(id, 'disconnected')),
        owner,
        staffB,
      );
      assert.equal(results[1].code, 0, results[1].stderr);
      if (results[0].code !== 0) assert.match(results[0].stderr, /TIKTOK_INGEST_STALE/);
      const accepted = results[0].code === 0 ? '1' : '0';
      assert.equal(
        await sql(
          `select count(*) from public.live_comments where session_id=${quote(live.session_id)};`,
        ),
        accepted,
      );
      assert.equal(
        await sql(`select count(*) from public.live_provider_message_keys where workspace_id=${quote(fixture.w)}
      and external_comment_id=${quote(input.p_comments[0].message_id)};`),
        accepted,
      );
      const replay = await psql(session(owner) + ingest).done;
      assert.notEqual(replay.code, 0);
      assert.match(replay.stderr, /TIKTOK_INGEST_STALE/);
      const row = await channelRow(id);
      assert.equal(row.connection_status, 'OFFLINE');
      assert.equal(row.lease_token, null);
      assert.deepEqual(
        await businessSnapshot(),
        businessBeforeChannelRaces,
        'Channel connection/observations must not change any sale, hold, lot, print or cash row',
      );
    },
  );

  stage = 'Provider terminal lifecycle races';
  async function terminalFixture(username) {
    const id = await channel(username);
    const request = await rpc('request_tiktok_connection', connectArgs(id));
    const lease = await rpc('claim_tiktok_connection', claimArgs(id, request.revision));
    const live = await rpc('report_tiktok_connection', reportArgs(id, lease, username + '_room'));
    return { id, lease, live };
  }
  const terminalArgs = (context, requestId = randomUUID()) => ({
    ...channelArgs(context.id),
    p_revision: context.lease.revision,
    p_lease_token: context.lease.lease_token,
    p_request_id: requestId,
  });
  await ok(
    'Concurrent identical STREAM_END acknowledgements end one session with one audit/outbox event',
    async () => {
      const context = await terminalFixture('terminal_retry');
      const statement = rpcSql('finish_tiktok_live', terminalArgs(context));
      const results = await race('channel_end_retry', statement, statement, owner, owner);
      assert.ok(
        results.every((r) => r.code === 0),
        JSON.stringify(results),
      );
      assert.deepEqual(results[0].value, results[1].value);
      const row = await channelRow(context.id);
      assert.equal(row.desired_state, 'disconnected');
      assert.equal(row.lease_token, null);
      assert.equal(row.revision, context.lease.revision + 1);
      assert.equal(await channelCount('live_channel_commands', context.id), '2');
      assert.equal(
        await sql(
          `select count(*) from public.audit_events where entity_id=${quote(context.id)} and action='tiktok.live_ended';`,
        ),
        '1',
      );
      assert.equal(
        await sql(
          `select status from public.live_sessions where id=${quote(context.live.session_id)};`,
        ),
        'ended',
      );
    },
  );
  await ok(
    'Provider end racing seller disconnect cannot leave the channel LIVE or retain its token',
    async () => {
      const context = await terminalFixture('terminal_disconnect');
      const results = await race(
        'channel_end_stop',
        rpcSql('finish_tiktok_live', terminalArgs(context)),
        rpcSql('request_tiktok_connection', connectArgs(context.id, 'disconnected')),
        owner,
        staffA,
      );
      assert.equal(results[1].code, 0, results[1].stderr);
      if (results[0].code !== 0) assert.match(results[0].stderr, /TIKTOK_LISTENER_STALE/);
      const row = await channelRow(context.id);
      assert.equal(row.connection_status, 'OFFLINE');
      assert.equal(row.desired_state, 'disconnected');
      assert.equal(row.lease_token, null);
      const stale = await psql(session(owner) + rpcSql('finish_tiktok_live', terminalArgs(context)))
        .done;
      assert.notEqual(stale.code, 0);
      assert.match(stale.stderr, /TIKTOK_LISTENER_STALE/);
    },
  );
  await ok(
    'A renewed CONNECT racing old provider end remains pending and fences the old terminal callback',
    async () => {
      const context = await terminalFixture('terminal_reconnect');
      await sql(`update public.live_channel_connections set heartbeat_at=clock_timestamp()-interval '2 minutes',
      requested_at=clock_timestamp()-interval '2 minutes' where workspace_id=${quote(fixture.w)} and channel_id=${quote(context.id)};`);
      const results = await race(
        'channel_end_new',
        rpcSql('finish_tiktok_live', terminalArgs(context)),
        rpcSql('request_tiktok_connection', connectArgs(context.id)),
        owner,
        staffB,
      );
      assert.equal(results[1].code, 0, results[1].stderr);
      if (results[0].code !== 0) assert.match(results[0].stderr, /TIKTOK_LISTENER_STALE/);
      const row = await channelRow(context.id);
      assert.equal(row.desired_state, 'connected');
      assert.equal(row.connection_status, 'CONNECTING');
      assert.equal(row.lease_token, null);
      assert.ok(row.revision > context.lease.revision);
      const stale = await psql(session(owner) + rpcSql('finish_tiktok_live', terminalArgs(context)))
        .done;
      assert.notEqual(stale.code, 0);
      assert.match(stale.stderr, /TIKTOK_LISTENER_STALE/);
    },
  );

  stage = '012 normalized runtime event contention';
  const runtimeEventArgs = (context) => ({
    ...channelArgs(context.id),
    p_revision: context.lease.revision,
    p_lease_token: context.lease.lease_token,
    p_session_id: context.live.session_id,
    p_events: [
      {
        type: 'VIEWER_COUNT',
        event_id: randomUUID(),
        occurred_at: new Date().toISOString(),
        viewer_count: 24,
      },
      { type: 'MEMBER_JOIN', event_id: randomUUID(), occurred_at: new Date().toISOString() },
    ],
  });
  await ok(
    'Concurrent duplicate viewer/member batch applies once with two real database connections',
    async () => {
      const context = await terminalFixture('runtime_duplicate');
      const input = runtimeEventArgs(context);
      const statement = rpcSql('ingest_tiktok_events', input);
      const results = await race('runtime_duplicate', statement, statement, owner, owner);
      assert.ok(
        results.every((r) => r.code === 0),
        JSON.stringify(results),
      );
      assert.deepEqual(results.map((r) => r.value.inserted).sort(), [0, 2]);
      assert.deepEqual(results.map((r) => r.value.duplicates).sort(), [0, 2]);
      const state = await rpc('get_live_runtime', {
        p_workspace_id: fixture.w,
        p_session_id: context.live.session_id,
      });
      assert.equal(state.telemetry.current_viewer_count, 24);
      assert.equal(state.telemetry.peak_viewer_count, 24);
      assert.equal(state.telemetry.member_event_count, 1);
      assert.equal(
        await sql(`select count(*) from app_private.live_runtime_event_keys
      where workspace_id=${quote(fixture.w)} and session_id=${quote(context.live.session_id)};`),
        '2',
      );
      assert.deepEqual(await businessSnapshot(), businessBeforeChannelRaces);
    },
  );
  await ok(
    'Controlled event-vs-disconnect ordering accepts before the fence and rejects after it',
    async () => {
      for (const ingestFirst of [true, false]) {
        const context = await terminalFixture(
          ingestFirst ? 'runtime_before_stop' : 'runtime_after_stop',
        );
        const ingest = rpcSql('ingest_tiktok_events', runtimeEventArgs(context));
        const disconnect = rpcSql(
          'request_tiktok_connection',
          connectArgs(context.id, 'disconnected'),
        );
        const results = await race(
          ingestFirst ? 'events_before_stop' : 'events_after_stop',
          ingestFirst ? ingest : disconnect,
          ingestFirst ? disconnect : ingest,
          ingestFirst ? owner : staffA,
          ingestFirst ? staffA : owner,
          true,
        );
        const accepted = results[ingestFirst ? 0 : 1];
        const stoppedResult = results[ingestFirst ? 1 : 0];
        assert.equal(stoppedResult.code, 0, stoppedResult.stderr);
        if (ingestFirst) {
          assert.equal(accepted.code, 0, accepted.stderr);
          assert.deepEqual(accepted.value, { inserted: 2, duplicates: 0 });
        } else {
          assert.notEqual(accepted.code, 0);
          assert.match(accepted.stderr, /TIKTOK_EVENT_STALE/);
        }
        assert.equal(
          await sql(`select count(*) from app_private.live_runtime_event_keys
        where workspace_id=${quote(fixture.w)} and session_id=${quote(context.live.session_id)};`),
          ingestFirst ? '2' : '0',
        );
        const row = await channelRow(context.id);
        assert.equal(row.connection_status, 'OFFLINE');
        assert.equal(row.lease_token, null);
        const replay = await psql(session(owner) + ingest).done;
        assert.notEqual(replay.code, 0);
        assert.match(replay.stderr, /TIKTOK_EVENT_STALE/);
        assert.deepEqual(await businessSnapshot(), businessBeforeChannelRaces);
      }
    },
  );

  await ok(
    'Every Phase C race leaves physical stock unchanged and creates no sales, revenue or cash',
    async () => {
      const state = await rpc('get_sales_state', { p_workspace_id: fixture.w });
      assert.ok(state.inventory.every((r) => r.available >= 0 && r.reserved <= r.on_hand));
      assert.equal(state.summary.net_sales, '0');
      assert.equal(state.summary.cost_of_goods, '0');
      for (const table of [
        'sales_orders',
        'sales_order_lines',
        'sales_events',
        'cash_transactions',
        'cash_movements',
      ])
        assert.equal(await sql(`select count(*) from public.${table};`), '0', table);
      assert.equal(
        await sql(
          'select count(*) from public.inventory_lots where remaining_qty<>initial_qty or remaining_cost<>initial_cost;',
        ),
        '0',
      );
      assert.equal(await sql('select count(*) from public.customers;'), '1');
      for (const migration of migrations) {
        const content = await readFile(join(project, 'supabase', 'migrations', migration.name));
        assert.equal(
          createHash('sha256').update(content).digest('hex'),
          migration.sha256,
          migration.name,
        );
      }
    },
  );
} catch (error) {
  if (!checks.some((entry) => entry.status === 'FAIL'))
    checks.push({ name: stage, status: 'FAIL', detail: error.message });
  console.error('FAIL', stage, error.message);
  process.exitCode = 1;
} finally {
  for (const handle of children) {
    handle.stdin?.destroy();
    handle.kill();
  }
  if (startAttempted) {
    try {
      assertOwnedDirectory(runDirectory);
      const status = await child(executable('pg_ctl'), ['-D', dataDirectory, 'status'], '').done;
      if (status.code === 0)
        await command('pg_ctl', ['-D', dataDirectory, '-w', '-t', '20', '-m', 'fast', 'stop']);
      else if (status.code !== 3)
        throw new Error(`Cannot verify own server status: ${status.stderr}`);
      stopped = true;
    } catch (error) {
      checks.push({ name: 'Stop own isolated server', status: 'FAIL', detail: error.message });
      process.exitCode = 1;
    }
  }
  if (runDirectory && (!startAttempted || stopped)) {
    assertOwnedDirectory(runDirectory);
    await rm(runDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
  await mkdir(join(project, 'test-results'), { recursive: true });
  await writeFile(
    join(project, 'test-results', 'live-concurrency.json'),
    JSON.stringify(
      {
        checked_at: new Date().toISOString(),
        engine: 'Native PostgreSQL',
        server_version: serverVersion,
        cloud_tested: false,
        simultaneous_sessions_tested: observedSessionPairs > 0,
        observed_simultaneously_blocked_session_pairs: observedSessionPairs,
        contention_proof:
          'Both independent psql sessions observed with wait_event_type=Lock before releasing an admin barrier transaction.',
        localhost_only: true,
        own_cluster_stopped: stopped,
        migrations,
        status: checks.some((entry) => entry.status === 'FAIL') ? 'FAIL' : 'PASS',
        checks,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    `Live native concurrency: ${checks.filter((entry) => entry.status === 'PASS').length} PASS, ${checks.filter((entry) => entry.status === 'FAIL').length} FAIL`,
  );
}
