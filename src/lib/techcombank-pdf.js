import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { parseBankAmount, parseBankDate } from './bank-statement-file.js';

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_PAGES = 50;
const MAX_ITEMS_PER_PAGE = 10000;
const MAX_ITEMS = 100000;
const MAX_CHARS = 500000;
const MAX_ROWS = 5000;
const DATE_RE = /^\d{1,2}\/\d{1,2}\/\d{4}$/;
const MONEY_COLUMNS = { debit: [540, 625], credit: [635, 715] };
const BALANCE_COLUMN = [775, 810];

const fold = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

// The adapter recognizes only the verified first grid of the supplied sample.
// Labels AND column geometry are required; a date-shaped token alone is never
// enough to classify a PDF as a bank statement.
const HEADER = [
  { band: [12, 50], test: (s) => s.includes('ngay giao dich') },
  { band: [330, 380], test: (s) => s.includes('dien giai') },
  { band: [535, 590], test: (s) => s.includes('no tktt') },
  { band: [630, 690], test: (s) => s.includes('co tktt') },
  { band: [725, 785], test: (s) => s.includes('so du') },
];
const CCTG_HEADER = [
  { band: [30, 55], test: (s) => s.includes('ngay giao dich') },
  { band: [380, 415], test: (s) => s === 'dien giai' },
  { band: [485, 525], test: (s) => s === 'so but toan' },
  { band: [600, 640], test: (s) => s === 'bien dong tktt' },
  { band: [710, 755], test: (s) => s.includes('gia tri cctg phan bo') },
];

function boundedItems(page) {
  if (
    !page ||
    page.rotation !== 90 ||
    !Array.isArray(page.items) ||
    page.items.length > MAX_ITEMS_PER_PAGE
  ) {
    throw new Error('PDF có trang hoặc lớp chữ ngoài giới hạn hỗ trợ.');
  }
  return page.items
    .filter((item) => typeof item.str === 'string' && item.str.trim())
    .map((item) => {
      if (
        item.str.length > 4000 ||
        !Array.isArray(item.transform) ||
        item.transform.length < 6 ||
        !item.transform.every(Number.isFinite)
      ) {
        throw new Error('Lớp chữ PDF không hợp lệ hoặc quá dài.');
      }
      return { text: item.str.trim(), x: item.transform[4], y: item.transform[5] };
    });
}

function isLayoutAHeader(items) {
  const matches = HEADER.map(({ band, test }) =>
    items.find(
      (item) =>
        item.x >= 290 &&
        item.x <= 345 &&
        item.y >= band[0] &&
        item.y <= band[1] &&
        test(fold(item.text)),
    ),
  );
  return matches.every(Boolean) && matches.every((item) => Math.abs(item.x - matches[0].x) <= 16);
}

function isCctgHeader(items) {
  return CCTG_HEADER.every(({ band, test }) => items.some((item) =>
    item.x >= 220 && item.x <= 240 && item.y >= band[0] && item.y <= band[1] && test(fold(item.text))));
}

function dateAnchors(items, band) {
  return items
    .filter((item) => item.y >= band[0] && item.y <= band[1] && DATE_RE.test(item.text))
    .sort((a, b) => a.x - b.x);
}

// Only count the verified allocation grid. We deliberately do not read its
// amounts or narratives: CCTG is outside the Thu Chi import scope.
function cctgRowCount(items) {
  const anchors = dateAnchors(items, [80, 90]);
  if (!anchors.length || anchors.some((anchor, index) =>
    index > 0 && Math.abs(anchor.x - anchors[index - 1].x - 42) > 3)) return 0;
  const allDates = dateAnchors(items, [65, 98]);
  if (allDates.length !== anchors.length) return 0;
  const oneCell = (anchor, minY, maxY) => {
    const cells = items.filter((item) => Math.abs(item.x - anchor.x) <= 13 &&
      item.y >= minY && item.y <= maxY);
    return cells.length === 1 && /\d/.test(cells[0].text) &&
      /^[\s()+\-,.\d]+$/.test(cells[0].text);
  };
  return anchors.every((anchor) => oneCell(anchor, 650, 705) &&
    oneCell(anchor, 770, 815)) ? anchors.length : 0;
}

function safeDescription(items) {
  const source = items
    .sort((a, b) => a.x - b.x || a.y - b.y)
    .map((item) => item.text)
    .join(' ')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Transaction narratives sometimes embed a full account number or phone.
  // Preserve the business narrative while suppressing long numeric identifiers.
  const redacted = source
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[email đã ẩn]')
    .replace(/(?<!\d)(?:\d[\s.-]?){8,}\d(?!\d)/g, '[số đã ẩn]');
  return redacted.slice(0, 500);
}

