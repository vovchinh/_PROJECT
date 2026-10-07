import { readSheet } from 'read-excel-file/browser';

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 5000;
const MAX_COLUMNS = 50;
const MAX_AMOUNT = 9000000000000;

const textCell = (value) => {
  if (value == null) return '';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  return String(value).trim();
};

const plainCell = (value) => {
  if (value == null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return String(value);
};

const normalizedHeader = (value) =>
  textCell(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const HEADER_HINTS = {
  date: ['ngay giao dich', 'ngay hach toan', 'ngay', 'transaction date', 'value date', 'date'],
  description: [
    'noi dung giao dich',
    'noi dung',
    'dien giai',
    'mo ta',
    'description',
    'narrative',
    'details',
  ],
  debit: ['so tien ghi no', 'ghi no', 'so tien chi', 'debit', 'withdrawal', 'rut tien'],
  credit: ['so tien ghi co', 'ghi co', 'so tien thu', 'credit', 'deposit', 'nap tien'],
  amount: ['so tien giao dich', 'so tien', 'amount', 'transaction amount'],
  reference: [
    'ma giao dich',
    'ma tham chieu',
    'so tham chieu',
    'transaction id',
    'reference',
    'ref',
  ],
};

export function suggestBankStatementMapping(headers) {
  const normalized = headers.map(normalizedHeader);
  const mapping = {};
  for (const [field, hints] of Object.entries(HEADER_HINTS)) {
    const matching = normalized.flatMap((header, index) => (hints.includes(header) ? [index] : []));
    if (matching.length === 1) mapping[field] = matching[0];
  }
  if (mapping.debit != null && mapping.credit != null) delete mapping.amount;
  return mapping;
}

const calendarDate = (year, month, day) => {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  ) {
    throw new Error('Ngày không tồn tại trong lịch.');
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

export function parseBankDate(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error('Ngày Excel không hợp lệ.');
    return calendarDate(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  }
  const s = textCell(value);
  let match =
    /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d{1,6})?)?Z?)?$/.exec(s);
  if (
    match &&
    match[4] != null &&
    (Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6] || 0) > 59)
  ) {
    throw new Error('Giờ giao dịch không hợp lệ.');
  }
  if (match) return calendarDate(Number(match[1]), Number(match[2]), Number(match[3]));
  match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?: (\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (
    match &&
    match[4] != null &&
    (Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6] || 0) > 59)
  ) {
    throw new Error('Giờ giao dịch không hợp lệ.');
  }
  if (match) return calendarDate(Number(match[3]), Number(match[2]), Number(match[1]));
  throw new Error('Ngày phải là ô ngày Excel, dd/mm/yyyy hoặc yyyy-mm-dd.');
}

export function parseBankAmount(value, { allowNegative = false, allowZero = false } = {}) {
  if (value == null || textCell(value) === '') {
    if (allowZero) return 0;
    throw new Error('Thiếu số tiền.');
  }
  if (typeof value === 'number') {
    if (
      !Number.isSafeInteger(value) ||
      Math.abs(value) > MAX_AMOUNT ||
      (value < 0 && !allowNegative) ||
      (!allowZero && value === 0)
    ) {
      throw new Error('Số tiền VND phải là số nguyên hợp lệ.');
    }
    return value;
  }
  let raw = textCell(value)
    .replace(/[\s\u00a0\u202f]/g, '')
    .replace(/(?:vnd|₫|đ)$/i, '');
  const negative = raw.startsWith('-') || /^\(.*\)$/.test(raw);
  if (raw.startsWith('-') || raw.startsWith('+')) raw = raw.slice(1);
  if (raw.startsWith('(') && raw.endsWith(')')) raw = raw.slice(1, -1);
  let digits;
  if (/^\d+$/.test(raw)) digits = raw;
  else if (/^\d{1,3}(?:\.\d{3})+$/.test(raw) || /^\d{1,3}(?:,\d{3})+$/.test(raw))
    digits = raw.replace(/[.,]/g, '');
  if (!digits && /[.,]00$/.test(raw)) {
    const decimalSeparator = raw.at(-3);
    const whole = raw.slice(0, -3);
    if (/^\d+$/.test(whole)) digits = whole;
    else if (decimalSeparator === ',' && /^\d{1,3}(?:\.\d{3})+$/.test(whole))
      digits = whole.replace(/\./g, '');
    else if (decimalSeparator === '.' && /^\d{1,3}(?:,\d{3})+$/.test(whole))
      digits = whole.replace(/,/g, '');
  }
  if (!digits) throw new Error('Số tiền VND có định dạng không hợp lệ hoặc có phần lẻ.');
  const amount = Number(digits) * (negative ? -1 : 1);
  if (
    !Number.isSafeInteger(amount) ||
    Math.abs(amount) > MAX_AMOUNT ||
    (amount < 0 && !allowNegative) ||
    (!allowZero && amount === 0)
  ) {
    throw new Error('Số tiền VND phải là số nguyên hợp lệ.');
  }
  return amount;
}

