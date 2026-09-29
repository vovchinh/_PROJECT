import { useEffect, useRef, useState } from 'react';
import { Panel, Field, Modal, ErrorMessage } from '../components.jsx';
import { Power, Printer, Wifi, Users } from 'lucide-react';

export function liveDuration(session, now = Date.now()) {
  if (!session?.started_at) return 'Chưa có mốc bắt đầu';
  const start = Date.parse(session.started_at);
  const end = session.ended_at
    ? Date.parse(session.ended_at)
    : session.status === 'live'
      ? now
      : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
    return 'Chưa đủ mốc thời gian';
  const seconds = Math.floor((end - start) / 1000);
  return `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export function LiveOperatorControls({
  repo,
  session,
  campaign,
  commerce,
  operations,
  canManage,
  disabled,
  onChanged,
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const request = useRef(null);
  const control = operations.session_controls?.find((c) => c.session_id === session.id);
  const metric = operations.session_metrics?.find((c) => c.session_id === session.id);
  const fresh = session.heartbeat_at && Date.now() - Date.parse(session.heartbeat_at) < 90000;
  const status =
    control?.desired_state === 'connected' &&
    (!fresh || session.connection_status === 'disconnected')
      ? 'CONNECTING'
      : fresh && session.connection_status === 'connected'
        ? 'LIVE'
        : session.connection_message?.includes('thử')
          ? 'RECONNECTING'
          : session.connection_status === 'error'
            ? 'ERROR'
            : 'OFFLINE';
  async function command(desired) {
    if (busy) return;
    setBusy(true);
    setError('');
    if (request.current?.desired !== desired)
      request.current = { desired, id: crypto.randomUUID() };
    try {
      await repo.requestLiveConnection(session.id, desired, request.current.id);
      setNotice(
        desired === 'connected'
          ? 'Đã gửi yêu cầu. Supervisor trên máy vận hành sẽ kết nối và báo trạng thái thực tế.'
          : 'Đã yêu cầu ngắt. Chờ worker dừng và đối chiếu bình luận còn chờ gửi.',
      );
      request.current = null;
      onChanged();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const next = Math.max(0, ...commerce.campaign_customers.map((c) => c.customer_no)) + 1;
  return (
    <section className="live-operator-controls" aria-label="Điều khiển phiên live">
      <div className="live-operation-metrics">
        <span>
          <Wifi size={16} /> {session.provider === 'tiktok_live' ? status : 'THỦ CÔNG / MÔ PHỎNG'}
        </span>
        <span>Thời lượng: {liveDuration(session)}</span>
        <span>
          {metric?.comment_count ?? '—'} bình luận · {metric?.ticket_count ?? '—'} phiếu của phiên
        </span>
        <span>
          <Users size={16} /> {commerce.campaign_customers.length} STT đã cấp · số tiếp theo #
          {String(next).padStart(3, '0')}
        </span>
      </div>
      {canManage && session.provider === 'tiktok_live' && (
        <div className="foundation-actions">
          <button
            className="button primary"
            disabled={
              disabled || busy || session.status !== 'live' || campaign?.status !== 'active'
            }
            onClick={() => command('connected')}
          >
            <Power size={16} /> Kết nối TikTok
          </button>
          <button
            className="button secondary"
            disabled={disabled || busy}
            onClick={() => command('disconnected')}
          >
            Ngắt kết nối
          </button>
          <small>Cần chạy supervisor đã đăng nhập trên máy vận hành.</small>
        </div>
      )}
      <ErrorMessage error={error} />
      {notice && (
        <p role="status" className="sales-note">
          {notice}
        </p>
      )}
    </section>
  );
}

export function LiveStockPreview({ repo, sessionId, productId, date, qty }) {
  const [state, setState] = useState(null),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setState(null);
    setError('');
    if (productId && date)
      repo
        .liveStockPreview(sessionId, productId, date)
        .then((value) => {
          if (active) setState(value);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    return () => {
      active = false;
    };
  }, [repo, sessionId, productId, date]);
  if (!productId) return <p className="sales-note">Chọn SKU để xem hàng khả dụng.</p>;
  return (
    <div className="live-stock-preview" aria-live="polite">
      {state ? (
        <>
          <strong>Khả dụng theo ngày chốt: {state.available}</strong>
          <span>
            Tại kho: {state.on_hand} · đang giữ: {state.reserved}
          </span>
          {Number(qty) > state.available && (
            <b className="negative">Không đủ hàng theo số lượng đang chọn.</b>
          )}
        </>
      ) : (
        <span>{error || 'Đang kiểm tra hàng khả dụng…'}</span>
      )}
      <small>Thông tin tham khảo tại lần tải; máy chủ kiểm tra và khóa tồn lại khi chốt.</small>
    </div>
  );
}

const flags = [
  ['show_customer_number', 'STT khách'],
  ['show_username', 'Username nguồn'],
  ['show_product_code', 'Mã sản phẩm'],
  ['show_product_name', 'Tên sản phẩm'],
  ['show_variant', 'Màu / size'],
  ['show_qty', 'Số lượng'],
  ['show_price', 'Giá'],
  ['show_ticket_no', 'Mã phiếu'],
  ['show_timestamp', 'Thời điểm chốt'],
  ['auto_cut', 'Cắt giấy ESC/POS'],
];
const defaults = Object.fromEntries(flags.map(([key]) => [key, true]));

function PrinterProfileForm({ repo, profile, close, saved }) {
  const [value, setValue] = useState({
    id: profile?.profile_id || '',
    name: profile?.name || 'ZYWELL tại quầy',
    driver: profile?.driver || 'SYSTEM_PRINT',
    ip_address: profile?.ip_address?.replace('/32', '') || '',
    port: profile?.port || 9100,
    paper_width: profile?.paper_width || 80,
    is_default: profile?.is_default ?? true,
    enabled: profile?.enabled ?? true,
    settings: {
      ...defaults,
      font_scale_customer: 1,
      font_scale_product: 1,
      ...profile?.settings,
      copies: 1,
    },
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const request = useRef(null),
    lock = useRef(false);
  const change = (key) => (e) =>
    setValue({ ...value, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  async function submit(e) {
    e.preventDefault();
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    const payload = {
      ...value,
      ip_address: value.driver === 'ESC_POS' ? value.ip_address : null,
      port: Number(value.port),
      paper_width: Number(value.paper_width),
    };
    const signature = JSON.stringify(payload);
    if (request.current?.signature !== signature)
      request.current = { signature, id: crypto.randomUUID() };
    try {
      await repo.saveLivePrinter(payload, request.current.id);
      saved();
    } catch (failure) {
      setError(failure.message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <Modal title="Cấu hình máy và mẫu in" onClose={() => !lock.current && close()}>
      <form onSubmit={submit}>
        <fieldset className="sales-fieldset" disabled={busy}>
          <div className="form-body form-grid">
            <Field label="Tên máy in">
              <input required maxLength={200} value={value.name} onChange={change('name')} />
            </Field>
            <Field label="Driver máy in">
              <select value={value.driver} onChange={change('driver')}>
                <option value="SYSTEM_PRINT">USB / hệ thống</option>
                <option value="ESC_POS">LAN / WiFi · ESC/POS</option>
                <option value="MOCK">Mô phỏng</option>
                <option disabled>Bluetooth · cần native bridge</option>
                <option disabled>TSPL · chưa hỗ trợ</option>
              </select>
            </Field>
            {value.driver === 'ESC_POS' && (
              <>
                <Field label="IP nội bộ máy in">
                  <input
                    required
                    value={value.ip_address}
                    onChange={change('ip_address')}
                    placeholder="192.168.1.100"
                  />
                </Field>
                <Field label="Cổng máy in">
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    required
                    value={value.port}
                    onChange={change('port')}
                  />
                </Field>
              </>
            )}
            <Field label="Khổ giấy">
              <select value={value.paper_width} onChange={change('paper_width')}>
                <option value={80}>80 mm</option>
                <option value={58}>58 mm</option>
              </select>
            </Field>
            {['font_scale_customer', 'font_scale_product'].map((key, i) => (
              <Field key={key} label={i ? 'Cỡ mã sản phẩm' : 'Cỡ STT khách'}>
                <select
                  value={value.settings[key]}
                  onChange={(e) =>
                    setValue({
                      ...value,
                      settings: { ...value.settings, [key]: Number(e.target.value) },
                    })
                  }
                >
                  {[1, 2, 3].map((n) => (
                    <option key={n} value={n}>
                      {n}×
                    </option>
                  ))}
                </select>
              </Field>
            ))}
            <div className="span-2 live-template-options">
              {flags.map(([key, label]) => (
                <label className="checkbox" key={key}>
                  <input
                    type="checkbox"
                    checked={value.settings[key]}
                    onChange={(e) =>
                      setValue({
                        ...value,
                        settings: { ...value.settings, [key]: e.target.checked },
                      })
                    }
                  />
                  {label}
                </label>
              ))}
            </div>
            <label className="checkbox">
              <input type="checkbox" checked={value.enabled} onChange={change('enabled')} />
              Đang sử dụng
            </label>
            <label className="checkbox">
              <input type="checkbox" checked={value.is_default} onChange={change('is_default')} />
              Mẫu mặc định cho phiếu mới
            </label>
            <p className="sales-note span-2">
              Một bản mỗi lần in; dùng in lại có đối soát khi cần thêm. LAN dùng raster chữ Việt,
              USB dùng driver hệ thống. IP này là hồ sơ cấu hình; quản trị viên cần đặt cùng IP
              trong bridge local.
            </p>
            <div className="span-2">
              <ErrorMessage error={error} />
            </div>
          </div>
        </fieldset>
        <footer className="modal-actions">
          <button type="button" className="button secondary" disabled={busy} onClick={close}>
            Đóng
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? 'Đang lưu…' : 'Lưu cấu hình máy in'}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

export function LivePrinterProfiles({
  repo,
  operations,
  canManage,
  onChanged,
  onModalChange,
  onSelect,
}) {
  const [editing, setEditing] = useState(undefined);
  useEffect(() => {
    onModalChange?.(editing !== undefined);
    return () => onModalChange?.(false);
  }, [editing, onModalChange]);
  return (
    <Panel
      title="Máy in và mẫu phiếu dùng chung"
      note="Cấu hình được lưu theo workspace. Phiếu đã chốt giữ nguyên mẫu lúc tạo; thay đổi chỉ áp dụng cho phiếu mới."
      action={
        canManage && (
          <button className="button secondary" onClick={() => setEditing(null)}>
            Thêm cấu hình máy in
          </button>
        )
      }
    >
      <div className="live-printer-profiles">
        {!operations.printers?.length && <p>Chưa lưu cấu hình; phiếu dùng mẫu 80 mm mặc định.</p>}
        {operations.printers?.map((p) => (
          <article key={p.profile_id}>
            <div>
              <strong>
                <Printer size={17} />
                {p.name}
              </strong>
              <small>
                {p.driver} · {p.paper_width} mm · {p.is_default ? 'Mặc định' : 'Phụ'} ·{' '}
                {p.enabled ? 'Đang dùng' : 'Đã tắt'}
              </small>
            </div>
            <div className="foundation-actions">
              <button className="button secondary" onClick={() => onSelect(p)}>
                Xem mẫu cấu hình
              </button>
              {canManage && (
                <button className="button secondary" onClick={() => setEditing(p)}>
                  Sửa cấu hình
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
      {editing !== undefined && (
        <PrinterProfileForm
          repo={repo}
          profile={editing}
          close={() => setEditing(undefined)}
          saved={() => {
            setEditing(undefined);
            onChanged();
          }}
        />
      )}
    </Panel>
  );
}