function moneyCell(items, band) {
  const cells = items.filter((item) => item.y >= band[0] && item.y <= band[1]);
  if (cells.length === 0) return 0;
  if (cells.length !== 1 || cells[0].text.length > 50) throw new Error('Cột tiền không rõ ràng.');
  return parseBankAmount(cells[0].text, { allowZero: true });
}

function transientBalance(items, anchor) {
  const cells = items.filter((item) => Math.abs(item.x - anchor.x) <= 13
    && item.y >= BALANCE_COLUMN[0] && item.y <= BALANCE_COLUMN[1]);
  if (cells.length !== 1 || cells[0].text.length > 50)
    throw new Error('Ambiguous running balance');
  return BigInt(parseBankAmount(cells[0].text, { allowZero: true, allowNegative: true }));
}

function parseCandidate(items, anchor, sourcePage, sourceRow, rowNumber) {
  const cells = items.filter((item) => Math.abs(item.x - anchor.x) <= 13);
  const errors = [];
  let date = null;
  let amount = null;
  let direction = null;
  try {
    date = parseBankDate(anchor.text);
  } catch {
    errors.push('Ngày giao dịch không hợp lệ.');
  }
  const narrative = cells.filter((item) => item.y >= 280 && item.y <= 390);
  const description = safeDescription(narrative);
  if (narrative.length === 0 || !description) errors.push('Thiếu nội dung giao dịch.');
  if (narrative.reduce((sum, item) => sum + item.text.length, 0) > 500)
    errors.push('Nội dung giao dịch vượt quá 500 ký tự.');
  try {
    const debit = moneyCell(cells, MONEY_COLUMNS.debit);
    const credit = moneyCell(cells, MONEY_COLUMNS.credit);
    if (debit > 0 === credit > 0) throw new Error('ambiguous movement');
    direction = debit > 0 ? 'out' : 'in';
    amount = debit || credit;
  } catch {
    errors.push('Không xác định được một bên ghi nợ hoặc ghi có.');
  }
  return {
    row_number: rowNumber,
    source_page: sourcePage,
    source_row: sourceRow,
    date,
    direction,
    amount,
    description,
    external_ref: '',
    errors,
    warnings: [],
    duplicate_of_row: null,
    valid: errors.length === 0,
  };
}

function unsupportedSection(sections, page, count, reason) {
  const last = sections.at(-1);
  if (last && last.end_page === page - 1 && last.reason === reason) {
    last.end_page = page;
    last.candidate_count += count;
  } else sections.push({ start_page: page, end_page: page, candidate_count: count, reason });
}

/**
 * Parse PDF.js text items in memory. This is deliberately restricted to the
 * verified rotated Techcombank grid A. The identified CCTG grid is ignored;
 * all other sections remain unsupported;
 * neither raw page text nor running balances enter the return value.
 */
