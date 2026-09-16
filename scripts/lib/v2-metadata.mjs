// A1 offline comparison. Only captured catalog metadata is compared, never SQL executed.
const sections = ['tables', 'routines', 'policies', 'columns', 'constraints'];
const stable = (value, key = '') => {
  if (Array.isArray(value)) {
    const items = value.map((v) => stable(v));
    return ['roles', 'settings'].includes(key) ? items.sort() : items;
  }
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, stable(value[k], k)]),
    );
  return value;
};
export function parseMetadata(text) {
  let value;
  try {
    value = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('JSON không hợp lệ hoặc chưa được sao chép đầy đủ.');
  }
  if (Array.isArray(value) && value.length === 1) value = value[0];
  value = value?.v2_baseline ?? value?.local_metadata ?? value;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      throw new Error('Ô v2_baseline chưa chứa JSON hợp lệ.');
    }
  }
  if (!value || value.format_version !== 1 || value.scope !== 'v2_catalog_only')
    throw new Error('Cần kết quả từ phiên bản hiện tại của verify_v2_baseline.sql.');
  if (
    sections.some(
      (s) =>
        !Array.isArray(value[s]) ||
        value[s].some((r) => !r || typeof r !== 'object' || Array.isArray(r)),
    )
  )
    throw new Error('Kết quả metadata thiếu hoặc sai cấu trúc bảng dữ liệu.');
  if (!/^\d{5,6}$/.test(String(value.server_version_num)))
    throw new Error('Thiếu phiên bản PostgreSQL trong kết quả.');
  return value;
}
function rowsFor(snapshot, section) {
  return snapshot[section]
    .map((row) => {
      const fields = { ...row };
      // Constraint names can be generated differently; definitions, multiplicity and flags matter.
      if (section === 'constraints') delete fields.conname;
      return JSON.stringify(stable(fields));
    })
    .sort();
}
export function compareMetadata(expected, actual) {
  const differences = [];
  for (const section of sections) {
    const reference = rowsFor(expected, section),
      candidate = rowsFor(actual, section);
    if (JSON.stringify(reference) !== JSON.stringify(candidate))
      differences.push({
        section,
        expected_rows: reference.length,
        actual_rows: candidate.length,
        issue: 'Metadata khác baseline; cần đối chiếu mục này.',
      });
  }
  const warnings = [];
  if (
    Math.floor(Number(expected.server_version_num) / 10000) !==
    Math.floor(Number(actual.server_version_num) / 10000)
  )
    warnings.push(
      'Khác major PostgreSQL; khác biệt cách diễn giải catalog cần rà soát, không tự bỏ qua.',
    );
  return {
    status: differences.length ? 'BLOCKED' : 'PASS',
    scope:
      'Chỉ metadata của 8 bảng và 10 hàm được liệt kê; không chứng nhận toàn bộ schema, Auth, RLS runtime hoặc concurrency.',
    expected_postgres: expected.server_version_num,
    actual_postgres: actual.server_version_num,
    differences,
    warnings,
    authenticated_runtime_verified: false,
    full_a1_complete: false,
  };
}
