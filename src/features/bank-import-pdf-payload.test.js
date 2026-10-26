import { describe, expect, it } from 'vitest';
import { buildPdfStagePayload } from './bank-import-pdf-payload.js';

const candidate = () => ({
  kind: 'pdf', parse_ready: true, currency_verified_vnd: false,
  needs_currency_confirmation: true, file_sha256: 'a'.repeat(64),
  valid_count: 1, invalid_count: 0, unsupported_sections: [],
  ignored_sections: [], ignored_candidate_count: 0,
  filename: 'person-account-123456789012.pdf', account_holder: 'Private Person',
  balance: '999999999', raw_page_text: 'Private statement header',
  rows: [{
    row_number: 1, source_page: 2, source_row: 3, date: '2026-09-15',
    direction: 'out', amount: 120000, description: 'Chi phí vận chuyển',
    external_ref: '', valid: true, errors: [], warnings: [],
    raw_row: 'Do not send this', full_account_number: '123456789012',
  }],
});
const opts = { currencyConfirmed: true, accountId: '11111111-1111-4111-8111-111111111111' };

describe('PDF stage payload boundary', () => {
  it('sends only allowlisted transaction data and integer VND strings', () => {
    expect(buildPdfStagePayload(candidate(), opts)).toEqual({
      source_sha256: 'a'.repeat(64), currency_confirmed_vnd: true,
      account_id: opts.accountId, excluded_cctg_count: 0, excluded_cctg_confirmed: false,
      rows: [{ row_number: 1, source_page: 2, source_row: 3,
        transaction_date: '2026-09-15', direction: 'out', amount: '120000',
        description: 'Chi phí vận chuyển', external_reference: '' }],
    });
    const sent = JSON.stringify(buildPdfStagePayload(candidate(), opts));
    expect(sent).not.toMatch(/person-account|Private Person|balance|raw_page_text|raw_row|full_account_number/);
  });

  it('blocks partial PDF imports and unreviewed candidate rows', () => {
    const unsupported = candidate();
    unsupported.unsupported_sections = [{ start_page: 7, end_page: 8, candidate_count: 12 }];
    expect(() => buildPdfStagePayload(unsupported, opts)).toThrow(/chưa đủ điều kiện/);
    const invalid = candidate();
    invalid.invalid_count = 1;
    expect(() => buildPdfStagePayload(invalid, opts)).toThrow(/chưa đủ điều kiện/);
    expect(() => buildPdfStagePayload(candidate())).toThrow(/chưa đủ điều kiện/);
    expect(() => buildPdfStagePayload(candidate(), { currencyConfirmed: true })).toThrow(/chưa đủ điều kiện/);
  });

  it('allows explicitly excluded CCTG rows but never sends their contents', () => {
    const preview = candidate();
    preview.ignored_sections = [{ start_page: 7, end_page: 8, candidate_count: 12, reason: 'CCTG_EXCLUDED', raw_text: 'PRIVATE CCTG' }];
    preview.ignored_candidate_count = 12;
    expect(() => buildPdfStagePayload(preview, opts)).toThrow(/chưa đủ điều kiện/);
    const payload = buildPdfStagePayload(preview, { ...opts, cctgConfirmed: true });
    expect(payload.excluded_cctg_count).toBe(12);
    expect(payload.excluded_cctg_confirmed).toBe(true);
    expect(JSON.stringify(payload)).not.toContain('PRIVATE CCTG');
    preview.ignored_sections[0].reason = 'UNSUPPORTED_LAYOUT';
    expect(() => buildPdfStagePayload(preview, { ...opts, cctgConfirmed: true })).toThrow(/chưa đủ điều kiện/);
  });

  it('preserves possible duplicates for review without sending parser diagnostics', () => {
    const duplicate = candidate();
    duplicate.rows[0].duplicate_of_row = 5;
    duplicate.rows[0].warnings = ['Có thể trùng dòng 5; cần đối chiếu.'];
    const sent = JSON.stringify(buildPdfStagePayload(duplicate, opts));
    expect(sent).not.toMatch(/warnings|duplicate_of_row|Có thể trùng/);
  });

  it('blocks long account-like digit runs and malformed money', () => {
    const pii = candidate();
    pii.rows[0].description = 'Chuyển khoản 123456789012';
    expect(() => buildPdfStagePayload(pii, opts)).toThrow(/chưa đủ điều kiện/);
    pii.rows[0].description = 'Chuyển khoản 1234 5678 9012';
    expect(() => buildPdfStagePayload(pii, opts)).toThrow(/chưa đủ điều kiện/);
    pii.rows[0].description = 'contact@example.test';
    expect(() => buildPdfStagePayload(pii, opts)).toThrow(/chưa đủ điều kiện/);
    pii.rows[0].description = 'Chi phí vận chuyển';
    pii.rows[0].external_ref = '123456789012';
    expect(() => buildPdfStagePayload(pii, opts)).toThrow(/chưa đủ điều kiện/);
    const amount = candidate();
    amount.rows[0].amount = 120000.5;
    expect(() => buildPdfStagePayload(amount, opts)).toThrow(/chưa đủ điều kiện/);
  });
});
