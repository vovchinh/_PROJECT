import { useEffect, useMemo, useState } from 'react';
import { Panel, Table, Modal, ErrorMessage, Badge } from '../components.jsx';
import { dateLabel, money } from '../lib/domain.js';
import { readBankStatementFile, normalizeBankStatementRows } from '../lib/bank-statement-file.js';

const PAGE_SIZE = 100;
const MAPPING_FIELDS = [
  ['date', 'Ngày giao dịch'], ['description', 'Nội dung'],
  ['debit', 'Tiền chi / ghi nợ'], ['credit', 'Tiền thu / ghi có'],
  ['amount', 'Số tiền có dấu (+ thu, − chi)'], ['reference', 'Mã tham chiếu'],
];
const newId = () => crypto.randomUUID();

export default function BankStatementImport({ data, repo, onChanged, initialBatchId, initialRowNumber }) {
  const [sheet, setSheet] = useState(1);
  const [headerRow, setHeaderRow] = useState(1);
  const [preview, setPreview] = useState(null);
  const [mapping, setMapping] = useState({});
  const [batches, setBatches] = useState([]);
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
  const canConfirm = ['owner', 'manager'].includes(data.role) && typeof repo.confirmBankStatementRows === 'function';
  const normalized = useMemo(() => {
    if (!preview) return null;
    try { return normalizeBankStatementRows(preview, mapping); }
    catch (cause) { return { error: cause.message }; }
  }, [preview, mapping]);

  async function refreshBatches() {
    if (!repo.listBankStatementBatches) return;
    const value = await repo.listBankStatementBatches();
    setBatches(value || []);
  }
  useEffect(() => {
    refreshBatches().catch((cause) => setError(cause.message));
  }, [repo]);
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
    try {
      const result = await readBankStatementFile(file, { sheet: Number(sheet), headerRow: Number(headerRow) });
      setPreview(result);setMapping(result.suggested_mapping);
    } catch (cause) { setError(cause.message); }
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
    const payload = {
      source_name: preview.filename, source_sha256: preview.file_sha256,
      rows: normalized.rows.filter((row) => row.valid).map((row) => ({
        row_number: row.row_number, raw_row: row.raw_row,
        transaction_date: row.date, direction: row.direction, amount: row.amount,
        description: row.description, external_reference: row.external_ref,
      })),
    };
    const payloadText = JSON.stringify(payload);
    const request = stageRequest?.payloadText === payloadText ? stageRequest.id : newId();
    setStageRequest({ payloadText, id: request });
    setBusy(true);setError('');setMessage('');
    try {
      const result = await repo.stageBankStatement(payload, request);
      setBatchId(result.batch_id);setOffset(0);setPreview(null);
      await refreshBatches();
      setMessage(result.reused
        ? 'File này đã được lưu để đối chiếu; không tạo thêm chứng từ.'
        : 'Đã lưu dữ liệu sao kê chờ duyệt. Chưa ghi sổ tiền.');
    } catch (cause) { setError(cause.message); }
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
  const pendingRows = rows.filter((row) => row.status === 'pending');
  const selectedRows = rows.filter((row) => selected.includes(row.id));
  const selectedAmount = selectedRows.reduce((value, row) => value + Number(row.amount), 0);
  const hasUnsaved = selectedRows.some((row) => Boolean(edits[row.id]));

  return <>
    <Panel title="Nhập sao kê ngân hàng" note="Đọc Excel và xem trước ở trình duyệt. Chỉ khi xác nhận dòng hợp lệ, hệ thống mới ghi phiếu Thu Chi và sổ tiền.">
      <div className="bank-import-controls">
        <label>Số sheet <input type="number" min="1" value={sheet} onChange={(event) => setSheet(event.target.value)} /></label>
        <label>Dòng tiêu đề <input type="number" min="1" max="50" value={headerRow} onChange={(event) => setHeaderRow(event.target.value)} /></label>
        <label>Chọn file .xlsx <input type="file" accept=".xlsx" disabled={busy} onChange={(event) => readFile(event.target.files?.[0])} /></label>
      </div>
      <p className="source-note">File tối đa 5 MB, 5.000 dòng. Chọn đúng sheet và dòng tiêu đề trước khi mở file. Mã nguồn SHA-256 tính từ tệp trên máy.</p>
      <ErrorMessage error={error} />
      {message && <p className="success-message" role="status">{message}</p>}
    </Panel>

    {preview && <Panel title={`Xem trước: ${preview.filename}`} note={`SHA-256: ${preview.file_sha256}`}>
      <div className="bank-mapping">
        {MAPPING_FIELDS.map(([key, label]) => <label key={key}>{label}
          <select aria-label={label} value={mapping[key] ?? ''} onChange={(event) => changeMapping(key, event.target.value)}>
            <option value="">Chưa chọn</option>
            {preview.headers.map((header, index) => <option value={index} key={index}>{header}</option>)}
          </select>
        </label>)}
      </div>
      {normalized?.error ? <p className="source-note">{normalized.error}</p> : <>
        <p className="source-note">Hợp lệ: {normalized.valid_count} · Cần sửa trong Excel: {normalized.invalid_count} · Có thể trùng trong file: {normalized.duplicate_count}. Dòng lỗi không được lưu chờ duyệt.</p>
        <Table headers={['Dòng', 'Ngày', 'Nội dung', 'Chiều', 'Số tiền', 'Kiểm tra']} empty={!normalized.rows.length}>
          {normalized.rows.slice(0, 100).map((row) => <tr key={row.row_number}>
            <td>{row.row_number}</td><td>{row.date || '—'}</td><td>{row.description || '—'}</td>
            <td>{row.direction === 'out' ? 'Chi' : row.direction === 'in' ? 'Thu' : '—'}</td>
            <td className="numeric">{row.amount == null ? '—' : money(row.amount)}</td>
            <td>{row.errors.length ? row.errors.join('; ') : row.warnings.length ? row.warnings.join('; ') : 'Hợp lệ'}</td>
          </tr>)}
        </Table>
        {normalized.rows.length > 100 && <p className="source-note">Đang hiển thị 100 dòng đầu trong bản xem trước; các dòng còn lại vẫn được kiểm tra trước khi lưu.</p>}
        <div className="modal-actions"><button className="button primary" disabled={!canStage || busy || !normalized.valid_count} onClick={stage}>
          {busy ? 'Đang lưu…' : `Lưu ${normalized.valid_count} dòng hợp lệ để phân loại`}
        </button></div>
        {!canStage && <p className="source-note">Cần quyền nhân viên trở lên và database đã áp dụng migration 016 để lưu file.</p>}
      </>}
    </Panel>}

    <Panel title="File đã lưu chờ duyệt" note="Mỗi dòng có thể đổi tài khoản và nhóm thu chi trước khi ghi sổ; sau khi ghi phải dùng chứng từ đảo.">
      <select aria-label="Chọn file sao kê" value={batchId} onChange={(event) => { setBatchId(event.target.value);setOffset(0);setSelected([]);setEdits({}); }}>
        <option value="">Chọn file đã lưu</option>
        {batches.map((batch) => <option key={batch.id} value={batch.id}>{batch.source_name} · {batch.source_sha256.slice(0, 10)} · {batch.row_count} dòng</option>)}
      </select>
      {initialRowNumber && page && <p className="source-note">Giao dịch nguồn: dòng Excel {initialRowNumber} trong file {page.batch.source_name}. Dùng phân trang để xem dòng này nếu chưa hiện.</p>}
      {loading && <p>Đang đọc dữ liệu sao kê…</p>}
      {page && !loading && <>
        <p className="source-note">Nguồn: {page.batch.source_name} · SHA-256 {page.batch.source_sha256} · {page.pending} dòng chờ duyệt · {page.confirmed} dòng đã ghi.</p>
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
              <td><strong>#{row.row_number}</strong><small>{dateLabel(row.transaction_date)}</small></td>
              <td><strong>{row.description}</strong><small>{row.external_reference || 'Không có mã tham chiếu'}</small>
                <details><summary>Ô Excel gốc</summary><code>{JSON.stringify(row.raw_row)}</code></details></td>
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
              <td>{duplicate ? <><strong>Có thể trùng</strong><small>{row.duplicate.cash_count} giao dịch · {row.duplicate.row_count} dòng cùng file</small>
                {row.status === 'pending' && <textarea aria-label={`Lý do xác nhận trùng dòng ${row.row_number}`} minLength={10} maxLength={4000}
                  placeholder="Nếu đúng là giao dịch khác, ghi rõ lý do đối chiếu" value={draft.duplicate_reason}
                  onChange={(event) => edit(row, 'duplicate_reason', event.target.value)} />}</>
                : 'Chưa thấy dòng tương tự'}</td>
              <td><Badge status={row.status === 'confirmed' ? 'posted' : 'draft'}>{row.status === 'confirmed' ? 'Đã ghi' : 'Chờ duyệt'}</Badge>
                {row.status === 'pending' && <button className="small-button" disabled={busy || !canStage}
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
