// Usage: node scripts/compare-v2-baseline.mjs path/to/sql-editor-result.json
// Reads local JSON only; no .env, network, database connection or SQL execution.
import { readFile, stat } from 'node:fs/promises';
import { parseMetadata, compareMetadata } from './lib/v2-metadata.mjs';
const input = process.argv[2];
try {
  if (!input || process.argv.length !== 3)
    throw new Error('Cách dùng: node scripts/compare-v2-baseline.mjs <file-json-ket-qua-sql>');
  if ((await stat(input)).size > 2_000_000)
    throw new Error('File metadata vượt 2 MB; kiểm tra đã chọn đúng kết quả SQL.');
  const reference = await readFile(
    new URL('../.tools/a1/v2-baseline.json', import.meta.url),
    'utf8',
  ).catch(() => {
    throw new Error('Chạy node scripts/audit-v2-baseline.mjs để tạo baseline local trước.');
  });
  const report = compareMetadata(
    parseMetadata(reference),
    parseMetadata(await readFile(input, 'utf8')),
  );
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== 'PASS') process.exitCode = 1;
} catch (error) {
  // Do not echo file contents/paths or raw JSON parser excerpts to logs.
  console.error(
    error.code ? 'Không đọc được file metadata local; kiểm tra đường dẫn.' : error.message,
  );
  process.exitCode = 1;
}
