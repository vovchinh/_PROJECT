import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { parseTechcombankTextPages, readTechcombankPdf } from './techcombank-pdf.js';

const privateSample = new URL('../../docs/SaoKeTK_19072026_16092026.pdf', import.meta.url);

const item = (str, x, y) => ({ str, transform: [0, 6, -6, 0, x, y] });
const page = (items, rotation = 90) => ({ rotation, items });
const header = [
  item('Ngày giao dịch', 316, 26),
  item('Diễn giải', 316, 353),
  item('Nợ TKTT', 316, 564),
  item('Có TKTT', 316, 659),
  item('Số dư', 316, 755),
];
const row = (x, date, description, side, money, extra = [], balance = '9,000,000') => [
  item(date, x, 75),
  item(description, x, 320),
  item(money, x, side === 'out' ? 600 : 685),
  item(balance, x, 789),
  ...extra,
];

describe('Techcombank PDF local-only layout A parser', () => {
  it('extracts only verified transaction cells, preserves source positions and joins multiline content', () => {
    const pages = [
      page([
        ...header,
        item('Account holder: PRIVATE PERSON', 110, 180),
        item('Full account 12345678901234', 120, 225),
        ...row(377, '18/08/2026', 'Mua bao bì', 'out', '1,000,000', [
          item('cho cửa hàng', 379, 340),
        ]),
        ...row(407, '19/08/2026', 'Khách chuyển khoản', 'in', '2,000,000', [], '11,000,000'),
      ]),
    ];
    const result = parseTechcombankTextPages(pages);
    expect(result).toMatchObject({
      kind: 'pdf',
      valid_count: 2,
      invalid_count: 0,
      duplicate_count: 0,
      unsupported_sections: [],
      parse_ready: true,
      currency_verified_vnd: false,
      needs_currency_confirmation: true,
      can_stage: false,
    });
    expect(
      result.rows.map(({ row_number, source_page, source_row, date, direction, amount }) => [
        row_number,
        source_page,
        source_row,
        date,
        direction,
        amount,
      ]),
    ).toEqual([
      [1, 1, 1, '2026-08-18', 'out', 1000000],
      [2, 1, 2, '2026-08-19', 'in', 2000000],
    ]);
    expect(result.rows[0].description).toBe('Mua bao bì cho cửa hàng');
    expect(JSON.stringify(result)).not.toMatch(
      /PRIVATE PERSON|12345678901234|9,000,000|Account holder/,
    );
    expect(result.rows[0].external_ref).toBe('');
  });

  it('masks long numeric identifiers inside an otherwise allowed transaction narrative', () => {
    const result = parseTechcombankTextPages([
      page([
        ...header,
        ...row(
          377,
          '18/08/2026',
          'Thanh toán tới 12345678901234 user@example.com',
          'out',
          '100,000',
        ),
      ]),
    ]);
    expect(result.rows[0].description).toContain('[số đã ẩn]');
    expect(JSON.stringify(result)).not.toContain('12345678901234');
    expect(JSON.stringify(result)).not.toContain('user@example.com');
  });

  it('carries verified layout over page breaks and quarantines a later incompatible grid', () => {
    const result = parseTechcombankTextPages([
      page([...header, ...row(377, '18/08/2026', 'Phí dịch vụ', 'out', '100,000')]),
      page([...row(36, '19/08/2026', 'Hoàn tiền', 'in', '200,000', [], '9,200,000')]),
      page([
        item('Ngày', 229, 41),
        item('Diễn giải', 229, 396),
        item('20/08/2026', 262, 84),
        item('300,000', 262, 676),
      ]),
      page([item('21/08/2026', 37, 84), item('400,000', 37, 682)]),
    ]);
    expect(result.rows).toHaveLength(2);
    expect(result.unsupported_sections).toEqual([
      {
        start_page: 3,
        end_page: 4,
        candidate_count: 2,
        reason: 'UNSUPPORTED_LAYOUT',
      },
    ]);
    expect(result.can_stage).toBe(false);
  });

  it('excludes only verified CCTG pages without importing any CCTG values', () => {
    const cctgHeader = [
      item('Ngày giao dịch (1)', 229, 41), item('Diễn giải', 229, 396),
      item('Số bút toán', 229, 503), item('Biến động TKTT', 229, 621),
      item('Giá trị CCTG phân bổ (2)', 229, 731),
    ];
    const result = parseTechcombankTextPages([
      page([...header, ...row(377, '18/08/2026', 'Phí dịch vụ', 'out', '100,000')]),
      page([...cctgHeader, item('19/08/2026', 262, 84), item('(200,000)', 262, 676), item('200,000', 262, 792)]),
      page([item('20/08/2026', 37, 84), item('300,000', 37, 680), item('(300,000)', 37, 798)]),
    ]);
    expect(result.rows).toHaveLength(1);
    expect(result.unsupported_sections).toEqual([]);
    expect(result.ignored_sections).toEqual([{ start_page: 2, end_page: 3, candidate_count: 2, reason: 'CCTG_EXCLUDED' }]);
    expect(result.ignored_candidate_count).toBe(2);
    expect(result.parse_ready).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/200,000|300,000/);
  });

  it('blocks an unknown page after CCTG instead of silently excluding it', () => {
    const result = parseTechcombankTextPages([
      page([...header, ...row(377, '18/08/2026', 'Phí dịch vụ', 'out', '100,000')]),
      page([
        item('Ngày giao dịch (1)', 229, 41), item('Diễn giải', 229, 396),
        item('Số bút toán', 229, 503), item('Biến động TKTT', 229, 621),
        item('Giá trị CCTG phân bổ (2)', 229, 731),
        item('19/08/2026', 262, 84), item('(200,000)', 262, 676), item('200,000', 262, 792),
      ]),
      page([item('21/08/2026', 37, 84), item('400,000', 37, 682)]),
    ]);
    expect(result.ignored_candidate_count).toBe(1);
    expect(result.unsupported_sections).toEqual([{
      start_page: 3, end_page: 3, candidate_count: 1, reason: 'UNSUPPORTED_AFTER_CCTG',
    }]);
    expect(result.parse_ready).toBe(false);
  });

  it('does not guess a movement when both sides, neither side, or malformed money appears', () => {
    const result = parseTechcombankTextPages([
      page([
        ...header,
        ...row(377, '18/08/2026', 'Hai bên', 'out', '100,000', [item('50,000', 377, 685)]),
        ...row(407, '19/08/2026', 'Thiếu tiền', 'out', ''),
        ...row(437, '20/08/2026', 'Sai định dạng', 'in', '1,25'),
      ]),
    ]);
    expect(result).toMatchObject({ valid_count: 0, invalid_count: 3, can_stage: false });
    expect(result.rows.every((r) => r.errors.length && r.amount == null)).toBe(true);
  });

  it('flags same-file duplicate candidates without dropping them', () => {
    const result = parseTechcombankTextPages([
      page([
        ...header,
        ...row(377, '18/08/2026', 'Phí dịch vụ', 'out', '100,000'),
        ...row(407, '18/08/2026', 'Phí dịch vụ', 'out', '100,000', [], '8,900,000'),
      ]),
    ]);
    expect(result).toMatchObject({
      valid_count: 2,
      duplicate_count: 1,
      parse_ready: true,
      can_stage: false,
    });
    expect(result.rows[1].duplicate_of_row).toBe(1);
  });

  it('rejects a false header, scanned page and excessive page count without exposing source text', () => {
    const falseHeader = parseTechcombankTextPages([
      page([
        item('Ngày giao dịch', 316, 26),
        ...row(377, '18/08/2026', 'Không đủ tiêu đề', 'out', '100,000'),
      ]),
    ]);
    expect(falseHeader).toMatchObject({ can_stage: false, rows: [] });
    const scanned = parseTechcombankTextPages([page([])]);
    expect(scanned.unsupported_sections[0].reason).toBe('NO_TEXT_LAYER');
    expect(() => parseTechcombankTextPages(Array.from({ length: 51 }, () => page([])))).toThrow(
      '50 trang',
    );
    expect(JSON.stringify(falseHeader)).not.toContain('Không đủ tiêu đề');
  });

  it('blocks staging when signed movements do not reconcile with transient balances', () => {
    const result = parseTechcombankTextPages([
      page([
        ...header,
        ...row(377, '18/08/2026', 'Phí dịch vụ', 'out', '100,000'),
        ...row(407, '19/08/2026', 'Phí khác', 'out', '100,000'),
      ]),
    ]);
    expect(result).toMatchObject({ valid_count: 1, invalid_count: 1, parse_ready: false });
    expect(result.rows[1].errors).toContain('Biến động tiền không khớp số dư dòng trước.');
    expect(JSON.stringify(result)).not.toContain('9,000,000');
  });

  it('checks extension, size and PDF signature before loading PDF.js', async () => {
    const fake = (name, size, bytes) => ({ name, size, arrayBuffer: async () => bytes });
    await expect(readTechcombankPdf(fake('wrong.xlsx', 5, new ArrayBuffer(5)))).rejects.toThrow(
      '.pdf',
    );
    await expect(
      readTechcombankPdf(fake('huge.pdf', 6 * 1024 * 1024, new ArrayBuffer(5))),
    ).rejects.toThrow('5 MB');
    await expect(readTechcombankPdf(fake('wrong.pdf', 5, new ArrayBuffer(5)))).rejects.toThrow(
      'không hợp lệ',
    );
  });

  it.skipIf(!existsSync(privateSample))('keeps only 83 TKTT rows from the local private sample', async () => {
    const bytes = await readFile(privateSample);
    const preview = await readTechcombankPdf({
      name: 'sample.pdf', size: bytes.length,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    });
    expect(preview.valid_count).toBe(83);
    expect(preview.invalid_count).toBe(0);
    expect(preview.ignored_candidate_count).toBe(12);
    expect(preview.unsupported_sections).toEqual([]);
    expect(preview.parse_ready).toBe(true);
    expect(preview.rows.every((row) => row.source_page <= 6)).toBe(true);
  }, 30_000);
});
