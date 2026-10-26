import { useEffect, useRef, useState } from 'react';
import { Badge, ErrorMessage, Field, Modal, Panel, Table } from '../../components.jsx';
import { HrPager, isoMonth } from './HrShared.jsx';
import './hr-overtime.css';

const PAGE_SIZE = 25;
const STATUS_LABELS = {
  pending: 'Chờ duyệt',
  approved: 'Đã duyệt',
  rejected: 'Không duyệt',
};

function timeLabel(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

export default function HrOvertime({ api, onChanged }) {
  const [month, setMonth] = useState(isoMonth);
  const [status, setStatus] = useState('pending');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState({ items: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [formError, setFormError] = useState('');
  const [selection, setSelection] = useState(null);
  const [minutes, setMinutes] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const requestId = useRef(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    api
      .listOvertimeReviews({
        month: `${month}-01`,
        status: status || null,
        page,
        pageSize: PAGE_SIZE,
      })
      .then((result) => {
        if (active) setRows(result);
      })
      .catch((cause) => {
        if (active) setError(cause.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, month, status, page, revision]);

  function openReview(row, approve) {
    setSelection(row);
    setMinutes(String(approve ? row.raw_minutes : 0));
    setReason('');
    setFormError('');
    requestId.current = crypto.randomUUID();
  }

  async function submitReview(event) {
    event.preventDefault();
    if (!selection || busy) return;
    const approvedMinutes = Number(minutes);
    if (
      !Number.isInteger(approvedMinutes) ||
      approvedMinutes < 0 ||
      approvedMinutes > selection.raw_minutes
    ) {
      setFormError('Số phút duyệt phải từ 0 đến số phút tăng ca ghi nhận.');
      return;
    }
    if (reason.trim().length < 10) {
      setFormError('Vui lòng nhập lý do duyệt hoặc từ chối từ 10 ký tự.');
      return;
    }
    setBusy(true);
    setFormError('');
    try {
      await api.reviewOvertime(
        selection.attendance_id,
        approvedMinutes,
        reason.trim(),
        requestId.current,
      );
      setSelection(null);
      requestId.current = null;
      setRevision((value) => value + 1);
      onChanged?.('Đã lưu quyết định tăng ca; kỳ lương chưa duyệt sẽ cần tính lại.');
    } catch (cause) {
      setFormError(cause.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="hr-overtime">
      <Panel
        title="Duyệt tăng ca"
        note="Giờ ra sau ca chỉ là thời gian ghi nhận. Bảng lương chỉ tính số phút được quản lý duyệt riêng."
      >
        <div className="hr-overtime-filters">
          <Field label="Tháng">
            <input
              type="month"
              value={month}
              onChange={(event) => {
                setMonth(event.target.value);
                setPage(1);
              }}
            />
          </Field>
          <Field label="Trạng thái">
            <select
              value={status}
              onChange={(event) => {
                setStatus(event.target.value);
                setPage(1);
              }}
            >
              <option value="pending">Chờ duyệt</option>
              <option value="approved">Đã duyệt</option>
              <option value="rejected">Không duyệt</option>
              <option value="">Tất cả</option>
            </select>
          </Field>
        </div>
        <ErrorMessage error={error} />
        {loading ? (
          <p role="status">Đang tải tăng ca…</p>
        ) : (
          <>
            <Table
              headers={['Ngày', 'Nhân viên', 'Ca và giờ quét', 'Tăng ca', 'Quyết định', 'Thao tác']}
              empty={!rows.items?.length}
              columns={6}
            >
              {(rows.items || []).map((row) => (
                <tr key={row.attendance_id}>
                  <td>{row.work_date}</td>
                  <td>
                    <strong>{row.employee_name}</strong>
                    <small>{row.employee_code}</small>
                  </td>
                  <td>
                    {row.shift_name || 'Ca làm việc'}
                    <small>
                      {timeLabel(row.clock_in_at)} → {timeLabel(row.clock_out_at)}
                    </small>
                  </td>
                  <td>
                    <strong>{row.raw_minutes} phút</strong>
                  </td>
                  <td>
                    <Badge status={row.review_status}>{STATUS_LABELS[row.review_status]}</Badge>
                    {row.decision_id && <small>Đã duyệt {row.approved_minutes} phút</small>}
                  </td>
                  <td>
                    <div className="hr-overtime-actions">
                      <button
                        type="button"
                        className="button secondary"
                        onClick={() => openReview(row, true)}
                      >
                        Duyệt
                      </button>
                      <button
                        type="button"
                        className="button secondary"
                        onClick={() => openReview(row, false)}
                      >
                        Không duyệt
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </Table>
            <HrPager total={rows.total} page={page} pageSize={PAGE_SIZE} onPage={setPage} />
          </>
        )}
      </Panel>
      {selection && (
        <Modal
          title={`Duyệt tăng ca · ${selection.employee_name}`}
          description={`${selection.work_date} · Ghi nhận ${selection.raw_minutes} phút ngoài giờ ca`}
          onClose={() => {
            if (!busy) setSelection(null);
          }}
        >
          <form onSubmit={submitReview} className="hr-overtime-form">
            <p>
              Quyết định này được lưu vào lịch sử. Nếu kỳ lương chưa duyệt đã được tính, hệ thống sẽ
              mở lại để tính theo số phút mới.
            </p>
            <Field label="Số phút được tính lương">
              <input
                type="number"
                min="0"
                max={selection.raw_minutes}
                step="1"
                required
                value={minutes}
                onChange={(event) => {
                  setMinutes(event.target.value);
                  requestId.current = crypto.randomUUID();
                }}
              />
            </Field>
            <Field label="Lý do">
              <textarea
                required
                minLength={10}
                maxLength={4000}
                value={reason}
                onChange={(event) => {
                  setReason(event.target.value);
                  requestId.current = crypto.randomUUID();
                }}
                placeholder="Giải thích số phút được duyệt hoặc lý do từ chối…"
              />
            </Field>
            <ErrorMessage error={formError} />
            <div className="modal-actions">
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => setSelection(null)}
              >
                Hủy
              </button>
              <button type="submit" className="button primary" disabled={busy}>
                {busy ? 'Đang lưu…' : 'Lưu quyết định'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
