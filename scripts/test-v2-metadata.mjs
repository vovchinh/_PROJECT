import assert from 'node:assert/strict';
import { parseMetadata, compareMetadata } from './lib/v2-metadata.mjs';
let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log('PASS', name);
}
const source = {
  format_version: 1,
  scope: 'v2_catalog_only',
  server_version_num: '180003',
  checked_at: '2026-09-15',
  tables: [
    {
      schema_name: 'public',
      table_name: 'customers',
      present: true,
      rls: true,
      authenticated_write: false,
      authenticated_column_write: false,
    },
  ],
  routines: [
    {
      signature: 'public.save_customer(uuid,jsonb)',
      arguments: 'p_workspace_id uuid, p_payload jsonb',
      settings: ['search_path=""', 'statement_timeout=0'],
      anon_execute: false,
      function_body_md5: 'abc',
    },
  ],
  policies: [
    {
      schemaname: 'public',
      tablename: 'customers',
      roles: ['authenticated', 'example'],
      qual: 'member_role(workspace_id) IS NOT NULL',
    },
  ],
  columns: [
    {
      schema_name: 'public',
      table_name: 'customers',
      column_name: 'name',
      data_type: 'text',
      not_null: true,
    },
  ],
  constraints: [
    {
      schema_name: 'public',
      table_name: 'customers',
      conname: 'generated_a',
      contype: 'f',
      condeferrable: false,
      definition: 'FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id)',
    },
  ],
};
const run = (change) => {
  const actual = structuredClone(source);
  change(actual);
  return compareMetadata(source, actual);
};
test('SQL Editor cell, wrapped download, BOM and local audit formats accepted', () => {
  for (const value of [
    source,
    { v2_baseline: source },
    [{ v2_baseline: source }],
    [{ v2_baseline: JSON.stringify(source) }],
    { local_metadata: source },
  ])
    assert.deepEqual(parseMetadata('\uFEFF' + JSON.stringify(value)), source);
});
test('Malformed, truncated, obsolete and missing section JSON rejected', () => {
  for (const value of [
    '{',
    'null',
    JSON.stringify({ ...source, format_version: 2 }),
    JSON.stringify({ ...source, policies: null }),
    JSON.stringify({ ...source, server_version_num: null }),
  ])
    assert.throws(() => parseMetadata(value));
});
test('Ordering, timestamp and generated constraint names do not create drift', () => {
  assert.equal(
    run((v) => {
      v.checked_at = 'later';
      v.routines[0].settings.reverse();
      v.policies[0].roles.reverse();
      v.constraints[0].conname = 'generated_b';
    }).status,
    'PASS',
  );
});
test('RLS, anon and column write privilege changes are blocked', () => {
  for (const change of [
    (v) => (v.tables[0].rls = false),
    (v) => (v.tables[0].authenticated_column_write = true),
    (v) => (v.routines[0].anon_execute = true),
  ])
    assert.equal(run(change).status, 'BLOCKED');
});
test('Missing objects, extra policies and duplicate constraints are blocked', () => {
  for (const change of [
    (v) => (v.tables = []),
    (v) => (v.routines = []),
    (v) => (v.columns = []),
    (v) => v.policies.push({ ...v.policies[0], qual: 'true' }),
    (v) => v.constraints.push({ ...v.constraints[0] }),
  ])
    assert.equal(run(change).status, 'BLOCKED');
});
test('RPC arguments/body/search_path and FK behavior are compared strictly', () => {
  for (const change of [
    (v) => (v.routines[0].arguments = 'p_payload jsonb, p_workspace_id uuid'),
    (v) => (v.routines[0].function_body_md5 = 'different'),
    (v) => (v.routines[0].settings = ['search_path=public']),
    (v) => (v.constraints[0].condeferrable = true),
  ])
    assert.equal(run(change).status, 'BLOCKED');
});
test('PostgreSQL major difference is visible and scope never certifies A1 runtime', () => {
  const r = run((v) => (v.server_version_num = '170006'));
  assert.equal(r.warnings.length, 1);
  assert.equal(r.authenticated_runtime_verified, false);
  assert.equal(r.full_a1_complete, false);
});
console.log(`Metadata comparator: ${passed}/${passed} PASS`);
