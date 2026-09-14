import { readFile, readdir, access, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const root = resolve('.');
const required = [
  'README.md',
  'TASKS.md',
  'START_CHIDI.cmd',
  'OPEN_DOCUMENTATION.cmd',
  '.env.example',
  'docs/index.html',
  'docs/architecture.svg',
  'docs/THIET_LAP_VAN_HANH_V11.md',
  'docs/CHANGELOG.md',
  'docs/VERIFICATION.md',
  'supabase/migrations/001_core.sql',
  'supabase/migrations/002_operations.sql',
  'dist/index.html',
];
for (const file of required) await access(join(root, file));
const markdown = [
  'README.md',
  'TASKS.md',
  ...(await readdir('docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`),
];
const missing = [];
let links = 0;
for (const file of markdown) {
  const source = await readFile(file, 'utf8');
  for (const match of source.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const href = match[1].trim().replace(/^<|>$/g, '');
    if (/^(https?:|mailto:|#|app:)/i.test(href)) continue;
    const target = decodeURIComponent(href.split('#')[0]);
    if (!target) continue;
    links++;
    try {
      await access(resolve(dirname(resolve(file)), target));
    } catch {
      missing.push(`${file}: ${href}`);
    }
  }
}
assert.deepEqual(missing, [], 'Missing local document links');
const data = JSON.parse(await readFile('data/chidi-import-2026-09-11-validated.json', 'utf8'));
const bundles = (await readdir('dist/assets')).filter((f) => f.endsWith('.js'));
for (const file of bundles) {
  const source = await readFile(`dist/assets/${file}`, 'utf8');
  assert.ok(!source.includes(data.source_id), 'Private workbook hash bundled');
  for (const row of data.purchases)
    assert.ok(!source.includes(row.legacy_id), 'Private transaction ID bundled');
  assert.ok(!/sb_secret_[A-Za-z0-9_-]{20,}/.test(source), 'Secret-like key bundled');
  assert.ok(
    !source.includes('sb_publishable_placeholder_for_build_only'),
    'Placeholder build left behind',
  );
}
const example = await readFile('.env.example', 'utf8');
assert.match(example, /VITE_SUPABASE_URL=\s*\n/);
assert.match(example, /VITE_SUPABASE_PUBLISHABLE_KEY=\s*\n/);
const result = {
  checked_at: new Date().toISOString(),
  required_files: required.length,
  local_links: links,
  missing_links: 0,
  private_data_in_bundle: false,
  placeholder_cloud_build: false,
  source_purchases: data.purchases.length,
  source_cash: data.cash.length,
};
await mkdir('test-results', { recursive: true });
await writeFile('test-results/delivery.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
