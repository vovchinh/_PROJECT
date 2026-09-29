import { useEffect, useId, useRef, useState } from 'react';
import { Check, Clock3, MessageCircle, Music2, Plug, Plus, Printer, Users } from 'lucide-react';
import { ErrorMessage, Panel } from '../components.jsx';
import { normalizeTikTokUsername } from '../lib/tiktok-username.js';
import './tiktok-channels.css';

const emptyChannels = [];
const states = {
  OFFLINE: ['Chưa kết nối', 'Bật LIVE trên TikTok rồi bấm KẾT NỐI LIVE.'],
  CONNECTING: ['Đang kết nối', 'Đang kiểm tra LIVE và tự động nhận bình luận.'],
  LIVE: ['Đã kết nối LIVE', 'Bình luận được cập nhật khi hệ thống nhận được từ TikTok.'],
  RECONNECTING: ['Đang kết nối lại', 'Kết nối bị gián đoạn. Đang chờ nhận lại phiên LIVE.'],
  ERROR: ['Chưa kết nối được', 'Kiểm tra kênh đã bật LIVE rồi thử kết nối lại.'],
  TIMEOUT: [
    'Chưa xác nhận được kết nối',
    'Đã chờ 90 giây. Kiểm tra ứng dụng nhận LIVE trên máy quầy rồi bấm THỬ KẾT NỐI LẠI.',
  ],
  NOT_LIVE: ['Kênh chưa bật LIVE', 'Vui lòng bật live'],
};

function requestFor(ref, signature) {
  if (ref.current?.signature !== signature) ref.current = { signature, id: crypto.randomUUID() };
  return ref.current.id;
}

