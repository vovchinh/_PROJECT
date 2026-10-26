import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { ErrorMessage, Field, Modal, Panel, Table } from '../../components.jsx';
import { EmployeePicker, isoToday } from './HrShared.jsx';
import './hr-qr.css';

const emptySite = () => ({ code: '', name: '' });
const emptyAssignment = () => ({
  employee_id: '',
  site_id: '',
  valid_from: isoToday(),
  valid_to: '',
});
const asTime = (value) =>
  value
    ? new Date(value).toLocaleString('vi-VN', {
        timeZone: 'Asia/Ho_Chi_Minh',
        dateStyle: 'short',
        timeStyle: 'medium',
      })
    : '—';

export default function HrQrSetup({ api, onChanged }) {
  const [setup, setSetup] = useState({ sites: [], assignments: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [formError, setFormError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [siteForm, setSiteForm] = useState(null);
  const [assignmentForm, setAssignmentForm] = useState(null);
  const [archiveSite, setArchiveSite] = useState(null);
  const [archiveReason, setArchiveReason] = useState('');
  const [selectedSite, setSelectedSite] = useState('');
  const [kiosk, setKiosk] = useState(null);
  const [challenge, setChallenge] = useState(null);
  const [qrImage, setQrImage] = useState('');
  const [now, setNow] = useState(Date.now());
  const mounted = useRef(false);
  const kioskRef = useRef(null);
  const startRequest = useRef(null);

  const refresh = useCallback(async () => {
    const result = await api.listQrSetup();
    setSetup({ sites: result?.sites || [], assignments: result?.assignments || [] });
    setSelectedSite((current) =>
      result?.sites?.some((site) => site.id === current && site.is_active) ? current : '',
    );
    return result;
  }, [api]);

  useEffect(() => {
    mounted.current = true;
    setLoading(true);
    refresh()
      .catch((cause) => setError(cause.message))
      .finally(() => setLoading(false));
    return () => {
      mounted.current = false;
      // Leaving the kiosk view revokes its manager session.
      if (kioskRef.current) api.stopQrKiosk(kioskRef.current.id).catch(() => {});
    };
  }, [api, refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!kiosk) return undefined;
    let active = true;
    let timer;
    const issue = async () => {
      if (Date.parse(kiosk.expires_at) <= Date.now()) {
        setChallenge(null);
        setQrImage('');
        setKiosk(null);
        kioskRef.current = null;
        setError('Phiên kiosk đã hết hạn. Hãy mở lại để tiếp tục.');
        return;
      }
      try {
        const next = await api.issueQrChallenge(kiosk.id);
        if (!active) return;
        if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(next.token || ''))
          throw new Error('Máy chủ trả về mã QR không hợp lệ.');
        const image = await QRCode.toDataURL(next.token, {
          width: 360,
          margin: 2,
          errorCorrectionLevel: 'M',
        });
        if (!active) return;
        setChallenge(next);
        setQrImage(image);
        setError('');
        const delay = Math.max(
          3000,
          Math.min(24000, Date.parse(next.expires_at) - Date.now() - 4000),
        );
        timer = window.setTimeout(issue, delay);
      } catch (cause) {
        if (!active) return;
        setChallenge(null);
        setQrImage('');
        setError(`Không thể làm mới QR: ${cause.message}`);
        timer = window.setTimeout(issue, 5000);
      }
    };
    issue();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [api, kiosk]);

  async function saveSite(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setFormError('');
    try {
      await api.saveAttendanceSite({
        ...(siteForm.id ? { id: siteForm.id } : {}),
        code: siteForm.code.trim(),
        name: siteForm.name.trim(),
      });
      await refresh();
      setSiteForm(null);
      setNotice('Đã lưu cửa hàng chấm công.');
      onChanged?.();
    } catch (cause) {
      setFormError(cause.message);
    } finally {
      setBusy(false);
    }
  }

  async function toggleArchive(event) {
    event.preventDefault();
    if (busy || !archiveSite) return;
    setBusy(true);
    setFormError('');
    try {
      await api.saveAttendanceSite({
        id: archiveSite.id,
        code: archiveSite.code,
        name: archiveSite.name,
        is_active: !archiveSite.is_active,
        ...(archiveSite.is_active ? { archive_reason: archiveReason.trim() } : {}),
      });
      await refresh();
      setArchiveSite(null);
      setArchiveReason('');
      setNotice('Đã cập nhật trạng thái cửa hàng.');
      onChanged?.();
    } catch (cause) {
      setFormError(cause.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveAssignment(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setFormError('');
    try {
      await api.saveSiteAssignment({
        ...(assignmentForm.id ? { id: assignmentForm.id } : {}),
        employee_id: assignmentForm.employee_id,
        site_id: assignmentForm.site_id,
        valid_from: assignmentForm.valid_from,
        valid_to: assignmentForm.valid_to || null,
      });
      await refresh();
      setAssignmentForm(null);
      setNotice('Đã lưu phân công cửa hàng.');
      onChanged?.();
    } catch (cause) {
      setFormError(cause.message);
    } finally {
      setBusy(false);
    }
  }

  async function startKiosk() {
    if (busy || !selectedSite) return;
    setBusy(true);
    setError('');
    setChallenge(null);
    setQrImage('');
    if (startRequest.current?.siteId !== selectedSite)
      startRequest.current = { siteId: selectedSite, id: crypto.randomUUID() };
    try {
      const started = await api.startQrKiosk(selectedSite, startRequest.current.id);
      if (!mounted.current) {
        await api.stopQrKiosk(started.id).catch(() => {});
        return;
      }
      kioskRef.current = started;
      setKiosk(started);
      startRequest.current = null;
    } catch (cause) {
      if (mounted.current) setError(cause.message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function stopKiosk() {
    if (busy || !kiosk) return;
    setBusy(true);
    setError('');
    try {
      await api.stopQrKiosk(kiosk.id);
      kioskRef.current = null;
      setKiosk(null);
      setChallenge(null);
      setQrImage('');
      setNotice('Đã dừng phiên kiosk.');
    } catch (cause) {
      setError(cause.message);
    } finally {
      setBusy(false);
    }
  }

  const sites = setup.sites || [];
  const assignments = setup.assignments || [];
  const activeSites = sites.filter((site) => site.is_active);
  const siteName = (id) => sites.find((site) => site.id === id)?.name || 'Cửa hàng đã lưu trữ';
  const seconds = challenge
    ? Math.max(0, Math.ceil((Date.parse(challenge.expires_at) - now) / 1000))
    : 0;

  return (
    <div className="hr-qr-setup hr-records">
      <div className="hr-qr-intro">
        <div>
          <strong>Chấm công QR theo cửa hàng</strong>
          <p>
            Tạo cửa hàng, phân công nhân viên theo ngày hiệu lực, rồi gắn cửa hàng vào ca trong tab
            Chấm công. Nhân viên cần có tài khoản đăng nhập liên kết với hồ sơ.
          </p>
        </div>
      </div>
      <ErrorMessage error={error} />
      {notice && (
        <p className="hr-qr-success" role="status">
          {notice}
        </p>
      )}
      {loading ? (
        <p className="hr-records-state">Đang tải cấu hình cửa hàng…</p>
      ) : (
        <>
          <Panel
            title="Cửa hàng chấm công"
            note="Mã cửa hàng là duy nhất trong workspace. Cửa hàng đã lưu trữ vẫn giữ lịch sử."
            action={
              <button
                className="button primary"
                onClick={() => {
                  setSiteForm(emptySite());
                  setFormError('');
                }}
              >
                + Tạo cửa hàng
              </button>
            }
          >
            <Table headers={['Mã', 'Cửa hàng', 'Trạng thái', 'Thao tác']} empty={!sites.length}>
              {sites.map((site) => (
                <tr key={site.id}>
                  <td className="mono" data-label="Mã">
                    {site.code}
                  </td>
                  <td data-label="Cửa hàng">
                    <strong>{site.name}</strong>
                  </td>
                  <td data-label="Trạng thái">
                    {site.is_active ? 'Đang hoạt động' : 'Đã lưu trữ'}
                  </td>
                  <td data-label="Thao tác">
                    <div className="hr-record-actions">
                      <button
                        className="button secondary"
                        onClick={() => {
                          setSiteForm({ id: site.id, code: site.code, name: site.name });
                          setFormError('');
                        }}
                      >
                        Sửa
                      </button>
                      <button
                        className="button secondary"
                        disabled={Boolean(kiosk && kiosk.site_id === site.id)}
                        title={
                          kiosk && kiosk.site_id === site.id
                            ? 'Dừng kiosk trước khi thay đổi trạng thái cửa hàng'
                            : undefined
                        }
                        onClick={() => {
                          setArchiveSite(site);
                          setArchiveReason('');
                          setFormError('');
                        }}
                      >
                        {site.is_active ? 'Lưu trữ' : 'Khôi phục'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </Table>
          </Panel>
          <Panel
            title="Phân công nhân viên"
            note="Có thể phân công một nhân viên tại nhiều cửa hàng; ngày hiệu lực phải bao phủ ngày công của ca."
            action={
              <button
                className="button primary"
                disabled={!activeSites.length}
                onClick={() => {
                  setAssignmentForm(emptyAssignment());
                  setFormError('');
                }}
              >
                + Phân công
              </button>
            }
          >
            <Table
              headers={['Nhân viên', 'Cửa hàng', 'Từ ngày', 'Đến ngày', 'Thao tác']}
              empty={!assignments.length}
            >
              {assignments.map((row) => (
                <tr key={row.id}>
                  <td data-label="Nhân viên">
                    <strong>{row.employee_name || row.employee_id}</strong>
                    <small>{row.employee_code || ''}</small>
                  </td>
                  <td data-label="Cửa hàng">{siteName(row.site_id)}</td>
                  <td data-label="Từ ngày">{row.valid_from}</td>
                  <td data-label="Đến ngày">{row.valid_to || 'Không giới hạn'}</td>
                  <td data-label="Thao tác">
                    <button
                      className="button secondary"
                      onClick={() => {
                        setAssignmentForm({ ...row, valid_to: row.valid_to || '' });
                        setFormError('');
                      }}
                    >
                      Sửa ngày kết thúc
                    </button>
                  </td>
                </tr>
              ))}
            </Table>
          </Panel>
          <Panel
            title="Màn hình QR tại cửa hàng"
            note="Chỉ owner/manager mở phiên kiosk. Mã thay đổi khoảng mỗi 30 giây; giờ chấm công do máy chủ ghi."
            action={
              kiosk ? (
                <button className="button secondary" disabled={busy} onClick={stopKiosk}>
                  Dừng kiosk
                </button>
              ) : null
            }
          >
            {!kiosk ? (
              <div className="hr-qr-kiosk-controls">
                <Field label="Cửa hàng hiển thị QR">
                  <select
                    value={selectedSite}
                    onChange={(event) => {
                      setSelectedSite(event.target.value);
                      startRequest.current = null;
                    }}
                  >
                    <option value="">Chọn cửa hàng</option>
                    {activeSites.map((site) => (
                      <option key={site.id} value={site.id}>
                        {site.code} · {site.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <button
                  className="button primary"
                  disabled={!selectedSite || busy}
                  onClick={startKiosk}
                >
                  {busy ? 'Đang mở…' : 'Mở kiosk'}
                </button>
              </div>
            ) : (
              <div className="hr-qr-display" aria-live="polite">
                <span className="hr-qr-store">{siteName(kiosk.site_id)}</span>
                {qrImage && seconds > 0 ? (
                  <img src={qrImage} alt="Mã QR chấm công đang có hiệu lực" />
                ) : (
                  <div className="hr-qr-placeholder">Đang tạo mã QR mới…</div>
                )}
                <strong>{seconds > 0 ? `Mã đổi sau ${seconds} giây` : 'Mã đang làm mới'}</strong>
                <small>Phiên kiosk hết hạn: {asTime(kiosk.expires_at)}</small>
                <p>
                  Nhân viên đăng nhập ChiDi ERP trên điện thoại, mở “Chấm công của tôi” và quét mã
                  này.
                </p>
              </div>
            )}
          </Panel>
        </>
      )}
      {siteForm && (
        <Modal
          title={siteForm.id ? 'Sửa cửa hàng' : 'Tạo cửa hàng'}
          onClose={() => {
            if (!busy) setSiteForm(null);
          }}
        >
          <form onSubmit={saveSite} className="hr-qr-inline-form">
            <div className="form-grid">
              <Field label="Mã cửa hàng">
                <input
                  required
                  maxLength="80"
                  readOnly={Boolean(siteForm.id)}
                  value={siteForm.code}
                  onChange={(event) => setSiteForm({ ...siteForm, code: event.target.value })}
                />
              </Field>
              <Field label="Tên cửa hàng">
                <input
                  required
                  maxLength="200"
                  value={siteForm.name}
                  onChange={(event) => setSiteForm({ ...siteForm, name: event.target.value })}
                />
              </Field>
            </div>
            <ErrorMessage error={formError} />
            <div className="hr-qr-form-actions">
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => setSiteForm(null)}
              >
                Hủy
              </button>
              <button className="button primary" disabled={busy}>
                {busy ? 'Đang lưu…' : 'Lưu cửa hàng'}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {archiveSite && (
        <Modal
          title={`${archiveSite.is_active ? 'Lưu trữ' : 'Khôi phục'} · ${archiveSite.name}`}
          onClose={() => {
            if (!busy) setArchiveSite(null);
          }}
        >
          <form onSubmit={toggleArchive} className="hr-qr-inline-form">
            {archiveSite.is_active && (
              <Field label="Lý do lưu trữ">
                <textarea
                  required
                  minLength="10"
                  maxLength="4000"
                  value={archiveReason}
                  onChange={(event) => setArchiveReason(event.target.value)}
                />
              </Field>
            )}
            <ErrorMessage error={formError} />
            <div className="hr-qr-form-actions">
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => setArchiveSite(null)}
              >
                Hủy
              </button>
              <button className="button primary" disabled={busy}>
                {busy ? 'Đang lưu…' : 'Xác nhận'}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {assignmentForm && (
        <Modal
          title={assignmentForm.id ? 'Sửa ngày kết thúc phân công' : 'Phân công nhân viên'}
          onClose={() => {
            if (!busy) setAssignmentForm(null);
          }}
        >
          <form onSubmit={saveAssignment} className="hr-qr-inline-form">
            <div className="form-grid">
              {assignmentForm.id ? (
                <Field label="Nhân viên">
                  <input
                    readOnly
                    value={`${assignmentForm.employee_code || ''} · ${assignmentForm.employee_name || assignmentForm.employee_id}`}
                  />
                </Field>
              ) : (
                <EmployeePicker
                  api={api}
                  value={assignmentForm.employee_id}
                  onChange={(value) =>
                    setAssignmentForm({ ...assignmentForm, employee_id: value || '' })
                  }
                />
              )}
              <Field label="Cửa hàng">
                <select
                  required
                  disabled={Boolean(assignmentForm.id)}
                  value={assignmentForm.site_id}
                  onChange={(event) =>
                    setAssignmentForm({ ...assignmentForm, site_id: event.target.value })
                  }
                >
                  <option value="">Chọn cửa hàng</option>
                  {sites
                    .filter((site) => site.is_active || site.id === assignmentForm.site_id)
                    .map((site) => (
                      <option key={site.id} value={site.id}>
                        {site.code} · {site.name}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label="Từ ngày">
                <input
                  type="date"
                  required
                  readOnly={Boolean(assignmentForm.id)}
                  value={assignmentForm.valid_from}
                  onChange={(event) =>
                    setAssignmentForm({ ...assignmentForm, valid_from: event.target.value })
                  }
                />
              </Field>
              <Field label="Đến hết ngày (để trống nếu còn hiệu lực)">
                <input
                  type="date"
                  min={assignmentForm.valid_from}
                  value={assignmentForm.valid_to}
                  onChange={(event) =>
                    setAssignmentForm({ ...assignmentForm, valid_to: event.target.value })
                  }
                />
              </Field>
            </div>
            <ErrorMessage error={formError} />
            <div className="hr-qr-form-actions">
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => setAssignmentForm(null)}
              >
                Hủy
              </button>
              <button
                className="button primary"
                disabled={busy || !assignmentForm.employee_id || !assignmentForm.site_id}
              >
                {busy ? 'Đang lưu…' : 'Lưu phân công'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
