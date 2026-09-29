// Canonical account handle shared by browser code and Node provider tools.
// Stable provider user IDs are a separate identity and never derived here.
export function normalizeTikTokUsername(input) {
  if (typeof input !== 'string')
    throw Object.assign(Error('TIKTOK_USER_INVALID'), { code: 'TIKTOK_USER_INVALID' });
  const value = input.trim().replace(/^@/u, '').toLowerCase();
  if (!/^[a-z0-9_][a-z0-9_.]{0,23}$/u.test(value) || value.endsWith('.'))
    throw Object.assign(Error('TIKTOK_USER_INVALID'), { code: 'TIKTOK_USER_INVALID' });
  return value;
}
