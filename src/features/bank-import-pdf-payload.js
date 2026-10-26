// Only these transaction fields may leave the local PDF parser. The trusted RPC
// repeats validation and authorization; this boundary prevents accidental PDF
// metadata, raw page text or account-holder fields from entering the request.
const MAX_AMOUNT = 9000000000000n;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const PRIVATE_NUMBER = /(?:\d[\s.-]?){8,}\d/;
const EMAIL = /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/;

function invalid() {
  throw new Error('PDF chưa đủ điều kiện an toàn để lưu. Hãy kiểm tra toàn bộ trang và dòng.');
}

function integerIn(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

function amountText(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) invalid();
    value = String(value);
  }
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) invalid();
  const amount = BigInt(value);
  if (amount > MAX_AMOUNT) invalid();
  return value;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Build the allowlisted request for the verified PDF stage RPC, never a raw PDF row. */
export function buildPdfStagePayload(preview, {
  currencyConfirmed = false, cctgConfirmed = false, accountId = null,
} = {}) {
  if (preview?.kind !== 'pdf' || preview.parse_ready !== true ||
    !(preview.currency_verified_vnd === true ||
      (preview.needs_currency_confirmation === true && currencyConfirmed === true)) ||
    !Array.isArray(preview.unsupported_sections) || preview.unsupported_sections.length ||
    !Array.isArray(preview.ignored_sections) ||
    preview.invalid_count !== 0 || !Array.isArray(preview.rows) ||
    preview.rows.length < 1 || preview.rows.length > 5000 ||
    preview.valid_count !== preview.rows.length ||
    typeof preview.file_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(preview.file_sha256) ||
    typeof accountId !== 'string' || !UUID.test(accountId)) invalid();
  let excludedCount = 0;
  for (const section of preview.ignored_sections) {
    if (section?.reason !== 'CCTG_EXCLUDED' ||
      !integerIn(section.start_page, 1, 50) ||
      !integerIn(section.end_page, section.start_page, 50) ||
      !integerIn(section.candidate_count, 1, 5000)) invalid();
    excludedCount += section.candidate_count;
  }
  if (excludedCount !== preview.ignored_candidate_count ||
    excludedCount > 5000 || (excludedCount > 0 && cctgConfirmed !== true)) invalid();
  const seen = new Set();
  const rows = preview.rows.map((row) => {
    if (!row?.valid || row.errors?.length ||
      !integerIn(row.row_number, 1, 1000000) || seen.has(row.row_number) ||
      !integerIn(row.source_page, 1, 10000) || !integerIn(row.source_row, 1, 1000000) ||
      typeof row.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.date) ||
      !['in', 'out'].includes(row.direction) ||
      typeof row.description !== 'string' || !row.description.trim() || row.description.length > 500 ||
      CONTROL.test(row.description) || PRIVATE_NUMBER.test(row.description) || EMAIL.test(row.description) ||
      (row.external_ref != null && row.external_ref !== '')) invalid();
    seen.add(row.row_number);
    return {
      row_number: row.row_number,
      source_page: row.source_page,
      source_row: row.source_row,
      transaction_date: row.date,
      direction: row.direction,
      amount: amountText(row.amount),
      description: row.description.trim(),
      // This verified layout does not expose a trustworthy transaction reference.
      external_reference: '',
    };
  });
  return {
    source_sha256: preview.file_sha256,
    currency_confirmed_vnd: true,
    account_id: accountId,
    excluded_cctg_count: excludedCount,
    excluded_cctg_confirmed: excludedCount > 0,
    rows,
  };
}