function ChannelRow({ channel, index, multiple, canManage, onSave, onCancel }) {
  const id = useId();
  const [editing, setEditing] = useState(!channel.id);
  const [username, setUsername] = useState(channel.username || '');
  const [isDefault, setIsDefault] = useState(channel.is_default === true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const request = useRef(null);

  useEffect(() => {
    if (!editing) {
      setUsername(channel.username || '');
      setIsDefault(channel.is_default === true);
    }
  }, [channel.username, channel.is_default, editing]);

  async function save(event, asNew = false) {
    event.preventDefault();
    if (lock.current || !canManage || !editing) return;
    let normalized;
    try {
      normalized = normalizeTikTokUsername(username);
    } catch {
      setError(
        'TikTok ID tối đa 24 ký tự, gồm chữ thường, số, dấu gạch dưới và dấu chấm; không bắt đầu hoặc kết thúc bằng dấu chấm.',
      );
      return;
    }
    const payload = {
      ...(channel.id && !asNew ? { id: channel.id } : {}),
      username: normalized,
      ...(channel.display_name ? { display_name: channel.display_name } : {}),
      is_default: multiple ? isDefault : true,
      is_active: channel.is_active !== false,
    };
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await onSave(payload, requestFor(request, JSON.stringify(payload)));
      request.current = null;
      setUsername(normalized);
      setEditing(false);
    } catch (failure) {
      setError(failure.message || 'Chưa lưu được TikTok ID. Hãy thử lại.');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  function cancel() {
    if (lock.current) return;
    setUsername(channel.username || '');
    setIsDefault(channel.is_default === true);
    setError('');
    request.current = null;
    if (!channel.id) onCancel?.();
    else setEditing(false);
  }

  return (
    <form className="tiktok-channel-row" onSubmit={save} aria-busy={busy}>
      <div className="tiktok-channel-label">
        <label htmlFor={id}>TikTok ID {index + 1}</label>
        {channel.is_default && (
          <span className="tiktok-default">
            <Check size={13} /> Mặc định
          </span>
        )}
        {channel.is_active === false && <span className="tiktok-inactive">Đã tắt</span>}
      </div>
      <div className="tiktok-id-control">
        <span className="tiktok-id-prefix" aria-hidden="true">
          @
        </span>
        <input
          id={id}
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          placeholder="chidi.vibes2"
          maxLength={25}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          readOnly={!editing || !canManage}
          disabled={busy}
          aria-describedby={`${id}-hint`}
        />
        {canManage &&
          (editing ? (
            <button key="save" className="button primary" type="submit" disabled={busy}>
              {busy ? 'ĐANG LƯU…' : 'LƯU'}
            </button>
          ) : (
            <button
              key="edit"
              className="button primary"
              type="button"
              onClick={(event) => {
                event.preventDefault();
                setEditing(true);
                setError('');
              }}
            >
              SỬA
            </button>
          ))}
      </div>
      <p className="tiktok-field-hint" id={`${id}-hint`}>
        Tên người dùng chỉ chứa chữ thường, số, dấu gạch dưới và dấu chấm.
      </p>
      {canManage && editing && (
        <div className="tiktok-edit-options">
          {multiple && (
            <label>
              <input
                type="checkbox"
                checked={isDefault}
                disabled={busy}
                onChange={(event) => setIsDefault(event.target.checked)}
              />{' '}
              Chọn làm kênh mặc định
            </label>
          )}
          {(channel.id || onCancel) && (
            <button type="button" className="tiktok-text-button" disabled={busy} onClick={cancel}>
              Hủy
            </button>
          )}
        </div>
      )}
      <ErrorMessage error={error} />
      {canManage && editing && channel.id && error.includes('TIKTOK_CHANNEL_USED') && (
        <div className="tiktok-channel-notice">
          <p>
            Để giữ đúng nguồn của phiên và phiếu cũ, bạn có thể lưu tên vừa nhập thành một TikTok ID
            mới.
          </p>
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={(event) => save(event, true)}
          >
            LƯU THÀNH TIKTOK ID MỚI
          </button>
        </div>
      )}
    </form>
  );
}

export function TikTokChannelSettings({ repo, state, onChanged, canManage = false }) {
  const channels = state?.channels || emptyChannels;
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState('');
  async function save(payload, requestId) {
    await repo.saveTikTokChannel(payload, requestId);
    await onChanged?.();
    setAdding(false);
    setNotice('Đã lưu TikTok ID. Chọn kênh này tại màn hình LIVE để kết nối.');
  }
  return (
    <Panel title="Quản lý kênh TikTok" className="tiktok-channel-settings">
      <div className="tiktok-channel-settings-body">
        {channels.map((channel, index) => (
          <ChannelRow
            key={channel.id}
            channel={channel}
            index={index}
            multiple={channels.length > 1}
            canManage={canManage}
            onSave={save}
          />
        ))}
        {canManage && (adding || !channels.length) && (
          <ChannelRow
            key="new-channel"
            channel={{ is_default: !channels.length, is_active: true }}
            index={channels.length}
            multiple={channels.length > 0}
            canManage
            onSave={save}
            onCancel={channels.length ? () => setAdding(false) : undefined}
          />
        )}
        {!canManage && !channels.length && (
          <p>Chưa có TikTok ID. Nhờ chủ shop thêm kênh để bắt đầu.</p>
        )}
        {canManage && channels.length > 0 && !adding && (
          <button
            className="button primary tiktok-add-channel"
            type="button"
            onClick={() => {
              setAdding(true);
              setNotice('');
            }}
          >
            <Plus size={18} /> THÊM TIKTOK ID
          </button>
        )}
        {notice && (
          <p className="tiktok-channel-notice" role="status">
            {notice}
          </p>
        )}
      </div>
    </Panel>
  );
}

function knownCount(value) {
  if (typeof value === 'string' && /^\d+$/u.test(value)) value = Number(value);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function timestamp(value) {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function durationText(start, end) {
  if (start == null || end == null || end < start) return '—';
  const seconds = Math.floor((end - start) / 1000);
  return [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
}

const diagnosticErrors = {
  TIKTOK_USER_INVALID: 'TikTok ID không hợp lệ.',
  TIKTOK_NOT_LIVE: 'Vui lòng bật live',
  TIKTOK_ROOM_LOOKUP_FAILED: 'Chưa tìm được phòng LIVE.',
  TIKTOK_CONNECT_TIMEOUT: 'Kết nối TikTok quá thời gian chờ.',
  TIKTOK_WEBSOCKET_FAILED: 'Đường truyền TikTok bị gián đoạn.',
  TIKTOK_PROVIDER_RATE_LIMITED: 'TikTok giới hạn lượt truy cập; chờ rồi thử lại.',
  TIKTOK_SIGNING_REQUIRED: 'Nguồn TikTok yêu cầu cấu hình xác thực tại ứng dụng nhận LIVE.',
  TIKTOK_PROVIDER_ACCESS_DENIED: 'Nguồn TikTok từ chối kết nối.',
  TIKTOK_PROVIDER_UNAVAILABLE: 'Nguồn TikTok tạm thời không truy cập được.',
  TIKTOK_PROVIDER_PROTOCOL_CHANGED: 'Định dạng nguồn TikTok thay đổi; cần kiểm tra bộ nhận.',
  TIKTOK_PROVIDER_VERSION_MISMATCH: 'Phiên bản bộ nhận TikTok chưa phù hợp.',
  TIKTOK_PROVIDER_PACKAGE_MISSING: 'Ứng dụng nhận LIVE thiếu bộ kết nối TikTok.',
  TIKTOK_ROOM_CHANGED: 'Phòng LIVE đã thay đổi; hãy kết nối lại.',
  TIKTOK_LISTENER_OFFLINE: 'Ứng dụng nhận LIVE chưa hoạt động.',
  TIKTOK_SESSION_CONFLICT: 'Phiên LIVE đang được một tiến trình khác xử lý.',
  TIKTOK_SUPABASE_UNAVAILABLE: 'Ứng dụng nhận LIVE chưa truy cập được dữ liệu.',
  TIKTOK_INGEST_FAILED: 'Chưa lưu được dữ liệu LIVE; kiểm tra ứng dụng nhận.',
  SUPABASE_INGEST_FAILED: 'Chưa lưu được dữ liệu LIVE; kiểm tra ứng dụng nhận.',
  CHANNEL_CONTROL_UNAVAILABLE: 'Chưa đọc được yêu cầu kết nối.',
  CHANNEL_RETRY_LIMIT: 'Đã hết lượt tự thử; kiểm tra rồi kết nối lại.',
  CHANNEL_END_REPORT_PENDING: 'Đang chờ xác nhận phiên đã kết thúc.',
};

function displayTime(value) {
  const instant = timestamp(value);
  return instant == null ? 'Chưa có thông tin' : new Date(instant).toLocaleString('vi-VN');
}

export function TikTokLiveHome({
  repo,
  state,
  onChanged,
  onSession,
  onChannelChange,
  onManageChannels,
  canOperate = false,
  canManage = false,
  runtime,
  runtimeError = '',
  printerStatus,
  metrics = {},
}) {
  const channels = (state?.channels || emptyChannels).filter(
    (channel) => channel.is_active !== false,
  );
  const [selectedId, setSelectedId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [now, setNow] = useState(Date.now);
  const lock = useRef(false);
  const request = useRef(null);
  const enteredSession = useRef(null);
  const pendingSince = useRef(null);
  const mounted = useRef(false);
  const commandAbort = useRef(null);
  const durationHistory = useRef(new Map());
  const channelChanged = useRef(onChannelChange);
  channelChanged.current = onChannelChange;
  const selected =
    channels.find((channel) => channel.id === selectedId) ||
    channels.find((channel) => channel.is_default) ||
    channels[0];
  const connection = state?.connections?.find((item) => item.channel_id === selected?.id);
  const reportedStatus = Object.hasOwn(states, connection?.connection_status || '')
    ? connection.connection_status
    : 'OFFLINE';
  const heartbeatAge = now - Date.parse(connection?.heartbeat_at || '');
  const freshHeartbeat =
    Number.isFinite(heartbeatAge) && heartbeatAge >= -30000 && heartbeatAge < 90000;
  let status =
    reportedStatus === 'LIVE' && !freshHeartbeat
      ? connection?.desired_state === 'connected'
        ? 'RECONNECTING'
        : 'OFFLINE'
      : reportedStatus;
  const pendingKey = `${selected?.id}:${connection?.revision}:${status}`;
  if (pendingSince.current?.key !== pendingKey) pendingSince.current = { key: pendingKey, at: now };
  const pendingAt = timestamp(connection?.requested_at) ?? pendingSince.current.at;
  const staleAt = timestamp(connection?.heartbeat_at) ?? pendingAt;
  if (connection?.message_code === 'room_not_live') status = 'NOT_LIVE';
  else if (
    ['CONNECTING', 'RECONNECTING'].includes(status) &&
    now - (reportedStatus === 'LIVE' ? staleAt : pendingAt) >= 90000
  )
    status = 'TIMEOUT';
  const [statusLabel, defaultNote] = states[status];
  const statusNote =
    connection?.message_code === 'room_not_live'
      ? 'Vui lòng bật live'
      : connection?.message_code === 'live_ended'
        ? 'Phiên TikTok đã kết thúc. Đã tự động ngắt kết nối.'
        : defaultNote;
  const connected = status === 'LIVE';
  const waiting = ['CONNECTING', 'RECONNECTING'].includes(status);
  const listenerOffline = runtime?.listener?.online === false;

  useEffect(() => {
    mounted.current = true;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      mounted.current = false;
      clearInterval(timer);
      commandAbort.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (selected?.id !== selectedId) setSelectedId(selected?.id || '');
  }, [selected?.id, selectedId]);

  // Clear the previous feed before entering a newly confirmed LIVE session.
  // Polling and callback identity changes must not clear an unchanged channel.
  useEffect(() => {
    channelChanged.current?.(selected?.id || null);
  }, [selected?.id]);

  useEffect(() => {
    const sessionId = connected ? connection?.current_session_id : null;
    if (!sessionId) {
      enteredSession.current = null;
      return;
    }
    const key = `${selected?.id}:${sessionId}`;
    if (enteredSession.current !== key && onSession) {
      enteredSession.current = key;
      onSession(sessionId, selected.id);
    }
  }, [connected, connection?.current_session_id, selected?.id, onSession]);

  async function command(desired) {
    if (lock.current || !selected || !canOperate) return;
    lock.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    const controller = new AbortController();
    commandAbort.current = controller;
    try {
      const signature = JSON.stringify({ channel: selected.id, desired });
      await repo.requestTikTokConnection(selected.id, desired, requestFor(request, signature), {
        signal: controller.signal,
      });
      if (!mounted.current) return;
      await onChanged?.();
      request.current = null;
      setNotice(
        desired === 'connected'
          ? 'Đang kiểm tra LIVE và tự động nhận bình luận; không cần phê duyệt.'
          : 'Đã yêu cầu ngắt kết nối. Chờ hệ thống xác nhận đã dừng.',
      );
    } catch (failure) {
      if (mounted.current) setError(failure.message || 'Chưa gửi được yêu cầu. Hãy thử lại.');
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
      commandAbort.current = null;
    }
  }

  const values =
    typeof metrics === 'function'
      ? selected
        ? metrics(selected.id, connection?.current_session_id || null)
        : {}
      : metrics;
  const scopedMetrics =
    values?.session_id && values.session_id !== connection?.current_session_id ? {} : values || {};
  const customerCount = knownCount(scopedMetrics.customer_count);
  const nextCustomer = knownCount(scopedMetrics.next_customer_no);
  const comments = knownCount(scopedMetrics.comments ?? scopedMetrics.comment_count);
  const items = knownCount(
    scopedMetrics.itemcount ?? scopedMetrics.item_count ?? scopedMetrics.qty,
  );
  const durationKey = `${selected?.id}:${connection?.current_session_id || ''}`;
  const previousDuration = durationHistory.current.get(durationKey);
  const startedAt =
    timestamp(scopedMetrics.started_at) ??
    timestamp(connection?.connected_since) ??
    previousDuration?.start ??
    null;
  const endedAt = timestamp(scopedMetrics.ended_at);
  const requestedAt = timestamp(connection?.requested_at);
  const heartbeatAt = timestamp(connection?.heartbeat_at);
  // Disconnect freezes the last known interval without writing a synthetic end to the database.
  const durationEnd =
    startedAt == null
      ? null
      : (endedAt ??
        (connected && scopedMetrics.session_status !== 'ended'
          ? now
          : requestedAt != null &&
              requestedAt >= startedAt &&
              connection?.desired_state === 'disconnected'
            ? requestedAt
            : (previousDuration?.end ??
              (heartbeatAt != null && heartbeatAt >= startedAt ? heartbeatAt : null))));
  if (startedAt != null && durationEnd != null)
    durationHistory.current.set(durationKey, { start: startedAt, end: durationEnd });
  const duration = durationText(startedAt, durationEnd);
  const telemetry =
    runtime?.telemetry &&
    connection?.current_session_id &&
    runtime.telemetry.session_id === connection.current_session_id
      ? runtime.telemetry
      : null;
  const viewers = knownCount(telemetry?.current_viewer_count);
  const peakViewers = knownCount(telemetry?.peak_viewer_count);
  const viewerTime = timestamp(telemetry?.last_viewer_update_at);
  const viewersStale = viewers != null && (viewerTime == null || now - viewerTime >= 45000);
  const diagnostic = canManage ? runtime?.diagnostics : null;
  const providerVersion = /^\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?$/iu.test(
    diagnostic?.provider_version || '',
  )
    ? diagnostic.provider_version
    : 'Chưa có thông tin';
  return (
    <div className="tiktok-live-home">
      <section className="tiktok-connect-card" aria-label="Kết nối TikTok LIVE" aria-busy={busy}>
        <div className="tiktok-live-mark" aria-hidden="true">
          <Music2 size={47} strokeWidth={2.6} />
          <span>LIVE</span>
        </div>
        <div className={`tiktok-connection-status ${status.toLowerCase()}`} role="status">
          <i aria-hidden="true" /> {statusLabel}
        </div>
        <h2>
          {connected
            ? `Đang nhận LIVE của @${selected?.username || ''}`
            : 'Bật LIVE trên TikTok và bấm kết nối'}
        </h2>
        <p className="tiktok-connect-note">{statusNote}</p>
        {listenerOffline && !connected && (
          <p className="tiktok-runtime-note">
            Ứng dụng nhận LIVE trên máy quầy chưa hoạt động hoặc mất kết nối. Mở ứng dụng nhận LIVE
            rồi thử lại.
          </p>
        )}
        {runtimeError && (
          <p className="tiktok-runtime-note">
            Chưa đọc được dữ liệu theo dõi LIVE.
            {canManage && runtimeError.includes('012_')
              ? ' Kiểm tra migration 012 rồi tải lại; không chạy lại migration lịch sử.'
              : ' Nhờ chủ shop kiểm tra kết nối dữ liệu.'}
          </p>
        )}
        {channels.length > 0 ? (
          <div className="tiktok-connect-actions">
            {channels.length > 1 ? (
              <label className="tiktok-channel-picker">
                <span>Kênh TikTok</span>
                <select
                  aria-label="Chọn kênh TikTok"
                  value={selected?.id || ''}
                  disabled={busy}
                  onChange={(event) => {
                    setSelectedId(event.target.value);
                    setError('');
                    setNotice('');
                    request.current = null;
                  }}
                >
                  {channels.map((channel) => (
                    <option key={channel.id} value={channel.id}>
                      @{channel.username}
                      {channel.is_default ? ' · Mặc định' : ''}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <div className="tiktok-single-channel">
                <span>Kênh TikTok</span>
                <strong>@{selected.username}</strong>
              </div>
            )}
            <button
              className="button tiktok-connect-button"
              type="button"
              disabled={!canOperate || busy || connected || waiting}
              onClick={() => command('connected')}
            >
              <Plug size={19} />
              {busy
                ? 'ĐANG GỬI…'
                : waiting
                  ? 'ĐANG KẾT NỐI…'
                  : connected
                    ? 'ĐÃ KẾT NỐI'
                    : status === 'TIMEOUT'
                      ? 'THỬ KẾT NỐI LẠI'
                      : 'KẾT NỐI LIVE'}
            </button>
          </div>
        ) : (
          <p className="tiktok-empty-channels">
            Thêm TikTok ID trong Quản lý kênh TikTok để bắt đầu.
          </p>
        )}
        {selected &&
          (connected || waiting || connection?.desired_state === 'connected') &&
          canOperate && (
            <button
              type="button"
              className="tiktok-text-button tiktok-disconnect"
              disabled={busy}
              onClick={() => command('disconnected')}
            >
              Ngắt kết nối
            </button>
          )}
        {onManageChannels && (
          <button
            type="button"
            className="tiktok-text-button"
            disabled={busy}
            onClick={onManageChannels}
          >
            Đổi TikTok ID
          </button>
        )}
        <ErrorMessage error={error} />
        {notice && waiting && (
          <p className="tiktok-channel-notice" role="status">
            {notice}
          </p>
        )}
      </section>
      <div className="tiktok-live-metrics" aria-label="Thông tin phiên LIVE">
        <div>
          <Clock3 size={17} />
          <span>Thời lượng</span>
          <strong>{duration}</strong>
        </div>
        <div aria-label="Người đang xem">
          <Users size={17} />
          <span>Người đang xem</span>
          <strong>{viewers ?? '—'}</strong>
          {viewersStale && <small className="tiktok-metric-stale">Dữ liệu chưa cập nhật</small>}
        </div>
        <div aria-label="Người xem cao nhất">
          <Users size={17} />
          <span>Người xem cao nhất</span>
          <strong>{peakViewers ?? '—'}</strong>
        </div>
        <div>
          <MessageCircle size={17} />
          <span>Bình luận</span>
          <strong>{comments ?? '—'}</strong>
        </div>
        <div>
          <Check size={17} />
          <span>Sản phẩm đã chốt</span>
          <strong>{items ?? '—'}</strong>
        </div>
        <div>
          <Printer size={17} />
          <span>Máy in</span>
          <strong>
            {typeof printerStatus === 'string' && printerStatus ? printerStatus : 'Chưa kiểm tra'}
          </strong>
        </div>
      </div>
      {canManage && (
        <details className="tiktok-diagnostics">
          <summary>Kiểm tra kết nối LIVE</summary>
          <dl>
            <dt>Ứng dụng nhận LIVE</dt>
            <dd>
              {runtime?.listener
                ? runtime.listener.online
                  ? runtime.listener.ready
                    ? 'Sẵn sàng'
                    : 'Đang khởi động'
                  : 'Chưa hoạt động'
                : 'Chưa có thông tin'}
            </dd>
            <dt>Phiên bản bộ nhận</dt>
            <dd>{providerVersion}</dd>
            <dt>Số tiến trình hoạt động</dt>
            <dd>{knownCount(diagnostic?.active_listener_count) ?? 'Chưa có thông tin'}</dd>
            <dt>Bắt đầu ứng dụng</dt>
            <dd>{displayTime(diagnostic?.started_at)}</dd>
            <dt>Phản hồi gần nhất</dt>
            <dd>{displayTime(runtime?.listener?.heartbeat_at)}</dd>
            <dt>Sự cố gần nhất</dt>
            <dd>
              {Object.hasOwn(diagnosticErrors, diagnostic?.last_error_code || '')
                ? diagnosticErrors[diagnostic.last_error_code]
                : 'Chưa có thông tin'}
            </dd>
            <dt>Sự kiện nguồn gần nhất</dt>
            <dd>{displayTime(telemetry?.last_provider_event_at)}</dd>
            <dt>Lưu dữ liệu gần nhất</dt>
            <dd>{displayTime(telemetry?.last_ingest_at)}</dd>
          </dl>
        </details>
      )}
      <section className="tiktok-customer-numbers" aria-label="Số thứ tự khách hàng">
        <h2>Số thứ tự khách hàng</h2>
        <div>
          <span className="tiktok-customer-icon">
            <Users size={23} />
          </span>
          <span>
            Khách đã có STT<strong>{customerCount == null ? '—' : `${customerCount} khách`}</strong>
          </span>
        </div>
        <div>
          <span className="tiktok-customer-icon next">
            <Plus size={23} />
          </span>
          <span>
            Khách mới sẽ nhận
            <strong>
              {nextCustomer != null && nextCustomer > 0
                ? `STT ${String(nextCustomer).padStart(3, '0')}`
                : '—'}
            </strong>
          </span>
        </div>
        <p>Số thứ tự được cấp khi chốt hàng; cùng khách trong chiến dịch giữ cùng một số.</p>
      </section>
    </div>
  );
}
