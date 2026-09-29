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
const parentDirectory = resolve(project, '.tools', 'foundation-concurrency');
const admin = 'chidi_concurrency';
const owner = '11111111-1111-4111-8111-111111111111';
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
async function value(statement, asOwner = false) {
  const output = await sql((asOwner ? session() : '') + statement);
  const last = output.trim().split(/\r?\n/).at(-1);
  return JSON.parse(last);
}
const session = () => `set request.jwt.claim.sub=${quote(owner)}; set role authenticated;\n`;
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
const rpc = (name, args) => value(rpcSql(name, args), true);
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
async function race(name, firstSql, secondSql) {
  const barrier = psql(undefined, `chidi_barrier_${name}`);
  barrier.process.stdin.write(
    `begin; select id from public.workspaces where id=${quote(fixture.w)} for update; select 'BARRIER_READY';\n`,
  );
  await until(
    () => barrier.output().includes('BARRIER_READY'),
    'Barrier did not acquire the workspace lock.',
  );
  const applications = [`chidi_${name}_a`, `chidi_${name}_b`];
  const jobs = [
    psql(session() + firstSql, applications[0]),
    psql(session() + secondSql, applications[1]),
  ];
  try {
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
  return product;
}
const hold = (product, qty = 1) => ({
  product_id: product.id,
  warehouse_id: fixture.warehouse,
  qty,
  date: '2026-08-02',
  reason: 'Synthetic independently competing reservation',
  reference: 'Concurrency test',
});
const reserveSql = (payload, request = randomUUID()) =>
  rpcSql('reserve_inventory', {
    p_workspace_id: fixture.w,
    p_payload: payload,
    p_request_id: request,
  });
async function stock(product) {
  const state = await rpc('get_sales_state', { p_workspace_id: fixture.w });
  return state.inventory.find((entry) => entry.product_id === product.id);
}
const order = (product, code) =>
  rpc('save_sales_order', {
    p_workspace_id: fixture.w,
    p_payload: {
      code,
      customer_id: fixture.customer,
      warehouse_id: fixture.warehouse,
      order_date: '2026-08-01',
      lines: [{ product_id: product.id, qty: 1, unit_price: 200, discount: 0 }],
    },
  });

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
    insert into auth.users values(${quote(owner)},'synthetic@concurrency.test',now());`);
  stage = 'applying 001 through 006 to a new empty database';
  for (const name of [
    '001_core.sql',
    '002_operations.sql',
    '003_sales_inventory.sql',
    '004_catalog_variants_aliases.sql',
    '005_customer_order_foundation.sql',
    '006_inventory_reservations.sql',
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
  stage = 'independent-session contention';

  await ok(
    'AVAILABLE=1: two simultaneously blocked reserve requests allow exactly one success',
    async () => {
      const product = await sku('RACE-HOLD');
      const results = await race('holds', reserveSql(hold(product)), reserveSql(hold(product)));
      assert.equal(results.filter((r) => r.code === 0).length, 1);
      assert.match(results.find((r) => r.code !== 0).stderr, /INVENTORY_INSUFFICIENT/);
      const after = await stock(product);
      assert.deepEqual([after.on_hand, after.reserved, after.available], [1, 1, 0]);
    },
  );
  await ok(
    'Manual hold versus existing sales confirm cannot both claim the final unit',
    async () => {
      const product = await sku('RACE-LEGACY'),
        id = await order(product, 'ORDER-RACE-LEGACY');
      const results = await race(
        'legacy',
        reserveSql(hold(product)),
        rpcSql('transition_sales_order', {
          p_workspace_id: fixture.w,
          p_order_id: id,
          p_action: 'confirm',
          p_payload: { date: '2026-08-02' },
          p_request_id: randomUUID(),
        }),
      );
      assert.equal(results.filter((r) => r.code === 0).length, 1);
      const after = await stock(product);
      assert.deepEqual([after.on_hand, after.reserved, after.available], [1, 1, 0]);
    },
  );
  await ok(
    'Concurrent identical request retry creates one hold, allocation and audit event',
    async () => {
      const product = await sku('RACE-RETRY', 2),
        request = randomUUID(),
        statement = reserveSql(hold(product), request);
      const results = await race('retry', statement, statement);
      assert.ok(
        results.every((r) => r.code === 0),
        JSON.stringify(results),
      );
      assert.equal(results[0].value, results[1].value);
      const held = results[0].value;
      assert.equal(
        await sql(`select count(*) from public.inventory_reservations where id=${quote(held)};`),
        '1',
      );
      assert.equal(
        await sql(
          `select count(*) from public.reservation_lots where reservation_id=${quote(held)};`,
        ),
        '1',
      );
      assert.equal(
        await sql(
          `select count(*) from public.audit_events where action='inventory.reserved' and entity_id=${quote(held)};`,
        ),
        '1',
      );
      assert.equal((await stock(product)).available, 1);
    },
  );
  await ok(
    'Concurrent reuse of request ID with different quantities rejects the conflicting payload',
    async () => {
      const product = await sku('RACE-PAYLOAD', 3),
        request = randomUUID();
      const results = await race(
        'payload',
        reserveSql(hold(product, 1), request),
        reserveSql(hold(product, 2), request),
      );
      assert.equal(results.filter((r) => r.code === 0).length, 1);
      assert.match(results.find((r) => r.code !== 0).stderr, /request_id/);
      assert.equal(
        await sql(
          `select count(*) from app_private.inventory_reservation_requests where request_id=${quote(request)};`,
        ),
        '1',
      );
    },
  );
  await ok(
    'Two orders racing to consume the same hold produce one confirmed order and one allocation',
    async () => {
      const product = await sku('RACE-TRANSFER');
      const held = await rpc('reserve_inventory', {
        p_workspace_id: fixture.w,
        p_payload: hold(product),
        p_request_id: randomUUID(),
      });
      const first = await order(product, 'ORDER-TRANSFER-A'),
        second = await order(product, 'ORDER-TRANSFER-B');
      const transfer = (id) =>
        rpcSql('transfer_inventory_reservations', {
          p_workspace_id: fixture.w,
          p_order_id: id,
          p_reservation_ids: [held],
          p_date: '2026-08-02',
          p_request_id: randomUUID(),
        });
      const results = await race('transfer', transfer(first), transfer(second));
      assert.equal(results.filter((r) => r.code === 0).length, 1);
      assert.equal(
        await sql(
          `select count(*) from public.sales_orders where id in (${quote(first)},${quote(second)}) and status='confirmed' and customer_snapshot is not null;`,
        ),
        '1',
      );
      assert.equal(
        await sql(
          `select count(*) from public.sales_allocations where order_id in (${quote(first)},${quote(second)}) and status='reserved';`,
        ),
        '1',
      );
      assert.equal(
        await sql(`select status from public.inventory_reservations where id=${quote(held)};`),
        'consumed',
      );
      const after = await stock(product);
      assert.deepEqual([after.on_hand, after.reserved, after.available], [1, 1, 0]);
    },
  );
  await ok(
    'Concurrent normalized alias insertion for one SKU never creates duplicate mappings',
    async () => {
      const product = await sku('RACE-ALIAS');
      const create = (alias_text) =>
        rpcSql('save_product_alias', {
          p_workspace_id: fixture.w,
          p_payload: { product_id: product.id, alias_text, active: true },
        });
      const results = await race('aliases', create('  LIVE  27 '), create('live 27'));
      assert.equal(results.filter((r) => r.code === 0).length, 1);
      assert.equal(
        await sql(
          `select count(*) from public.product_aliases where workspace_id=${quote(fixture.w)} and product_id=${quote(product.id)} and alias_key='live 27';`,
        ),
        '1',
      );
    },
  );
  await ok(
    'All contention tests preserve nonnegative available stock and create no cash or revenue',
    async () => {
      const result = await rpc('get_sales_state', { p_workspace_id: fixture.w });
      assert.ok(result.inventory.every((r) => r.available >= 0 && r.reserved <= r.on_hand));
      assert.equal(result.summary.net_sales, '0');
      assert.equal(result.summary.cost_of_goods, '0');
      assert.equal(await sql('select count(*) from public.cash_movements;'), '0');
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
    join(project, 'test-results', 'foundation-concurrency.json'),
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
    `Native concurrency: ${checks.filter((entry) => entry.status === 'PASS').length} PASS, ${checks.filter((entry) => entry.status === 'FAIL').length} FAIL`,
  );
}
