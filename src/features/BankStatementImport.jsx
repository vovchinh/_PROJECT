import { useEffect, useMemo, useState } from 'react';
import { Panel, Table, Modal, ErrorMessage, Badge } from '../components.jsx';
import { dateLabel, money } from '../lib/domain.js';
import { readBankStatementFile, normalizeBankStatementRows } from '../lib/bank-statement-file.js';
import { readTechcombankPdf } from '../lib/techcombank-pdf.js';
import { buildPdfStagePayload } from './bank-import-pdf-payload.js';

const PAGE_SIZE = 100;
const MAPPING_FIELDS = [
  ['date', 'Ngày giao dịch'], ['description', 'Nội dung'],
  ['debit', 'Tiền chi / ghi nợ'], ['credit', 'Tiền thu / ghi có'],
  ['amount', 'Số tiền có dấu (+ thu, − chi)'], ['reference', 'Mã tham chiếu'],
];
const newId = () => crypto.randomUUID();
const moneyExact = (amount) => `${new Intl.NumberFormat('vi-VN').format(amount)} ₫`;
const historyDate = (value) => value
  ? new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date(value))
  : 'Chưa rõ ngày';

export default function BankStatementImport({ data, repo, onChanged, initialBatchId, initialRowNumber }) {
  const [sourceKind, setSourceKind] = useState('xlsx');
  const [vndConfirmed, setVndConfirmed] = useState(false);
  const [cctgConfirmed, setCctgConfirmed] = useState(false);
  const [pdfAccountId, setPdfAccountId] = useState('');
  const [sheet, setSheet] = useState(1);
  const [headerRow, setHeaderRow] = useState(1);
  const [preview, setPreview] = useState(null);
  const [mapping, setMapping] = useState({});
  const [batches, setBatches] = useState([]);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [batchId, setBatchId] = useState(initialBatchId || '');
  const [page, setPage] = useState(null);
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState([]);
  const [edits, setEdits] = useState({});
  const [confirming, setConfirming] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [stageRequest, setStageRequest] = useState(null);
  const [confirmRequest, setConfirmRequest] = useState(null);
  const categories = data.expense_categories || [];
  const canStage = ['owner', 'manager', 'staff'].includes(data.role) && typeof repo.stageBankStatement === 'function';
  const canStagePdf = ['owner', 'manager'].includes(data.role) && typeof repo.stagePdfBankStatementVerified === 'function';
  const canConfirm = ['owner', 'manager'].includes(data.role) && typeof repo.confirmBankStatementRows === 'function';
  const normalized = useMemo(() => {
    if (!preview) return null;
    if (preview.kind === 'pdf') return preview;
    try { return normalizeBankStatementRows(preview, mapping); }
    catch (cause) { return { error: cause.message }; }
  }, [preview, mapping]);

  async function refreshBatches(nextOffset = historyOffset) {
    if (!repo.listBankStatementBatches) return;
    const value = await repo.listBankStatementBatches(nextOffset, 20);
    setBatches(value.rows || []);
    setHistoryTotal(value.total || 0);
  }
  useEffect(() => {
    if (!repo.listBankStatementBatches) return undefined;
    let alive = true;
    setHistoryLoading(true);
    repo.listBankStatementBatches(historyOffset, 20)
      .then((value) => { if (alive) { setBatches(value.rows || []);setHistoryTotal(value.total || 0); } })
      .catch((cause) => { if (alive) setError(cause.message); })
      .finally(() => { if (alive) setHistoryLoading(false); });
    return () => { alive = false; };
  }, [repo, historyOffset]);
  useEffect(() => {
    if (initialBatchId) setBatchId(initialBatchId);
  }, [initialBatchId]);
  useEffect(() => {
    if (!batchId || !repo.getBankStatementImport) { setPage(null); return; }
    let alive = true;
    setLoading(true);setError('');
    repo.getBankStatementImport(batchId, offset, PAGE_SIZE)
      .then((value) => { if (alive) setPage(value); })
      .catch((cause) => { if (alive) setError(cause.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [repo, batchId, offset]);

  async function readFile(file) {
    if (!file) return;
    setBusy(true);setError('');setMessage('');setPreview(null);setStageRequest(null);
    setVndConfirmed(false);setCctgConfirmed(false);setPdfAccountId('');
    try {
      if (sourceKind === 'pdf') {
        const result = await readTechcombankPdf(file);
        setPreview(result);setMapping({});
      } else {
        const result = await readBankStatementFile(file, { sheet: Number(sheet), headerRow: Number(headerRow) });
        setPreview(result);setMapping(result.suggested_mapping);
      }
    } catch (cause) {
      setError(sourceKind === 'pdf'
        ? 'Không thể đọc PDF này trên thiết bị. Hãy kiểm tra định dạng hoặc dùng Excel; file chưa được tải lên.'
        : cause.message);
    }
    finally { setBusy(false); }
  }
  function changeMapping(key, value) {
    setMapping((current) => {
      const next = { ...current };
      if (value === '') delete next[key]; else next[key] = Number(value);
      if (key === 'amount' && value !== '') { delete next.debit;delete next.credit; }
      if ((key === 'debit' || key === 'credit') && value !== '') delete next.amount;
      return next;
    });
    setStageRequest(null);
  }
  async function stage() {
    if (!normalized?.valid_count) return;
    const isPdf = preview.kind === 'pdf';
    if (isPdf && (!normalized.parse_ready || !canStagePdf || normalized.invalid_count || normalized.unsupported_sections?.length
      || !(normalized.currency_verified_vnd || (normalized.needs_currency_confirmation && vndConfirmed))
      || !pdfAccountId || (normalized.ignored_candidate_count > 0 && !cctgConfirmed))) return;
    if (!isPdf && !canStage) return;
    let payload;
    try { payload = isPdf ? buildPdfStagePayload(normalized, {
      currencyConfirmed: vndConfirmed, cctgConfirmed, accountId: pdfAccountId,
    }) : {
      source_name: preview.filename, source_sha256: preview.file_sha256,
      rows: normalized.rows.filter((row) => row.valid).map((row) => ({
        row_number: row.row_number, raw_row: row.raw_row,
        transaction_date: row.date, direction: row.direction, amount: row.amount,
        description: row.description, external_reference: row.external_ref,
      })),
    }; } catch (cause) { setError(cause.message);return; }
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(payload)));
    const payloadHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    const request = stageRequest?.payloadHash === payloadHash ? stageRequest.id : newId();
    setStageRequest({ payloadHash, id: request });
    setBusy(true);setError('');setMessage('');
    try {
      const result = isPdf
        ? await repo.stagePdfBankStatementVerified(payload, request)
        : await repo.stageBankStatement(payload, request);
      setBatchId(result.batch_id);setOffset(0);setPreview(null);setStageRequest(null);
      setSelected([]);setEdits({});setConfirmRequest(null);
      setHistoryOffset(0);await refreshBatches(0);
      setMessage(result.reused
        ? 'File này đã được lưu để đối chiếu; không tạo thêm chứng từ.'
        : 'Đã lưu dữ liệu sao kê chờ duyệt. Chưa ghi sổ tiền.');
    } catch (cause) {
      setError(cause.message?.includes('PDF_BANK_FILE_CHANGED')
        ? 'PDF này đã có trong Lịch sử nhập với tài khoản hoặc dữ liệu khác. Hãy mở lần nhập cũ để đối chiếu và sửa tài khoản trên từng dòng chờ.'
        : cause.message);
    }
    finally { setBusy(false); }
  }
  async function reloadPage() {
    const value = await repo.getBankStatementImport(batchId, offset, PAGE_SIZE);
    setPage(value);
    return value;
  }
  function draftFor(row) {
    return edits[row.id] || {
      account_id: row.account_id || '',
      category_code: categories.find((c) => c.id === row.category_id)?.code || '',
      duplicate_reason: row.duplicate_override_reason || '',
    };
  }
  function edit(row, key, value) {
    setEdits((current) => ({ ...current, [row.id]: { ...draftFor(row), [key]: value } }));
  }
  async function saveRow(row) {
    const draft = draftFor(row);
    setBusy(true);setError('');setMessage('');
    try {
      await repo.classifyBankStatementRow(row.id, draft.account_id || null,
        draft.category_code || null, draft.duplicate_reason || null);
      await reloadPage();
      setEdits((current) => { const next = { ...current };delete next[row.id];return next; });
      setMessage(`Đã lưu phân loại dòng ${row.row_number}.`);
    } catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  }
  async function confirmRows() {
    const rowIds = [...selected].sort();
    const key = `${batchId}:${rowIds.join(',')}`;
    const request = confirmRequest?.key === key ? confirmRequest.id : newId();
    setConfirmRequest({ key, id: request });
    setBusy(true);setError('');setMessage('');
    try {
      const result = await repo.confirmBankStatementRows(batchId, rowIds, request);
      await reloadPage();await onChanged();
      setSelected([]);setEdits({});setConfirming(false);setConfirmed(false);
      setMessage(`Đã ghi sổ ${result.posted_count} dòng; thử lại cùng yêu cầu không ghi trùng.`);
    } catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  }
  const rows = page?.rows || [];
  const storedPdf = page?.batch?.source_format === 'pdf';
  const canClassifyStored = storedPdf ? ['owner', 'manager'].includes(data.role) : canStage;
  const pendingRows = rows.filter((row) => row.status === 'pending');
  const selectedRows = rows.filter((row) => selected.includes(row.id));
  const selectedAmount = selectedRows.reduce((value, row) => value + Number(row.amount), 0);
  const hasUnsaved = selectedRows.some((row) => Boolean(edits[row.id]));
  const pdfPreview = preview?.kind === 'pdf';
  const pdfBlocked = pdfPreview && (!normalized?.parse_ready || normalized.invalid_count > 0 || Boolean(normalized.unsupported_sections?.length));
  const pdfCurrencyReady = pdfPreview && (normalized.currency_verified_vnd ||
    (normalized.needs_currency_confirmation && vndConfirmed));
  const pdfCctgReady = pdfPreview &&
    (!normalized.ignored_candidate_count || cctgConfirmed);
  const pdfTotals = pdfPreview ? normalized.rows.filter((row) => row.valid).reduce((totals, row) => {
    const field = row.direction === 'in' ? 'credit' : 'debit';
    totals[field] += BigInt(row.amount);
    return totals;
  }, { debit: 0n, credit: 0n }) : null;

  return <>
    <Panel title="Nhập sao kê ngân hàng" note="Xem trước trên máy, phân loại và đối chiếu trước khi ghi phiếu Thu Chi vào sổ tiền.">
      <div className="segments bank-source-tabs" role="group" aria-label="Định dạng sao kê">
        <button type="button" className={sourceKind === 'xlsx' ? 'selected' : ''} aria-pressed={sourceKind === 'xlsx'} disabled={busy}
          onClick={() => { setSourceKind('xlsx');setPreview(null);setError('');setMessage('');setStageRequest(null);setVndConfirmed(false);setCctgConfirmed(false);setPdfAccountId(''); }}>Excel (.xlsx)</button>
        <button type="button" className={sourceKind === 'pdf' ? 'selected' : ''} aria-pressed={sourceKind === 'pdf'} disabled={busy}
          onClick={() => { setSourceKind('pdf');setPreview(null);setError('');setMessage('');setStageRequest(null);setVndConfirmed(false);setCctgConfirmed(false);setPdfAccountId(''); }}>Techcombank PDF</button>
      </div>
      <div className="bank-import-controls">
        {sourceKind === 'xlsx' && <>
          <label>Số sheet <input type="number" min="1" value={sheet} onChange={(event) => setSheet(event.target.value)} /></label>
          <label>Dòng tiêu đề <input type="number" min="1" max="50" value={headerRow} onChange={(event) => setHeaderRow(event.target.value)} /></label>
        </>}
        <label>Chọn file {sourceKind === 'pdf' ? '.pdf' : '.xlsx'}
          <input key={sourceKind} type="file" accept={sourceKind === 'pdf' ? '.pdf,application/pdf' : '.xlsx'} disabled={busy}
            onChange={(event) => { readFile(event.target.files?.[0]);event.target.value = ''; }} />
        </label>
      </div>
      <p className="source-note">{sourceKind === 'pdf'
        ? 'PDF được phân tích cục bộ. File gốc không được tải lên máy chủ. Chỉ giao dịch TKTT đã kiểm tra mới chuyển sang phân loại; bảng CCTG được bỏ qua, trang lạ vẫn chặn nhập.'
        : 'File tối đa 5 MB, 5.000 dòng. Chọn đúng sheet và dòng tiêu đề trước khi mở file. Mã nguồn SHA-256 tính từ tệp trên máy.'}</p>
      <ErrorMessage error={error} />
      {message && <p className="success-message" role="status">{message}</p>}
    </Panel>

    {preview && <Panel title={pdfPreview ? 'Xem trước PDF trên máy' : `Xem trước: ${preview.filename}`}
      note={pdfPreview ? 'Chưa ghi lên Supabase hoặc sổ tiền.' : `SHA-256: ${preview.file_sha256}`}>
      {!pdfPreview && <div className="bank-mapping">
        {MAPPING_FIELDS.map(([key, label]) => <label key={key}>{label}
          <select aria-label={label} value={mapping[key] ?? ''} onChange={(event) => changeMapping(key, event.target.value)}>
            <option value="">Chưa chọn</option>
            {preview.headers.map((header, index) => <option value={index} key={index}>{header}</option>)}
          </select>
        </label>)}
      </div>}
      {normalized?.error ? <p className="source-note">{normalized.error}</p> : <>
        {pdfPreview ? <>
          <p className="source-note">Giao dịch TKTT: {normalized.rows.length} dòng · hợp lệ {normalized.valid_count} · cần kiểm tra {normalized.invalid_count} · có thể trùng {normalized.duplicate_count}.</p>
          <p className="source-note">Tổng giao dịch TKTT hợp lệ: tiền chi {moneyExact(pdfTotals.debit)} · tiền thu {moneyExact(pdfTotals.credit)}. Không cộng bảng CCTG vào các tổng này.</p>
          {normalized.ignored_sections?.length > 0 && <div className="source-note" role="status">
            <strong>Đã loại trừ {normalized.ignored_candidate_count} dòng CCTG.</strong> Các dòng thuộc bảng phân bổ CCTG không vào bản xem trước, dữ liệu chờ duyệt hoặc phiếu Thu Chi.
            <ul>{normalized.ignored_sections.map((section, index) => <li key={index}>
              Trang {section.start_page}{section.end_page !== section.start_page ? `–${section.end_page}` : ''}: {section.candidate_count} dòng bị bỏ qua.
            </li>)}</ul>
          </div>}
          {normalized.unsupported_sections?.length > 0 && <div className="inline-error" role="status">
            <strong>PDF có khu vực chưa nhận diện.</strong> Có {normalized.unsupported_sections.length} khu vực ngoài bảng TKTT/CCTG đã xác minh; chưa thể nhập để tránh bỏ sót giao dịch.
            <ul>{normalized.unsupported_sections.map((section, index) => <li key={index}>
              Trang {section.start_page}{section.end_page !== section.start_page ? `–${section.end_page}` : ''}; {section.candidate_count} dòng ứng viên cần đối chiếu.
            </li>)}</ul>
          </div>}
          {normalized.invalid_count > 0 && <p className="source-note">Có dòng chưa xác định chắc chắn ngày, chiều hoặc số tiền; toàn bộ file sẽ chờ hỗ trợ thêm định dạng.</p>}
          {normalized.needs_currency_confirmation && <label className="checkbox bank-currency-confirm">
            <input type="checkbox" checked={vndConfirmed} onChange={(event) => setVndConfirmed(event.target.checked)} />
            Tôi đã kiểm tra sao kê gốc và xác nhận các giao dịch TKTT nhập vào dùng VND.
          </label>}
          {normalized.ignored_candidate_count > 0 && <label className="checkbox bank-currency-confirm">
            <input type="checkbox" checked={cctgConfirmed} onChange={(event) => setCctgConfirmed(event.target.checked)} />
            Tôi xác nhận bỏ qua {normalized.ignored_candidate_count} dòng CCTG; chỉ tiếp tục với {normalized.valid_count} giao dịch TKTT.
          </label>}
          <label className="bank-account-choice">Tài khoản Thu Chi cho các giao dịch PDF
            <select aria-label="Tài khoản Thu Chi cho sao kê PDF" value={pdfAccountId} onChange={(event) => setPdfAccountId(event.target.value)}>
              <option value="">Chọn tài khoản trong ChiDi ERP</option>
              {data.cash_accounts.map((account) => <option key={account.id} value={account.id}>{account.code} · {account.name}</option>)}
            </select>
          </label>
          <p className="source-note">Tên tài khoản in trên mẫu PDF là tên chủ tài khoản, không xác định duy nhất tài khoản Thu Chi. Hãy chọn tài khoản ERP tương ứng; có thể sửa từng dòng trước khi ghi sổ. Tên/số tài khoản từ PDF không được lưu.</p>
        </> : <p className="source-note">Hợp lệ: {normalized.valid_count} · Cần sửa trong Excel: {normalized.invalid_count} · Có thể trùng trong file: {normalized.duplicate_count}. Dòng lỗi không được lưu chờ duyệt.</p>}
        <Table headers={pdfPreview ? ['Trang / dòng', 'Ngày', 'Nội dung', 'Chiều', 'Số tiền', 'Kiểm tra'] : ['Dòng', 'Ngày', 'Nội dung', 'Chiều', 'Số tiền', 'Kiểm tra']} empty={!normalized.rows.length}>
          {normalized.rows.slice(0, 100).map((row) => <tr key={row.row_number}>
            <td>{pdfPreview ? `Trang ${row.source_page}, dòng ${row.source_row}` : row.row_number}</td><td>{row.date || '—'}</td><td>{row.description || '—'}</td>
            <td>{row.direction === 'out' ? 'Chi' : row.direction === 'in' ? 'Thu' : '—'}</td>
            <td className="numeric">{row.amount == null ? '—' : money(row.amount)}</td>
            <td>{row.errors.length ? row.errors.join('; ') : row.warnings.length ? row.warnings.join('; ') : 'Hợp lệ'}</td>
          </tr>)}
        </Table>
        {normalized.rows.length > 100 && <p className="source-note">Đang hiển thị 100 dòng đầu trong bản xem trước; các dòng còn lại vẫn được kiểm tra trước khi lưu.</p>}
        <div className="modal-actions"><button className="button primary" disabled={busy || !normalized.valid_count || (pdfPreview ? pdfBlocked || !pdfCurrencyReady || !pdfCctgReady || !pdfAccountId || !canStagePdf : !canStage)} onClick={stage}>
          {busy ? 'Đang lưu…' : pdfPreview ? `Tiếp tục phân loại ${normalized.valid_count} dòng PDF` : `Lưu ${normalized.valid_count} dòng hợp lệ để phân loại`}
        </button></div>
        {pdfPreview ? <p className="source-note">{pdfBlocked
          ? 'Chưa thể tiếp tục: parser chưa xác nhận đầy đủ mọi trang và mọi dòng. Hãy dùng sao kê Excel hoặc chờ bổ sung định dạng PDF.'
          : !pdfCurrencyReady ? 'Cần xác nhận đơn vị tiền tệ VND từ sao kê gốc trước khi tiếp tục.'
          : !pdfCctgReady ? 'Cần xác nhận bỏ qua bảng CCTG trước khi tiếp tục.'
          : !pdfAccountId ? 'Chọn Tài khoản Thu Chi trong ChiDi ERP cho các giao dịch TKTT.'
          : !canStagePdf ? 'Cần quyền owner/manager và chức năng nhập PDF an toàn trên database để tiếp tục.'
          : 'Bước tiếp theo chỉ chuyển các trường giao dịch TKTT cần thiết; hãy chọn nhóm thu chi, kiểm tra trùng và xác nhận từng dòng trước khi ghi sổ.'}</p>
          : !canStage && <p className="source-note">Cần quyền nhân viên trở lên và database đã áp dụng migration 016 để lưu file.</p>}
      </>}
    </Panel>}

    <Panel title="Lịch sử nhập sao kê" note="Mở lần nhập Excel hoặc PDF để xem các dòng đã ghi và tiếp tục phân loại, xác nhận dòng còn chờ. Phiếu đã ghi sổ chỉ được sửa bằng chứng từ đảo.">
      {historyLoading && <p className="source-note">Đang tải lịch sử nhập…</p>}
      <Table headers={['Ngày nhập', 'Định dạng', 'Giao dịch', 'Mã đối chiếu', 'Thao tác']} empty={!historyLoading && !batches.length}>
        {batches.map((batch) => <tr key={batch.id}>
          <td>{historyDate(batch.created_at)}</td>
          <td>{batch.source_format === 'pdf' ? 'Techcombank PDF' : 'Excel'}</td>
          <td>{batch.row_count} dòng</td>
          <td className="mono">{batch.source_sha256.slice(0, 12)}</td>
          <td><button type="button" className="small-button" aria-label={`Xem lần nhập ${batch.source_sha256.slice(0, 12)}`}
            onClick={() => { setBatchId(batch.id);setOffset(0);setSelected([]);setEdits({}); }}>
            Xem và xử lý
          </button></td>
        </tr>)}
      </Table>
      <div className="table-footer">
        {historyTotal} lần nhập · đang xem {historyTotal ? historyOffset + 1 : 0}–{Math.min(historyOffset + 20, historyTotal)}
        <div className="toolbar"><button className="button secondary" disabled={historyOffset === 0 || historyLoading}
          onClick={() => setHistoryOffset(Math.max(0, historyOffset - 20))}>Trang trước</button>
          <button className="button secondary" disabled={historyOffset + 20 >= historyTotal || historyLoading}
            onClick={() => setHistoryOffset(historyOffset + 20)}>Trang sau</button></div>
      </div>
      {batchId && <div className="bank-history-detail">
        <div className="bank-history-heading"><h3>Chi tiết lần nhập</h3>
          <button type="button" className="button secondary" onClick={() => { setBatchId('');setPage(null);setSelected([]);setEdits({}); }}>Đóng chi tiết</button>
        </div>
      {initialRowNumber && page && <p className="source-note">Giao dịch nguồn: dòng {initialRowNumber} trong lần nhập {page.batch.source_format === 'pdf' ? 'PDF' : 'Excel'}. Dùng phân trang để xem dòng này nếu chưa hiện.</p>}
      {loading && <p>Đang đọc dữ liệu sao kê…</p>}
      {page && !loading && <>
        <p className="source-note">{page.batch.source_format === 'pdf' ? 'Techcombank PDF' : 'Excel'} · Mã đối chiếu {page.batch.source_sha256.slice(0, 12)} · {page.pending} dòng chờ duyệt · {page.confirmed} dòng đã ghi.
          {page.batch.source_format === 'pdf' && page.batch.excluded_cctg_count > 0 && ` Đã bỏ qua ${page.batch.excluded_cctg_count} dòng CCTG.`}</p>
        <div className="bank-selection-bar">
          <label><input type="checkbox" checked={pendingRows.length > 0 && pendingRows.every((row) => selected.includes(row.id))}
            onChange={(event) => setSelected(event.target.checked ? pendingRows.map((row) => row.id) : [])} /> Chọn toàn bộ dòng chờ trên trang</label>
          <span>{selected.length} dòng đã chọn</span>
          <button className="button primary" disabled={!canConfirm || busy || !selected.length || hasUnsaved}
            onClick={() => { setConfirming(true);setConfirmed(false); }}>
            Ghi sổ dòng đã chọn
          </button>
        </div>
        {hasUnsaved && <p className="source-note">Lưu các thay đổi tài khoản/nhóm trên dòng đã chọn trước khi ghi sổ.</p>}
        <Table headers={['Chọn', 'Dòng / ngày', 'Nội dung / nguồn', 'Thu/chi', 'Tài khoản', 'Nhóm thu chi', 'Đối chiếu', 'Trạng thái / thao tác']} empty={!rows.length}>
          {rows.map((row) => {
            const draft = draftFor(row);
            const duplicate = row.duplicate?.possible_duplicate;
            return <tr key={row.id} className={Number(initialRowNumber) === row.row_number ? 'bank-source-highlight' : ''}>
              <td><input type="checkbox" aria-label={`Chọn dòng ${row.row_number}`} disabled={row.status !== 'pending'} checked={selected.includes(row.id)}
                onChange={(event) => setSelected((current) => event.target.checked ? [...current, row.id] : current.filter((id) => id !== row.id))} /></td>
              <td><strong>#{row.row_number}</strong><small>{dateLabel(row.transaction_date)}</small>
                {storedPdf && Number.isInteger(row.raw_row?.source_page) && Number.isInteger(row.raw_row?.source_row) &&
                  <small>Trang {row.raw_row.source_page}, dòng {row.raw_row.source_row}</small>}</td>
              <td><strong>{row.description}</strong><small>{row.external_reference || 'Không có mã tham chiếu'}</small></td>
              <td>{row.direction === 'out' ? 'Chi' : 'Thu'}<small>{money(row.amount)}</small></td>
              <td><select aria-label={`Tài khoản dòng ${row.row_number}`} disabled={row.status !== 'pending' || busy}
                value={draft.account_id} onChange={(event) => edit(row, 'account_id', event.target.value)}>
                <option value="">Chọn tài khoản</option>
                {data.cash_accounts.map((account) => <option key={account.id} value={account.id}>{account.code} · {account.name}</option>)}
              </select></td>
              <td><select aria-label={`Nhóm dòng ${row.row_number}`} disabled={row.status !== 'pending' || busy}
                value={draft.category_code} onChange={(event) => edit(row, 'category_code', event.target.value)}>
                <option value="">Chọn nhóm</option>
                {categories.filter((c) => c.direction === row.direction && c.is_active).map((c) =>
                  <option key={c.id} value={c.code}>{c.name}</option>)}
              </select></td>
              <td>{duplicate ? <><strong>Có thể trùng</strong><small>{row.duplicate.cash_count} giao dịch · {row.duplicate.row_count} dòng sao kê chờ</small>
                {row.status === 'pending' && <textarea aria-label={`Lý do xác nhận trùng dòng ${row.row_number}`} minLength={10} maxLength={4000}
                  placeholder="Nếu đúng là giao dịch khác, ghi rõ lý do đối chiếu" value={draft.duplicate_reason}
                  onChange={(event) => edit(row, 'duplicate_reason', event.target.value)} />}</>
                : 'Chưa thấy dòng tương tự'}</td>
              <td><Badge status={row.status === 'confirmed' ? 'posted' : 'draft'}>{row.status === 'confirmed' ? 'Đã ghi' : 'Chờ duyệt'}</Badge>
                {row.status === 'pending' && <button className="small-button" disabled={busy || !canClassifyStored}
                  onClick={() => saveRow(row)}>Lưu phân loại</button>}
                {row.cash_id && <small className="mono">Phiếu {row.cash_id.slice(0, 8)}</small>}</td>
            </tr>;
          })}
        </Table>
        <div className="table-footer">
          {page.total} dòng · đang xem {offset + 1}–{Math.min(offset + PAGE_SIZE, page.total)}
          <div className="toolbar"><button className="button secondary" disabled={offset === 0 || busy} onClick={() => { setOffset(Math.max(0, offset - PAGE_SIZE));setSelected([]);setEdits({}); }}>Trang trước</button>
            <button className="button secondary" disabled={offset + PAGE_SIZE >= page.total || busy} onClick={() => { setOffset(offset + PAGE_SIZE);setSelected([]);setEdits({}); }}>Trang sau</button></div>
        </div>
      </>}
      </div>}
    </Panel>
    {confirming && <Modal title="Ghi sổ các dòng sao kê đã chọn" onClose={() => !busy && setConfirming(false)}>
      <div className="confirm-body">
        <p>{selected.length} dòng, tổng trị tuyệt đối {money(selectedAmount)}. Mỗi dòng sẽ tạo một phiếu Thu Chi đã ghi sổ. Có thể đảo phiếu sau đó, không sửa trực tiếp ledger.</p>
        <p>Hệ thống sẽ chặn dòng thiếu tài khoản/nhóm hoặc có thể trùng mà chưa ghi lý do. Toàn bộ nhóm dòng được ghi cùng một giao dịch database.</p>
        <label className="checkbox"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> Tôi đã đối chiếu file gốc và phân loại các dòng.</label>
        <ErrorMessage error={error} />
      </div><footer className="modal-actions"><button className="button secondary" disabled={busy} onClick={() => setConfirming(false)}>Hủy</button>
        <button className="button primary" disabled={busy || !confirmed} onClick={confirmRows}>{busy ? 'Đang ghi…' : 'Xác nhận ghi sổ'}</button></footer>
    </Modal>}
  </>;
}
