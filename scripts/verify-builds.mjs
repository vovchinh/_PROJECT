import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadEnv } from 'vite';

const vite = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
const run = (env) =>
  spawnSync(process.execPath, [vite, 'build'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
const base = {
  VITE_SUPABASE_URL: 'https://example.supabase.co',
  VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_placeholder_for_build_only',
  VITE_DEMO_MODE: 'false',
};
const cloud = run(base);
assert.equal(cloud.status, 0, cloud.stderr);
console.log('PASS Cloud code builds with placeholder URL/key (no network or live Auth test)');
const forbidden = run({
  ...base,
  VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_placeholder_for_guard_test',
});
assert.notEqual(forbidden.status, 0);
assert.match(forbidden.stderr, /secret\/service_role/);
console.log('PASS Secret key rejected before bundling');
const legacy = run({
  ...base,
  VITE_SUPABASE_PUBLISHABLE_KEY: `x.${Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url')}.x`,
});
assert.notEqual(legacy.status, 0);
assert.match(legacy.stderr, /secret\/service_role/);
console.log('PASS Legacy service role rejected before bundling');
// Test demo separately, then restore the user's configured build.
const demo = run({
  VITE_SUPABASE_URL: '',
  VITE_SUPABASE_PUBLISHABLE_KEY: '',
  VITE_DEMO_MODE: 'true',
});
assert.equal(demo.status, 0, demo.stderr);
console.log('PASS Demo production build');
const configured = run({});
assert.equal(configured.status, 0, configured.stderr);
const finalMode =
  loadEnv('production', process.cwd(), 'VITE_').VITE_DEMO_MODE === 'false' ? 'cloud' : 'demo';
console.log(`PASS Configured ${finalMode} production build restored`);
mkdirSync('test-results', { recursive: true });
writeFileSync(
  'test-results/build-modes.json',
  JSON.stringify({ passed: 5, cloud_live_tested: false, final_build: finalMode }, null, 2),
);