export function parseTechcombankTextPages(pages) {
  if (!Array.isArray(pages) || pages.length < 1 || pages.length > MAX_PAGES)
    throw new Error('PDF phải có từ 1 đến 50 trang.');
  let itemCount = 0;
  let charCount = 0;
  let layoutA = false;
  let unsupported = false;
  let cctgMode = false;
  const rows = [];
  const unsupported_sections = [];
  const ignored_sections = [];
  const seen = new Map();
  let previousBalance = null;
  for (let index = 0; index < pages.length; index += 1) {
    const pageNumber = index + 1;
    let items;
    try {
      items = boundedItems(pages[index]);
    } catch {
      unsupported = true;
      unsupportedSection(unsupported_sections, pageNumber, 0, 'INVALID_TEXT_LAYER');
      continue;
    }
    itemCount += items.length;
    charCount += items.reduce((sum, item) => sum + item.text.length, 0);
    if (itemCount > MAX_ITEMS || charCount > MAX_CHARS)
      throw new Error('Lớp chữ PDF vượt giới hạn an toàn.');
    if (index === 0) layoutA = isLayoutAHeader(items);
    const anchors = dateAnchors(items, [72, 79]);
    const otherAnchors = dateAnchors(items, [65, 98]);
    if (isCctgHeader(items) || cctgMode) {
      const ignored = cctgRowCount(items);
      if (!unsupported && ignored > 0) {
        cctgMode = true;
        unsupportedSection(ignored_sections, pageNumber, ignored, 'CCTG_EXCLUDED');
      } else {
        unsupported = true;
        unsupportedSection(unsupported_sections, pageNumber, otherAnchors.length,
          'UNSUPPORTED_AFTER_CCTG');
      }
      continue;
    }
    const pitchOk = anchors.every(
      (anchor, n) => n === 0 || Math.abs(anchor.x - anchors[n - 1].x - 30) <= 3,
    );
    // Once a different section starts, never resume automatic parsing later.
    if (
      unsupported ||
      !layoutA ||
      anchors.length === 0 ||
      !pitchOk ||
      otherAnchors.length !== anchors.length
    ) {
      unsupported = true;
      unsupportedSection(
        unsupported_sections,
        pageNumber,
        otherAnchors.length,
        !items.length ? 'NO_TEXT_LAYER' : 'UNSUPPORTED_LAYOUT',
      );
      continue;
    }
    for (let rowIndex = 0; rowIndex < anchors.length; rowIndex += 1) {
      if (rows.length >= MAX_ROWS) throw new Error('Sao kê vượt quá 5.000 dòng.');
      const row = parseCandidate(
        items,
        anchors[rowIndex],
        pageNumber,
        rowIndex + 1,
        rows.length + 1,
      );
      // The source's running balance is used only transiently to detect a
      // shifted debit/credit column. It never enters a row, warning or payload.
      let balance = null;
      try {
        balance = transientBalance(items, anchors[rowIndex]);
      } catch {
        row.errors.push('Không đối chiếu được số dư dòng này.');
        row.valid = false;
      }
      if (balance !== null && previousBalance !== null && row.amount !== null && row.direction) {
        const signedAmount = BigInt(row.amount) * (row.direction === 'in' ? 1n : -1n);
        if (balance - previousBalance !== signedAmount) {
          row.errors.push('Biến động tiền không khớp số dư dòng trước.');
          row.valid = false;
        }
      }
      previousBalance = balance;
      if (row.valid) {
        const key = JSON.stringify([
          row.date,
          row.direction,
          row.amount,
          fold(row.description),
          row.external_ref,
        ]);
        if (seen.has(key)) {
          row.duplicate_of_row = seen.get(key);
          row.warnings.push(`Có thể trùng dòng ${row.duplicate_of_row}; cần đối chiếu.`);
        } else seen.set(key, row.row_number);
      }
      rows.push(row);
    }
  }
  const valid_count = rows.filter((row) => row.valid).length;
  const invalid_count = rows.length - valid_count;
  const duplicate_count = rows.filter((row) => row.duplicate_of_row != null).length;
  // Duplicate hints are reviewable in non-ledger staging; they are not parsing
  // failures. The existing confirm RPC still requires an explicit reason.
  const parse_ready = rows.length > 0 && invalid_count === 0 && unsupported_sections.length === 0;
  return {
    kind: 'pdf',
    rows,
    valid_count,
    invalid_count,
    duplicate_count,
    unsupported_sections,
    ignored_sections,
    ignored_candidate_count: ignored_sections.reduce(
      (sum, section) => sum + section.candidate_count,
      0,
    ),
    unsupported_candidate_count: unsupported_sections.reduce(
      (sum, section) => sum + section.candidate_count,
      0,
    ),
    parse_ready,
    // The verified table geometry does not prove the currency. The VND-only
    // ledger requires an explicit human confirmation in the review flow.
    currency_verified_vnd: false,
    needs_currency_confirmation: true,
    can_stage: false,
  };
}

/** Read the selected PDF locally. The original bytes and page text never leave this function. */
export async function readTechcombankPdf(file) {
  if (!file || typeof file.arrayBuffer !== 'function' || !/\.pdf$/i.test(file.name || ''))
    throw new Error('Chỉ hỗ trợ tệp sao kê .pdf.');
  if (!Number.isInteger(file.size) || file.size < 1 || file.size > MAX_BYTES)
    throw new Error('PDF phải có dữ liệu và không vượt quá 5 MB.');
  if (!globalThis.crypto?.subtle) throw new Error('Trình duyệt cần Web Crypto để kiểm tra tệp.');
  const buffer = await file.arrayBuffer();
  if (
    !(buffer instanceof ArrayBuffer) ||
    buffer.byteLength !== file.size ||
    String.fromCharCode(...new Uint8Array(buffer, 0, 5)) !== '%PDF-'
  )
    throw new Error('Tệp PDF không hợp lệ.');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer);
  const file_sha256 = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  let task;
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    if (typeof window !== 'undefined') pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
    task = pdfjs.getDocument({
      data: new Uint8Array(buffer),
      disableFontFace: true,
      useSystemFonts: false,
      stopAtErrors: true,
      isEvalSupported: false,
      disableAutoFetch: true,
      disableStream: true,
      verbosityLevel: 0,
    });
    const pdf = await task.promise;
    if (pdf.numPages < 1 || pdf.numPages > MAX_PAGES)
      throw new Error('PDF phải có từ 1 đến 50 trang.');
    const pages = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push({ rotation: page.rotate, items: content.items });
      page.cleanup();
    }
    return { ...parseTechcombankTextPages(pages), file_sha256 };
  } catch {
    throw new Error(
      'Không đọc được PDF hoặc bố cục sao kê không hợp lệ. Không có dữ liệu nào được lưu.',
    );
  } finally {
    if (task) await task.destroy().catch(() => {});
  }
}