function checkedMapping(mapping, width) {
  if (!mapping || typeof mapping !== 'object') throw new Error('Cần ánh xạ các cột sao kê.');
  const amountMode = mapping.amount != null;
  if (amountMode === (mapping.debit != null || mapping.credit != null)) {
    throw new Error('Chọn một cột số tiền có dấu hoặc cả hai cột ghi nợ và ghi có.');
  }
  const required = amountMode
    ? ['date', 'description', 'amount']
    : ['date', 'description', 'debit', 'credit'];
  for (const key of required) if (mapping[key] == null) throw new Error(`Thiếu cột ${key}.`);
  const indexes = Object.entries(mapping)
    .filter(([, value]) => value != null)
    .map(([, value]) => value);
  if (
    indexes.some((index) => !Number.isInteger(index) || index < 0 || index >= width) ||
    new Set(indexes).size !== indexes.length
  ) {
    throw new Error('Cột ánh xạ bị trùng hoặc nằm ngoài bảng Excel.');
  }
}

/** Read an XLSX into a bounded, immutable preview. No database/ledger calls occur here. */
export async function readBankStatementFile(file, { sheet = 1, headerRow = 1 } = {}) {
  if (!file || typeof file.arrayBuffer !== 'function' || !/\.xlsx$/i.test(file.name || '')) {
    throw new Error('Chỉ hỗ trợ tệp sao kê .xlsx.');
  }
  if (file.name.length > 255) throw new Error('Tên tệp Excel vượt quá 255 ký tự.');
  if (!Number.isInteger(file.size) || file.size < 1 || file.size > MAX_FILE_BYTES) {
    throw new Error('Tệp Excel phải có dữ liệu và không vượt quá 5 MB.');
  }
  if (!globalThis.crypto?.subtle)
    throw new Error('Trình duyệt cần Web Crypto để nhận dạng tệp sao kê.');
  if (!Number.isInteger(headerRow) || headerRow < 1 || headerRow > 50)
    throw new Error('Dòng tiêu đề phải từ 1 đến 50.');
  if (!(Number.isInteger(sheet) && sheet >= 1) && !(typeof sheet === 'string' && sheet.trim())) {
    throw new Error('Tên hoặc số sheet không hợp lệ.');
  }
  const buffer = await file.arrayBuffer();
  const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer);
  const file_sha256 = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  let data;
  try {
    data = await readSheet(buffer, sheet);
  } catch (error) {
    throw new Error(`Không đọc được tệp Excel: ${error.message}`);
  }
  if (!Array.isArray(data) || data.length <= headerRow)
    throw new Error('Sheet không có dòng dữ liệu sau tiêu đề.');
  if (data.length - headerRow > MAX_ROWS) throw new Error('Sao kê vượt quá 5.000 dòng.');
  const width = Math.max(0, ...data.map((row) => row.length));
  if (width > MAX_COLUMNS) throw new Error('Sao kê vượt quá 50 cột.');
  const headers = Array.from(
    { length: width },
    (_, index) => textCell(data[headerRow - 1]?.[index]) || `Cột ${index + 1}`,
  );
  const raw_rows = data
    .slice(headerRow)
    .flatMap((row, offset) =>
      row.every((cell) => textCell(cell) === '')
        ? []
        : [{ row_number: headerRow + offset + 1, raw_row: row.map(plainCell) }],
    );
  if (raw_rows.length === 0) throw new Error('Sheet không có giao dịch để xem trước.');
  return {
    filename: file.name,
    file_sha256,
    sheet,
    header_row: headerRow,
    headers,
    raw_rows,
    suggested_mapping: suggestBankStatementMapping(headers),
  };
}

