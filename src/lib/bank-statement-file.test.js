import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import {
  normalizeBankStatementRows,
  parseBankAmount,
  parseBankDate,
  readBankStatementFile,
  suggestBankStatementMapping,
} from './bank-statement-file.js';

function workbook(rows) {
  const cell = (value, column, row) =>
    `<c r="${column}${row}" t="inlineStr"><is><t>${String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</t></is></c>`;
  const data = rows
    .map(
      (values, index) =>
        `<row r="${index + 1}">${values.map((value, column) => cell(value, String.fromCharCode(65 + column), index + 1)).join('')}</row>`,
    )
    .join('');
  const files = {
    '[Content_Types].xml':
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels':
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml':
      '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sao kê" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${data}</sheetData></worksheet>`,
  };
  const bytes = zipSync(
    Object.fromEntries(Object.entries(files).map(([path, xml]) => [path, strToU8(xml)])),
  );
  const blob = new Blob([bytes], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  Object.defineProperty(blob, 'name', { value: 'sao-ke.xlsx' });
  return blob;
}

describe('bank statement Excel preview', () => {
  it('reads a real XLSX file, hashes source bytes and preserves row numbers', async () => {
    const file = workbook([
      ['Ngày', 'Nội dung', 'Ghi nợ', 'Ghi có', 'Mã giao dịch'],
      ['18/08/2026', 'Mua bao bì', '1.000.000', '', 'TX-01'],
      ['19/08/2026', 'Khách chuyển khoản', '', '2,000,000', 'TX-02'],
    ]);
    const preview = await readBankStatementFile(file);
    expect(preview.file_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(preview.suggested_mapping).toEqual({
      date: 0,
      description: 1,
      debit: 2,
      credit: 3,
      reference: 4,
    });
    expect(preview.raw_rows.map((row) => row.row_number)).toEqual([2, 3]);
    const normalized = normalizeBankStatementRows(preview, preview.suggested_mapping);
    expect(normalized.valid_count).toBe(2);
    expect(normalized.rows.map(({ date, direction, amount }) => [date, direction, amount])).toEqual(
      [
        ['2026-08-18', 'out', 1000000],
        ['2026-08-19', 'in', 2000000],
      ],
    );
  });

  it('parses genuine Excel dates without local timezone drift and rejects impossible dates', () => {
    expect(parseBankDate(new Date('2026-08-18T00:00:00.000Z'))).toBe('2026-08-18');
    expect(parseBankDate('18/08/2026')).toBe('2026-08-18');
    expect(parseBankDate('18/08/2026 23:45')).toBe('2026-08-18');
    expect(() => parseBankDate('29/02/2026')).toThrow();
    expect(() => parseBankDate('18/08/2026 25:00')).toThrow();
    expect(() => parseBankDate(46252)).toThrow();
  });

  it('requires exact integer VND and rejects malformed or fractional values', () => {
    expect(parseBankAmount('1.234.567')).toBe(1234567);
    expect(parseBankAmount('1,234,567.00')).toBe(1234567);
    expect(parseBankAmount('-1 000 000', { allowNegative: true })).toBe(-1000000);
    for (const value of [
      '1.23',
      '1,234.50',
      '1.234,50',
      '1,23,456',
      '1.000.00',
      1.5,
      9000000000001,
    ]) {
      expect(() => parseBankAmount(value)).toThrow();
    }
  });

  it('flags duplicate candidates but retains every valid row for review', () => {
    const preview = {
      headers: ['Date', 'Description', 'Amount', 'Reference'],
      raw_rows: [
        { row_number: 2, raw_row: ['2026-08-18', 'KHACH A', '-100000', 'abc'] },
        { row_number: 3, raw_row: ['2026-08-18', 'Khach A', '-100000', 'ABC'] },
        { row_number: 4, raw_row: ['2026-02-30', 'Khach B', '+200000', 'xyz'] },
      ],
    };
    const result = normalizeBankStatementRows(preview, {
      date: 0,
      description: 1,
      amount: 2,
      reference: 3,
    });
    expect(result).toMatchObject({ valid_count: 2, invalid_count: 1, duplicate_count: 1 });
    expect(result.rows[1].duplicate_of_row).toBe(2);
    expect(result.rows[1].warnings).toHaveLength(1);
    expect(result.rows[2].errors).toContain('Ngày không tồn tại trong lịch.');
  });

  it('rejects unsafe mappings and invalid debit/credit combinations', () => {
    const preview = {
      headers: ['Ngày', 'Nội dung', 'Ghi nợ', 'Ghi có'],
      raw_rows: [{ row_number: 2, raw_row: ['18/08/2026', 'Test', '10', '20'] }],
    };
    expect(suggestBankStatementMapping(preview.headers)).toEqual({
      date: 0,
      description: 1,
      debit: 2,
      credit: 3,
    });
    expect(() =>
      normalizeBankStatementRows(preview, {
        date: 0,
        description: 1,
        amount: 2,
        debit: 2,
        credit: 3,
      }),
    ).toThrow();
    const result = normalizeBankStatementRows(preview, {
      date: 0,
      description: 1,
      debit: 2,
      credit: 3,
    });
    expect(result.invalid_count).toBe(1);
    expect(result.rows[0].errors).toContain('Mỗi dòng phải có đúng một bên ghi nợ hoặc ghi có.');
  });

  it('bounds file size, extension and source row count before staging', async () => {
    await expect(
      readBankStatementFile({
        name: 'old.xls',
        size: 1,
        arrayBuffer: async () => new ArrayBuffer(1),
      }),
    ).rejects.toThrow('.xlsx');
    await expect(
      readBankStatementFile({
        name: 'huge.xlsx',
        size: 6 * 1024 * 1024,
        arrayBuffer: async () => new ArrayBuffer(1),
      }),
    ).rejects.toThrow('5 MB');
    const preview = {
      headers: ['a'],
      raw_rows: Array.from({ length: 5001 }, (_, n) => ({ row_number: n + 2, raw_row: ['x'] })),
    };
    expect(() =>
      normalizeBankStatementRows(preview, { date: 0, description: 0, amount: 0 }),
    ).toThrow();
  });
});
