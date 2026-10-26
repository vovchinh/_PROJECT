import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Camera, CheckCircle2, Clock3, LogOut, RefreshCw, ScanLine, X } from 'lucide-react';
import { ErrorMessage, Field } from '../../components.jsx';
import { supabase } from '../../lib/repository.js';
import { createHrApi } from '../../lib/hr-api.js';
import { isoMonth } from './HrShared.jsx';
import './hr-qr.css';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const actionLabel = { check_in: 'Giờ vào', check_out: 'Giờ ra' };
const scanRejections = {
  HR_QR_RATE_LIMIT: 'Bạn đã quét sai quá nhiều lần. Hãy chờ vài phút rồi thử lại.',
  HR_QR_EMPLOYEE: 'Tài khoản này chưa liên kết với hồ sơ nhân viên đang hoạt động.',
  HR_QR_CHALLENGE_EXPIRED: 'Mã QR đã hết hạn. Hãy quét mã mới trên kiosk.',
  HR_QR_KIOSK_EXPIRED: 'Kiosk đã hết phiên hoặc đã dừng. Báo quản lý mở lại.',
  HR_QR_SHIFT: 'Không tìm thấy một ca phù hợp tại cửa hàng này vào thời điểm quét.',
  HR_QR_SITE_ASSIGNMENT: 'Bạn chưa được phân công tại cửa hàng của ca làm.',
  HR_QR_CHECK_IN_REQUIRED: 'Bạn cần quét giờ vào trước khi quét giờ ra.',
  HR_QR_ALREADY_CHECKED_IN: 'Ca này đã có giờ vào.',
  HR_QR_ALREADY_CHECKED_OUT: 'Ca này đã có giờ ra.',
  HR_QR_ATTENDANCE_LOCKED: 'Bản chấm công này cần quản lý xử lý trước.',
  HR_QR_REJECTED: 'Máy chủ từ chối lượt quét. Hãy báo quản lý nếu lỗi lặp lại.',
};
const attendanceStatus = (row) => {
  if (!row.status) return 'Chưa chấm công';
  if (row.kind === 'leave')
    return row.status === 'confirmed' ? 'Nghỉ phép đã xác nhận' : 'Nghỉ phép chờ xác nhận';
  if (row.kind === 'absent')
    return row.status === 'confirmed' ? 'Vắng mặt đã xác nhận' : 'Vắng mặt chờ xác nhận';
  if (row.status === 'confirmed') return 'Đã xác nhận';
  return row.clock_out_at ? 'Chờ xác nhận' : 'Thiếu giờ ra';
};
const displayTime = (value) =>
  value
    ? new Date(value).toLocaleString('vi-VN', {
        timeZone: 'Asia/Ho_Chi_Minh',
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';
const displayMinutes = (value) => {
  if (value == null) return 'Chờ xác nhận';
  const minutes = Number(value);
  return `${Math.floor(minutes / 60)} giờ ${minutes % 60} phút`;
};
const displayVnd = (value) =>
  new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND', maximumFractionDigits: 0 })
    .format(BigInt(value || '0'));
const cameraMessage = (cause) => {
  if (cause?.name === 'NotAllowedError' || cause?.name === 'PermissionDeniedError')
    return 'Quyền camera bị từ chối. Hãy cho phép camera trong trình duyệt rồi thử lại.';
  if (cause?.name === 'NotFoundError' || cause?.name === 'DevicesNotFoundError')
    return 'Thiết bị này không tìm thấy camera. Hãy dùng điện thoại có camera.';
  if (cause?.name === 'NotReadableError' || cause?.name === 'TrackStartError')
    return 'Camera đang được ứng dụng khác sử dụng. Đóng ứng dụng đó rồi thử lại.';
  return cause?.message || 'Không thể mở camera. Hãy kiểm tra quyền camera và thử lại.';
};

export function MyAttendanceView({
  api,
  workspaceId,
  workspaceName,
  workspaces,
  chooseWorkspace,
  isManager,
}) {
  const [month, setMonth] = useState(isoMonth);
  const [history, setHistory] = useState({ employee_id: null, items: [] });
  const [loading, setLoading] = useState(true);
  const [historyError, setHistoryError] = useState('');
  const [payslips, setPayslips] = useState([]);
  const [payslipError, setPayslipError] = useState('');
  const [payslipsLoading, setPayslipsLoading] = useState(true);
  const [scanError, setScanError] = useState('');
  const [result, setResult] = useState(null);
  const [cameraAction, setCameraAction] = useState(null);
  const [attempt, setAttempt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const videoRef = useRef(null);
  const controlsRef = useRef(null);
  const capturedRef = useRef(false);
  const submittingRef = useRef(false);
  const mountedRef = useRef(true);

  const loadHistory = useCallback(async () => {
    const value = await api.getMyAttendance(`${month}-01`);
    if (mountedRef.current)
      setHistory({ employee_id: value?.employee_id || null, items: value?.items || [] });
  }, [api, month]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      controlsRef.current?.stop();
    };
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setHistoryError('');
    api
      .getMyAttendance(`${month}-01`)
      .then((value) => {
        if (active)
          setHistory({ employee_id: value?.employee_id || null, items: value?.items || [] });
      })
      .catch((cause) => {
        if (active) setHistoryError(cause.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, month, revision]);

  useEffect(() => {
    let active = true;
    setPayslipsLoading(true);
    setPayslipError('');
    api.getMyPayslips()
      .then((value) => { if (active) setPayslips(value?.items || []); })
      .catch((cause) => { if (active) setPayslipError(cause.message); })
      .finally(() => { if (active) setPayslipsLoading(false); });
    return () => { active = false; };
  }, [api, revision]);

  async function submitScan(nextAttempt) {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setBusy(true);
    setScanError('');
    setResult(null);
    try {
      const saved = await api.scanQr(nextAttempt.token, nextAttempt.action, nextAttempt.id);
      if (!mountedRef.current) return;
      setAttempt(null);
      setResult(saved);
      setRevision((value) => value + 1);
    } catch (cause) {
      if (mountedRef.current) {
        if (typeof cause.code === 'string' && cause.code.startsWith('HR_QR_')) setAttempt(null);
        const message = scanRejections[cause.code] || cause.message;
        setScanError(
          cause.code?.startsWith('HR_QR_')
            ? `${message} (${cause.code})`
            : `${message} Nếu kết nối bị gián đoạn, hãy thử gửi lại cùng mã.`,
        );
      }
    } finally {
      submittingRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  }

  useEffect(() => {
    if (!cameraAction) return undefined;
    let active = true;
    capturedRef.current = false;
    import('@zxing/browser')
      .then(({ BrowserQRCodeReader }) => {
        if (!active) return null;
        const reader = new BrowserQRCodeReader();
        return reader.decodeFromVideoDevice(undefined, videoRef.current, (decoded) => {
          if (!active || !decoded || capturedRef.current) return;
          capturedRef.current = true;
          controlsRef.current?.stop();
          const token = decoded.getText().trim();
          if (!UUID.test(token)) {
            setScanError(
              'Mã quét được không phải QR chấm công ChiDi. Hãy hướng camera vào mã trên kiosk.',
            );
            setCameraAction(null);
            return;
          }
          const nextAttempt = { token, action: cameraAction, id: crypto.randomUUID() };
          setAttempt(nextAttempt);
          setCameraAction(null);
          submitScan(nextAttempt);
        });
      })
      .then((controls) => {
        if (!controls) return;
        if (!active || capturedRef.current) controls.stop();
        else controlsRef.current = controls;
      })
      .catch((cause) => {
        if (!active) return;
        setScanError(cameraMessage(cause));
        setCameraAction(null);
      });
    return () => {
      active = false;
      controlsRef.current?.stop();
      controlsRef.current = null;
      const stream = videoRef.current?.srcObject;
      stream?.getTracks?.().forEach((track) => track.stop());
    };
  }, [cameraAction]);

  function startCamera(action) {
    if (busy) return;
    setResult(null);
    setScanError('');
    setAttempt(null);
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setScanError(
        'Camera chỉ hoạt động trên HTTPS hoặc localhost trong trình duyệt hỗ trợ camera.',
      );
      return;
    }
    setCameraAction(action);
  }

  function stopCamera() {
    controlsRef.current?.stop();
    setCameraAction(null);
  }

  const rows = history.items || [];
  return (
    <div className="my-attendance-page">
      <header className="my-attendance-header">
        <div>
          <span className="brand">
            ChiDi<span>ERP</span>
          </span>
          <small>Chấm công của tôi</small>
        </div>
        <button className="button secondary" onClick={() => supabase.auth.signOut()}>
          <LogOut size={16} /> Đăng xuất
        </button>
      </header>
      <main className="my-attendance-main">
        <div className="my-attendance-heading">
          <div>
            <span className="my-attendance-eyebrow">{workspaceName}</span>
            <h1>Chấm công của tôi</h1>
            <p>
              Quét mã QR đang hiển thị tại cửa hàng để ghi giờ vào hoặc giờ ra bằng giờ máy chủ.
            </p>
          </div>
          {isManager && (
            <a className="button secondary" href="#/hr/attendance">
              Quản lý chấm công
            </a>
          )}
        </div>
        {workspaces.length > 1 && (
          <Field label="Không gian làm việc">
            <select
              value={workspaceId}
              onChange={(event) => {
                stopCamera();
                setAttempt(null);
                setResult(null);
                setScanError('');
                chooseWorkspace(event.target.value);
              }}
            >
              {workspaces.map((row) => (
                <option key={row.workspace_id} value={row.workspace_id}>
                  {row.workspaces.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <section className="my-attendance-card my-attendance-scan">
          <div className="my-attendance-card-title">
            <span className="my-attendance-icon">
              <ScanLine size={21} />
            </span>
            <div>
              <h2>Quét mã tại cửa hàng</h2>
              <p>Chọn đúng thao tác trước khi đưa camera vào mã QR.</p>
            </div>
          </div>
          <ErrorMessage error={scanError} />
          {result && (
            <div className="hr-qr-success" role="status">
              <CheckCircle2 size={19} />
              Đã ghi {actionLabel[result.action] || 'chấm công'} lúc{' '}
              {displayTime(result.occurred_at)}. Bản chấm công vẫn cần quản lý xác nhận.
            </div>
          )}
          {cameraAction ? (
            <div className="my-attendance-camera">
              <video ref={videoRef} muted playsInline aria-label="Hình từ camera để quét QR" />
              <span>Đang quét {actionLabel[cameraAction].toLowerCase()}…</span>
              <button className="button secondary" onClick={stopCamera}>
                <X size={16} /> Đóng camera
              </button>
            </div>
          ) : (
            <div className="my-attendance-actions">
              <button
                className="button primary"
                disabled={busy}
                onClick={() => startCamera('check_in')}
              >
                <Camera size={18} /> Quét giờ vào
              </button>
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => startCamera('check_out')}
              >
                <Camera size={18} /> Quét giờ ra
              </button>
            </div>
          )}
          {busy && (
            <p className="hr-muted" role="status">
              Đang xác nhận mã với máy chủ…
            </p>
          )}
          {scanError && attempt && (
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => submitScan(attempt)}
            >
              <RefreshCw size={16} /> Thử gửi lại cùng mã
            </button>
          )}
          <p className="my-attendance-hint">
            Nếu mã đã đổi trên kiosk, hãy quét lại mã mới. Tài khoản của bạn phải được liên kết với
            hồ sơ nhân viên, được phân công vào cửa hàng và có ca tại đó.
          </p>
        </section>
        <section className="my-attendance-card">
          <div className="my-attendance-card-title">
            <span className="my-attendance-icon">
              <Clock3 size={21} />
            </span>
            <div>
              <h2>Lịch sử của tôi</h2>
              <p>Giờ quét và trạng thái trong tháng đã chọn.</p>
            </div>
          </div>
          <div className="my-attendance-history-toolbar">
            <Field label="Tháng">
              <input
                type="month"
                value={month}
                onChange={(event) => setMonth(event.target.value)}
              />
            </Field>
            <button
              className="button secondary"
              disabled={loading}
              onClick={() => {
                setHistoryError('');
                setLoading(true);
                loadHistory()
                  .catch((cause) => setHistoryError(cause.message))
                  .finally(() => setLoading(false));
              }}
            >
              <RefreshCw size={16} /> Tải lại
            </button>
          </div>
          <ErrorMessage error={historyError} />
          {loading ? (
            <p className="hr-muted">Đang tải lịch sử chấm công…</p>
          ) : (
            !historyError &&
            (!rows.length ? (
              <p className="my-attendance-empty">Chưa có ca làm trong tháng này.</p>
            ) : (
              <div className="my-attendance-history">
                {rows.map((row, index) => (
                  <article key={row.id || row.schedule_id || index}>
                    <div>
                      <strong>{row.work_date || 'Ngày công'}</strong>
                      <small>
                        {row.site_name || 'Ca thủ công'} · {row.shift_name || 'Ca làm'}
                      </small>
                    </div>
                    <div>
                      <span>Vào: {displayTime(row.clock_in_at)}</span>
                      <span>Ra: {displayTime(row.clock_out_at)}</span>
                      <span>Giờ công: {displayMinutes(row.work_minutes)}</span>
                    </div>
                    <span className="my-attendance-status">{attendanceStatus(row)}</span>
                    {row.qr_events?.length > 0 && (
                      <small className="my-attendance-events">
                        {row.qr_events
                          .map(
                            (event) =>
                              `${actionLabel[event.action] || event.action}: ${displayTime(event.occurred_at)}`,
                          )
                          .join(' · ')}
                      </small>
                    )}
                  </article>
                ))}
              </div>
            ))
          )}
        </section>
        <section className="my-attendance-card">
          <div className="my-attendance-card-title">
            <span className="my-attendance-icon"><Clock3 size={21} /></span>
            <div>
              <h2>Phiếu lương của tôi</h2>
              <p>Chỉ hiển thị các kỳ đã duyệt hoặc đã ghi nhận trả lương. Số tiền dựa trên phiếu lương đã chốt.</p>
            </div>
          </div>
          <ErrorMessage error={payslipError} />
          {payslipsLoading ? <p className="hr-muted">Đang tải phiếu lương…</p> :
            !payslipError && (!payslips.length
              ? <p className="my-attendance-empty">Chưa có phiếu lương được duyệt.</p>
              : <div className="my-attendance-history">
                  {payslips.map((slip) => <article key={slip.line_id}>
                    <div><strong>{slip.period_start} — {slip.period_end}</strong>
                      <small>{slip.status === 'PAID' ? 'Đã ghi nhận trả lương' : 'Đã duyệt'}</small>
                    </div>
                    <div><span>Giờ công: {displayMinutes(slip.regular_minutes)}</span>
                      <span>Tăng ca đã duyệt: {displayMinutes(slip.overtime_minutes)}</span></div>
                    <div><span>Tổng thu nhập: {displayVnd(slip.gross_pay)}</span>
                      <span>Khấu trừ ứng lương: {displayVnd(slip.advance_deduction)}</span>
                      <strong>Thực nhận: {displayVnd(slip.net_pay)}</strong></div>
                  </article>)}
                </div>)}
        </section>
      </main>
    </div>
  );
}

export default function MyAttendancePage(props) {
  const api = useMemo(() => createHrApi(supabase, props.workspaceId), [props.workspaceId]);
  return <MyAttendanceView {...props} api={api} />;
}