/** Normalize only for review; every row remains visible even when invalid or possibly duplicated. */
export function normalizeBankStatementRows(preview, mapping) {
  if (!Array.isArray(preview?.headers) || !Array.isArray(preview?.raw_rows))
    throw new Error('Dữ liệu xem trước không hợp lệ.');
  checkedMapping(mapping, preview.headers.length);
  if (preview.raw_rows.length > MAX_ROWS) throw new Error('Sao kê vượt quá 5.000 dòng.');
  const seen = new Map();
  const rows = preview.raw_rows.map(({ row_number, raw_row }) => {
    const errors = [];
    const warnings = [];
    let date = null;
    let direction = null;
    let amount = null;
    const description = textCell(raw_row[mapping.description]);
    const external_ref = mapping.reference == null ? '' : textCell(raw_row[mapping.reference]);
    try {
      date = parseBankDate(raw_row[mapping.date]);
    } catch (error) {
      errors.push(error.message);
    }
    if (!description || description.length > 500) errors.push('Nội dung phải từ 1 đến 500 ký tự.');
    if (external_ref.length > 200) errors.push('Mã tham chiếu vượt quá 200 ký tự.');
    try {
      if (mapping.amount != null) {
        const signed = parseBankAmount(raw_row[mapping.amount], { allowNegative: true });
        direction = signed > 0 ? 'in' : 'out';
        amount = Math.abs(signed);
      } else {
        const debit = parseBankAmount(raw_row[mapping.debit], { allowZero: true });
        const credit = parseBankAmount(raw_row[mapping.credit], { allowZero: true });
        if (debit > 0 === credit > 0)
          throw new Error('Mỗi dòng phải có đúng một bên ghi nợ hoặc ghi có.');
        direction = debit > 0 ? 'out' : 'in';
        amount = debit || credit;
      }
    } catch (error) {
      errors.push(error.message);
    }
    let fingerprint = null;
    let duplicate_of_row = null;
    if (errors.length === 0) {
      fingerprint = JSON.stringify([
        date,
        direction,
        amount,
        description.toLocaleLowerCase('vi').replace(/\s+/g, ' '),
        external_ref.toLocaleLowerCase('vi'),
      ]);
      if (seen.has(fingerprint)) {
        duplicate_of_row = seen.get(fingerprint);
        warnings.push(
          `Có thể trùng dòng ${duplicate_of_row} trong cùng tệp; cần đối chiếu trước khi xác nhận.`,
        );
      } else seen.set(fingerprint, row_number);
    }
    return {
      row_number,
      raw_row,
      date,
      direction,
      amount,
      description,
      external_ref,
      fingerprint,
      duplicate_of_row,
      errors,
      warnings,
      valid: errors.length === 0,
    };
  });
  return {
    rows,
    valid_count: rows.filter((row) => row.valid).length,
    invalid_count: rows.filter((row) => !row.valid).length,
    duplicate_count: rows.filter((row) => row.duplicate_of_row != null).length,
  };
}
