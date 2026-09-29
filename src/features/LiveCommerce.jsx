import { useCallback, useEffect, useRef, useState } from 'react';
import { Panel, Table, Modal, Field, Select, ErrorMessage } from '../components.jsx';
import { today } from '../lib/domain.js';
import { parseLiveComment } from '../lib/live-parser.js';
import { prepareBrowserPrint, sendToLanBridge, probeLanBridge } from '../lib/print-bridge.js';
import {
  BarChart3,
  CalendarDays,
  ChevronRight,
  MessageSquare,
  Music2,
  Printer,
  Radio,
  RefreshCw,
  Search,
  Settings2,
  ShoppingBasket,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { summarizeLiveCarts } from '../lib/live-view.js';
import {
  LiveQuickStats,
  LiveSessionHistory,
  LiveCampaignReport,
  LiveCartList,
  LiveCartDetail,
} from './LiveInsights.jsx';
import './live-commerce.css';
import LivePrinterPreview from './LivePrinterPreview.jsx';
import { LiveOperatorControls, LiveStockPreview, LivePrinterProfiles } from './LiveOperations.jsx';
import { TikTokChannelSettings, TikTokLiveHome } from './TikTokChannels.jsx';

const money = (value = 0) =>
  new Intl.NumberFormat('vi-VN', {
    style: 'currency',
    currency: 'VND',
    maximumFractionDigits: 0,
  }).format(BigInt(value));
const find = (rows = [], id) => rows.find((r) => r.id === id);
const choice = (...pairs) => pairs.map(([id, name]) => ({ id, name }));
const field = (key, label, options = {}) => ({
  key,
  label,
  required: true,
  maxLength: 200,
  ...options,
});
const dropdown = (key, label, items, options = {}) =>
  field(key, label, { type: 'select', items, ...options });
const noteField = (key = 'reason', label = 'Lý do') =>
  field(key, label, { type: 'textarea', minLength: 10, maxLength: 2000 });
const statusText = {
  draft: 'Nháp',
  active: 'Đang mở',
  closed: 'Đã đóng',
  live: 'Đang live',
  ended: 'Đã kết thúc',
  queued: 'Chờ in',
  printing: 'Đang xử lý in',
  printed: 'Đã xác nhận giấy',
  failed: 'Cần kiểm tra / in lại',
  cancelled: 'Đã hủy',
  committed: 'Đã chốt',
  voided: 'Đã VOID',
  new: 'Chưa chốt',
  ignored: 'Đã bỏ qua',
};
const parseText = {
  unique: 'Có gợi ý SKU — cần kiểm tra',
  ambiguous: 'Nhiều SKU phù hợp — chọn rõ',
  needs_review: 'SKU chưa đối chiếu',
  no_match: 'Cần chọn SKU thủ công',
};
const emptyCommerce = {
  campaign_customers: [],
  carts: [],
  items: [],
  tickets: [],
  print_jobs: [],
  print_attempts: [],
};

function Form({ config, close, done }) {
  const [value, setValue] = useState(config.value),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const request = useRef(null),
    lock = useRef(false);
  async function submit(e) {
    e.preventDefault();
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    const signature = JSON.stringify(value);
    if (request.current?.signature !== signature)
      request.current = { signature, id: crypto.randomUUID() };
    try {
      await config.save(value, request.current.id);
      done();
    } catch (e) {
      setError(e.message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <Modal title={config.title} description={config.note} onClose={() => !lock.current && close()}>
      <form onSubmit={submit}>
        <fieldset className="sales-fieldset" disabled={busy}>
          <div className="form-body form-grid">
            {config.fields.map(({ key, label, type = 'text', items, ...attrs }) => (
              <Field key={key} label={label} span={type === 'textarea'}>
                {type === 'select' ? (
                  <Select
                    aria-label={label}
                    {...attrs}
                    items={typeof items === 'function' ? items(value) : items}
                    value={value[key] ?? ''}
                    onChange={(e) => setValue({ ...value, [key]: e.target.value })}
                  />
                ) : type === 'textarea' ? (
                  <textarea
                    {...attrs}
                    rows={4}
                    value={value[key] ?? ''}
                    onChange={(e) => setValue({ ...value, [key]: e.target.value })}
                  />
                ) : (
                  <input
                    {...attrs}
                    type={type}
                    value={value[key] ?? ''}
                    onChange={(e) => setValue({ ...value, [key]: e.target.value })}
                  />
                )}
              </Field>
            ))}
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
            {busy ? 'Đang xử lý…' : config.submit || 'Lưu'}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

function CommitForm({
  comment,
  claim,
  suggestion,
  context,
  products,
  commit,
  close,
  printerMode,
  repo,
  enhanced,
}) {
  const [value, setValue] = useState({
    comment_id: comment.id,
    claim_token: claim.claim_token,
    product_id: suggestion.product_id || '',
    qty: String(suggestion.quantity || 1),
    unit_price: '',
    customer_id: '',
    date: today(),
    review_note: '',
  });
  const [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const request = useRef(null),
    lock = useRef(false);
  const change = (key) => (e) => {
    setValue({ ...value, [key]: e.target.value });
    setConfirmed(false);
  };
  const eligible = products.filter(
    (p) =>
      !p.provisional &&
      context.catalog.variants.some(
        (v) => v.product_id === p.id && v.mapping_status === 'confirmed',
      ),
  );
  async function submit(e) {
    e.preventDefault();
    if (lock.current || !confirmed) return;
    lock.current = true;
    setBusy(true);
    setError('');
    const payload = { ...value, customer_id: value.customer_id || null };
    const signature = JSON.stringify(payload);
    if (request.current?.signature !== signature)
      request.current = { signature, id: crypto.randomUUID() };
    // Popup must open synchronously on seller action, before the database call.
    // A blocked popup never undoes a successfully committed business ticket.
    let popup = null;
    if (printerMode === 'browser') {
      try {
        popup = prepareBrowserPrint({ paperWidth: 80 });
      } catch {
        /* queue remains available */
      }
    }
    try {
      await commit(payload, request.current.id, popup);
    } catch (e) {
      popup?.close();
      setError(e.message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Kiểm tra và CHỐT & IN"
      description="Chốt tạo phiếu, giữ hàng và giỏ khách cùng một giao dịch. In giấy được xử lý sau đó."
      onClose={() => !lock.current && close()}
    >
      <form onSubmit={submit}>
        <fieldset className="sales-fieldset" disabled={busy}>
          <div className="form-body">
            <blockquote className="live-comment-text">
              {comment.author_display_name}: {comment.raw_text}
            </blockquote>
            <p className="sales-note">
              {parseText[suggestion.status]}. Giá bán cần được người bán nhập rõ. Quyền nhận bình
              luận có thời hạn; máy chủ kiểm tra lại khi chốt.
            </p>
            <div className="form-grid">
              <Field label="SKU xác nhận">
                <Select
                  aria-label="SKU xác nhận"
                  required
                  items={eligible}
                  value={value.product_id}
                  onChange={change('product_id')}
                />
              </Field>
              <Field label="Số lượng chốt">
                <input
                  type="number"
                  required
                  min="1"
                  max="1000"
                  step="1"
                  value={value.qty}
                  onChange={change('qty')}
                />
              </Field>
              <Field label="Giá bán mỗi sản phẩm (VND)">
                <input
                  type="number"
                  required
                  min="1"
                  max="9000000000000"
                  step="1"
                  value={value.unit_price}
                  onChange={change('unit_price')}
                />
              </Field>
              <Field label="Ngày chốt">
                <input
                  type="date"
                  required
                  max={today()}
                  value={value.date}
                  onChange={change('date')}
                />
              </Field>
              <Field label="Liên kết khách ERP (nếu đã xác minh)">
                <Select
                  aria-label="Liên kết khách ERP (nếu đã xác minh)"
                  items={context.customers}
                  value={value.customer_id}
                  onChange={change('customer_id')}
                />
              </Field>
              <Field label="Căn cứ kiểm tra" span>
                <textarea
                  required
                  minLength={10}
                  maxLength={2000}
                  rows={2}
                  value={value.review_note}
                  onChange={change('review_note')}
                />
              </Field>
            </div>
            {enhanced && (
              <LiveStockPreview
                repo={repo}
                sessionId={comment.session_id}
                productId={value.product_id}
                date={value.date}
                qty={value.qty}
              />
            )}
            <label className="checkbox">
              <input
                type="checkbox"
                required
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              <span>
                Tôi đã kiểm tra đúng khách, SKU, số lượng và giá bán; đồng ý chốt và giữ hàng.
              </span>
            </label>
            <ErrorMessage error={error} />
          </div>
        </fieldset>
        <footer className="modal-actions">
          <button type="button" className="button secondary" disabled={busy} onClick={close}>
            Bỏ nhận bình luận
          </button>
          <button className="button primary" disabled={busy || !confirmed}>
            {busy ? 'Đang chốt…' : 'CHỐT & IN'}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

function PrintConfirmation({ job, finish, close }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [checked, setChecked] = useState(false);
  const request = useRef({});
  async function record(outcome) {
    if (busy || (outcome === 'printed' && !checked)) return;
    setBusy(true);
    setError('');
    request.current[outcome] ||= crypto.randomUUID();
    try {
      await finish(outcome, request.current[outcome]);
      close();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`Đối chiếu giấy · ${job.snapshot.ticket_no}`}
      onClose={() => !busy && record('unknown')}
    >
      <div className="form-body">
        <p>
          Phiếu đã chốt và hàng đã giữ. Đóng hộp thoại in hoặc gửi tới máy in chưa chứng minh giấy
          đã ra.
        </p>
        <p>
          <strong>Rổ #{String(job.snapshot.customer_no).padStart(3, '0')}</strong> ·{' '}
          {job.snapshot.customer_name}
        </p>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={checked}
            disabled={busy}
            onChange={(e) => setChecked(e.target.checked)}
          />
          <span>Tôi đã nhìn thấy giấy in đúng phiếu này.</span>
        </label>
        <ErrorMessage error={error} />
      </div>
      <footer className="modal-actions">
        <button className="button secondary" disabled={busy} onClick={() => record('unknown')}>
          Chưa rõ / đã hủy in
        </button>
        <button className="button secondary" disabled={busy} onClick={() => record('failed')}>
          Máy in lỗi
        </button>
        <button
          className="button primary"
          disabled={busy || !checked}
          onClick={() => record('printed')}
        >
          Xác nhận giấy đã in
        </button>
      </footer>
    </Modal>
  );
}

export default function LiveCommerce({ repo, data, onModalChange }) {
  const [view, setView] = useState('board'),
    [sessionId, setSessionId] = useState(''),
    [cursor, setCursor] = useState(null),
    [revision, setRevision] = useState(0),
    [contextRevision, setContextRevision] = useState(0);
  const [state, setState] = useState(null),
    [context, setContext] = useState(null),
    [error, setError] = useState(''),
    [loadError, setLoadError] = useState(''),
    [contextError, setContextError] = useState(''),
    [notice, setNotice] = useState(''),
    [connection, setConnection] = useState('CONNECTING');
  const [form, setForm] = useState(null),
    [commitForm, setCommitForm] = useState(null),
    [cartDetailId, setCartDetailId] = useState(null),
    [printJob, setPrintJob] = useState(null),
    [working, setWorking] = useState(false);
  const [commentQuery, setCommentQuery] = useState(''),
    [commentStatus, setCommentStatus] = useState('all'),
    [printCartId, setPrintCartId] = useState('');
  const [operations, setOperations] = useState(null),
    [operationsError, setOperationsError] = useState(''),
    [profileModal, setProfileModal] = useState(false),
    [previewProfile, setPreviewProfile] = useState(null),
    [boardTab, setBoardTab] = useState('comments'),
    [accountFilter, setAccountFilter] = useState(''),
    [printerHealth, setPrinterHealth] = useState('Chưa kiểm tra cầu nối');
  const [channelState, setChannelState] = useState(null),
    [channelError, setChannelError] = useState(''),
    [advancedMode, setAdvancedMode] = useState(false);
  const [runtimeState, setRuntimeState] = useState(null);
  const [overviewOpen, setOverviewOpen] = useState(
    () => !window.matchMedia('(max-width: 640px)').matches,
  );
  const [printerMode, setPrinterMode] = useState(() =>
      window.matchMedia('(max-width: 640px)').matches ? 'queue' : 'browser',
    ),
    [bridgeUrl, setBridgeUrl] = useState('http://127.0.0.1:47831'),
    [bridgeToken, setBridgeToken] = useState('');
  const mounted = useRef(true),
    operationLock = useRef(false);
  const reload = useCallback(() => setRevision((v) => v + 1), []);
  const modalOpen = Boolean(
    form || commitForm || printJob || working || cartDetailId || profileModal,
  );
  useEffect(() => {
    if (repo.mode !== 'cloud') return;
    let active = true;
    const controller = new AbortController();
    repo
      .liveRuntime(sessionId || null, { signal: controller.signal })
      .then((result) => {
        if (active) setRuntimeState({ repo, sessionId, result, error: '' });
      })
      .catch((error) => {
        if (active) setRuntimeState({ repo, sessionId, result: null, error: error.message });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [repo, sessionId, revision]);
  useEffect(() => {
    if (repo.mode !== 'cloud') return;
    let active = true;
    repo
      .tiktokChannels()
      .then((result) => {
        if (active) {
          setChannelState(result?.channels ? result : { channels: [], connections: [] });
          setChannelError('');
        }
      })
      .catch((e) => {
        if (active) setChannelError(e.message);
      });
    return () => {
      active = false;
    };
  }, [repo, revision]);
  useEffect(() => {
    if (repo.mode !== 'cloud') return;
    let active = true;
    repo
      .liveOperations()
      .then((result) => {
        if (active) {
          setOperations(result?.version === 9 ? result : null);
          setOperationsError('');
        }
      })
      .catch((e) => {
        if (active) {
          setOperations(null);
          setOperationsError(e.message);
        }
      });
    return () => {
      active = false;
    };
  }, [repo, revision]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    onModalChange?.(modalOpen);
    return () => onModalChange?.(false);
  }, [modalOpen, onModalChange]);
  useEffect(() => {
    if (repo.mode !== 'cloud') return;
    let active = true;
    repo
      .liveContext()
      .then((result) => {
        if (active) {
          setContext(result);
          setContextError('');
        }
      })
      .catch((e) => {
        if (active) setContextError(e.message);
      });
    return () => {
      active = false;
    };
  }, [repo, contextRevision]);
  useEffect(() => {
    if (repo.mode !== 'cloud') return;
    let active = true;
    async function load() {
      try {
        const intake = await repo.liveIntake(sessionId || null, cursor);
        const currentSession = find(intake.sessions, sessionId);
        const commerce = currentSession
          ? await repo.liveCommerce(currentSession.campaign_id)
          : emptyCommerce;
        if (active) {
          setState({ intake, commerce, loadedSessionId: sessionId });
          setLoadError('');
        }
      } catch (e) {
        if (active) setLoadError(e.message);
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [repo, sessionId, cursor, revision]);
  useEffect(() => {
    if (repo.mode !== 'cloud') return;
    let timer,
      active = true;
    const dirty = () => {
      if (!active || timer) return;
      timer = setTimeout(() => {
        timer = null;
        if (active) reload();
      }, 350);
    };
    const stop = repo.watchLive(dirty, (s) => {
      if (active) {
        setConnection(s);
        if (s === 'SUBSCRIBED') dirty();
      }
    });
    const poll = setInterval(() => {
      if (!document.hidden) dirty();
    }, 10000);
    const visible = () => {
      if (!document.hidden) dirty();
    };
    window.addEventListener('focus', visible);
    document.addEventListener('visibilitychange', visible);
    return () => {
      active = false;
      stop();
      clearTimeout(timer);
      clearInterval(poll);
      window.removeEventListener('focus', visible);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [repo, reload]);
  const canSell = ['owner', 'manager', 'staff'].includes(data.role),
    canManage = ['owner', 'manager'].includes(data.role);
  const open = (title, value, fields, save, note = '', submit) =>
    setForm({ title, value, fields, save, note, submit });
  const saved = () => {
    setForm(null);
    setNotice('Đã lưu. Dữ liệu được đọc lại từ workspace.');
    reload();
  };
  async function perform(fn) {
    if (operationLock.current) return;
    operationLock.current = true;
    setWorking(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      if (mounted.current) setError(e.message);
    } finally {
      operationLock.current = false;
      if (mounted.current) {
        setWorking(false);
        reload();
      }
    }
  }
  async function startPrint(id, popup = null, reconcileOnly = false) {
    let lease;
    try {
      lease = await (
        operations?.version === 9 ? repo.claimConfiguredLivePrintJob : repo.claimLivePrintJob
      )(id, crypto.randomUUID());
      if (reconcileOnly) {
        popup?.close();
        if (mounted.current) setPrintJob(lease);
        return;
      }
      if (printerMode === 'browser') {
        if (!popup)
          throw new Error(
            'Trình duyệt chặn cửa sổ in. Cho phép popup và xử lý lại phiếu trong hàng đợi.',
          );
        await popup.print(lease.snapshot, {
          paperWidth: lease.paper_width || 80,
          printOptions: lease.print_options,
        });
      } else {
        const sent = await sendToLanBridge({
          baseUrl: bridgeUrl,
          token: bridgeToken,
          attemptId: lease.attempt_id,
          snapshot: lease.snapshot,
          paperWidth: lease.paper_width || 80,
          printOptions: lease.print_options,
        });
        if (sent.status !== 'sent')
          throw new Error(
            sent.status === 'dry_run'
              ? 'Bridge đang chạy thử, chưa gửi giấy tới máy in.'
              : 'Bridge chưa xác nhận đã gửi xong phiếu.',
          );
      }
      if (mounted.current) setPrintJob(lease);
    } catch (e) {
      popup?.close();
      if (lease) {
        try {
          await repo.finishLivePrintJob(
            id,
            lease.lease_token,
            'unknown',
            'Chưa xác nhận được kết quả gửi phiếu tới máy in.',
            crypto.randomUUID(),
          );
        } catch {
          /* lease remains visible for explicit reconciliation */
        }
      }
      if (mounted.current)
        setNotice(
          `Phiếu vẫn được giữ trong hệ thống. ${e.message} Kiểm tra giấy trước khi in lại.`,
        );
    } finally {
      if (mounted.current) reload();
    }
  }
  const printFromQueue = (job, reconcileOnly = false) => {
    if (!reconcileOnly && printerMode === 'queue') {
      setNotice('Phiếu đang chờ máy tính in. Chọn USB hoặc LAN trong Thiết lập khi bạn ở máy in.');
      return;
    }
    let popup = null;
    if (!reconcileOnly && printerMode === 'browser') {
      try {
        popup = prepareBrowserPrint({ paperWidth: 80 });
      } catch {
        /* handled after claim */
      }
    }
    void perform(() => startPrint(job.id, popup, reconcileOnly));
  };
  async function commit(payload, requestId, popup) {
    const result = await repo.commitLiveSaleTicket(payload, requestId);
    if (!mounted.current) {
      popup?.close();
      return;
    }
    setCommitForm(null);
    setNotice(
      `Đã chốt phiếu ${result.ticket_no} · rổ #${String(result.customer_no).padStart(3, '0')}.`,
    );
    reload();
    if (result.ticket_status === 'voided') {
      popup?.close();
      setNotice('Yêu cầu này thuộc phiếu đã VOID; không chốt lại hoặc in lại.');
      return;
    }
    if (printerMode === 'queue') {
      popup?.close();
      setNotice(`Đã chốt ${result.ticket_no}. Phiếu ở hàng đợi chung để máy tính nhận và in.`);
      return;
    }
    await perform(() => startPrint(result.print_job_id, popup));
  }
  async function cancelClaim() {
    const current = commitForm;
    setCommitForm(null);
    try {
      await repo.releaseLiveCommentClaim(current.comment.id, current.claim.claim_token);
    } catch {
      setNotice(
        'Chưa xác nhận được giải phóng quyền xử lý; claim sẽ hết hạn nếu không được gia hạn.',
      );
    }
    reload();
  }
  if (repo.mode !== 'cloud')
    return (
      <Panel title="Live · Chốt & In">
        <p className="operations-padding">
          Phase C cần workspace Supabase đã nâng cấp. Đăng nhập cloud và làm theo
          docs/PHASE_C_LIVE_COMMERCE.md; không tạo phiếu live bằng dữ liệu demo cũ.
        </p>
      </Panel>
    );
  if (!state || !context)
    return (
      <Panel title="Đang mở bàn live">
        <div className="operations-padding">
          <ErrorMessage error={error || contextError || loadError} />
          <button
            className="button secondary"
            onClick={() => {
              reload();
              setContextRevision((v) => v + 1);
            }}
          >
            Tải lại Phase C
          </button>
        </div>
      </Panel>
    );
  const intake =
      state.loadedSessionId === sessionId
        ? state.intake
        : { ...state.intake, comments: [], claims: [] },
    commerce = state.loadedSessionId === sessionId ? state.commerce : emptyCommerce,
    session = find(intake.sessions, sessionId),
    campaign = find(intake.campaigns, session?.campaign_id);
  const changeSession = (e) => {
    setSessionId(e.target.value);
    setCursor(null);
    setNotice('');
    setPrintCartId('');
    setCommentQuery('');
    setCommentStatus('all');
  };
  const parserCatalog = { ...context.catalog, products: data.products };
  const campaignForm = (r) =>
    open(
      r ? 'Sửa chiến dịch' : 'Tạo chiến dịch',
      r || { code: '', name: '', warehouse_id: data.warehouses[0]?.id || '', status: 'draft' },
      [
        field('code', 'Mã chiến dịch', { maxLength: 80, disabled: Boolean(r) }),
        field('name', 'Tên chiến dịch'),
        dropdown('warehouse_id', 'Kho chiến dịch', data.warehouses),
        dropdown(
          'status',
          'Trạng thái chiến dịch',
          choice(['draft', 'Nháp'], ['active', 'Đang mở'], ['closed', 'Đã đóng']),
        ),
      ],
      repo.saveLiveCampaign,
      'Đóng chiến dịch không tự giải phóng hàng đã chốt. Không mở lại chiến dịch đã đóng.',
    );
  const accountForm = (r) =>
    open(
      r ? 'Thiết lập tài khoản TikTok LIVE' : 'Thêm tài khoản TikTok LIVE',
      { ...(r || { name: '', username: '' }), enabled: r?.enabled === false ? 'false' : 'true' },
      [
        field('name', 'Tên hồ sơ kết nối'),
        field('username', 'TikTok username (không có @)', { maxLength: 24 }),
        dropdown('enabled', 'Cho phép kết nối', choice(['true', 'Bật'], ['false', 'Tắt'])),
      ],
      (v) => repo.saveLiveIntegrationAccount({ ...v, enabled: v.enabled === 'true' }),
      'Chỉ lưu tên tài khoản công khai. Không nhập mật khẩu, cookie hay API key tại đây. Worker giữ thông tin bí mật ở máy vận hành.',
    );
  const sessionForm = (r) =>
    open(
      r ? 'Thiết lập phiên live' : 'Tạo phiên live',
      r || {
        campaign_id: campaign?.id || '',
        code: '',
        title: '',
        provider: 'manual',
        room_id: '',
        integration_account_id: '',
        status: 'draft',
      },
      [
        dropdown('campaign_id', 'Chiến dịch', intake.campaigns, { disabled: Boolean(r) }),
        field('code', 'Mã phiên', { maxLength: 80, disabled: Boolean(r) }),
        field('title', 'Tên phiên'),
        dropdown(
          'provider',
          'Nguồn bình luận',
          choice(
            ['manual', 'Nhập thủ công'],
            ['simulator', 'Mô phỏng để thử'],
            ['tiktok_live', 'TikTok LIVE qua worker'],
          ),
          { disabled: Boolean(r) },
        ),
        dropdown(
          'integration_account_id',
          'Hồ sơ TikTok (khi dùng TikTok LIVE)',
          intake.integration_accounts || [],
          { required: false, disabled: Boolean(r) },
        ),
        field('room_id', 'Room / username của nguồn', {
          required: false,
          maxLength: 200,
          disabled: Boolean(r),
        }),
        dropdown(
          'status',
          'Trạng thái phiên',
          choice(['draft', 'Nháp'], ['live', 'Đang live'], ['ended', 'Đã kết thúc']),
        ),
      ],
      (v) =>
        repo.saveLiveSession({ ...v, integration_account_id: v.integration_account_id || null }),
      'Với TikTok LIVE, chọn hồ sơ rồi nhập đúng username vào Room. Bật phiên trong chiến dịch đang mở. Worker kết nối riêng; trạng thái phiên live không tự chứng minh đã kết nối TikTok.',
    );
  const manualCommentForm = () =>
    open(
      'Nhập bình luận để xử lý',
      {
        message_id: `manual-${crypto.randomUUID()}`,
        author_external_id: '',
        author_display_name: '',
        text: '',
        occurred_at: new Date().toISOString(),
      },
      [
        field('message_id', 'ID bình luận nguồn'),
        field('author_external_id', 'ID người bình luận ổn định'),
        field('author_display_name', 'Tên hiển thị'),
        field('text', 'Nội dung bình luận', { type: 'textarea', maxLength: 2000 }),
        field('occurred_at', 'Thời điểm nguồn (ISO 8601)', { maxLength: 40 }),
      ],
      (v) => repo.ingestLiveComments(sessionId, [v]),
      'Chỉ dùng với phiên nhập thủ công/mô phỏng. Tên hiển thị không thay cho ID. Bình luận chưa tạo phiếu hoặc giữ hàng.',
    );
  const ingestJsonForm = () =>
    open(
      'Nhập JSON bình luận',
      { json: '' },
      [field('json', 'Mảng JSON bình luận', { type: 'textarea', maxLength: 250000 })],
      (v) => {
        const rows = JSON.parse(v.json);
        if (!Array.isArray(rows) || rows.length < 1 || rows.length > 100)
          throw new Error('Cần mảng 1–100 bình luận.');
        return repo.ingestLiveComments(sessionId, rows);
      },
      'Các trường: message_id, author_external_id, author_display_name, text, occurred_at. Giữ nguyên ID nguồn để chống trùng; không tự tải dữ liệu tài khoản khác.',
    );
  const requeueForm = (j) =>
    open(
      'Đối soát và đưa lại vào hàng đợi',
      { reason: '' },
      [noteField()],
      (v, id) => repo.requeueLivePrintJob(j.id, v.reason, id),
      'Kiểm tra giấy trước: có thể máy in đã in nhưng mất phản hồi. Nếu giấy đã có, chọn “Đối soát giấy” sau khi đưa lại vào hàng đợi; không gửi in thêm.',
      'Đưa vào hàng đợi',
    );
  const voidForm = (t) =>
    open(
      `VOID ${t.ticket_no}`,
      { date: today(), reason: '' },
      [field('date', 'Ngày VOID', { type: 'date', max: today() }), noteField()],
      (v, id) => repo.voidLiveSaleTicket(t.id, v.date, v.reason, id),
      'Hủy phiếu, bỏ dòng giỏ và giải phóng đúng phần giữ; giữ lịch sử. Nếu phiếu đang được in, đối soát hàng đợi in trước.',
      'Xác nhận VOID',
    );
  const cartRows = summarizeLiveCarts(commerce);
  const selectedCart = cartRows.find((c) => c.id === cartDetailId);
  const openCartQueue = (id) => {
    setCartDetailId(null);
    setPrintCartId(id);
    setView('print');
  };
  const commentState = (c) =>
    commerce.tickets.find((t) => t.comment_id === c.id)?.status ||
    (operations?.comment_reviews?.find((r) => r.comment_id === c.id)?.status === 'ignored'
      ? 'ignored'
      : c.state);
  const reviewComment = (comment, status) =>
    open(
      status === 'ignored' ? 'Bỏ qua bình luận' : 'Khôi phục bình luận',
      { reason: '' },
      [
        field('reason', 'Lý do xử lý bình luận', {
          type: 'textarea',
          minLength: 3,
          maxLength: 2000,
        }),
      ],
      (v, id) => repo.setLiveCommentReview(comment.id, status, v.reason, id),
      'Giữ nguyên nội dung và lịch sử. Bình luận chưa tạo phiếu hoặc giữ hàng.',
      status === 'ignored' ? 'Xác nhận bỏ qua' : 'Khôi phục để kiểm tra',
    );
  const shownComments = intake.comments.filter(
    (c) =>
      (commentStatus === 'all' || commentState(c) === commentStatus) &&
      `${c.author_display_name} ${c.author_external_id} ${c.raw_text}`
        .toLocaleLowerCase('vi-VN')
        .includes(commentQuery.trim().toLocaleLowerCase('vi-VN')),
  );
  const shownPrintJobs = commerce.print_jobs.filter(
    (j) =>
      !printCartId ||
      commerce.tickets.some((t) => t.id === j.ticket_id && t.cart_id === printCartId),
  );
  const liveAccount = intake.integration_accounts.find(
    (a) => a.id === session?.integration_account_id,
  );
  const sourceIsFresh =
    session?.connection_status === 'connected' &&
    session.heartbeat_at &&
    Date.now() - Date.parse(session.heartbeat_at) < 90000;
  const tabs = [
    ['board', 'Bàn live', 'Live', Radio],
    ['carts', 'Giỏ khách', 'Giỏ khách', ShoppingBasket],
    ['history', 'Lịch sử phiên', 'Lịch sử', CalendarDays],
    ['print', 'Hàng đợi in', 'In phiếu', Printer],
    ['reports', 'Báo cáo live', 'Báo cáo', BarChart3],
    ['setup', 'Thiết lập Live & máy in', 'Thiết lập', Settings2],
  ];
  return (
    <div className={`live-page${advancedMode ? '' : ' live-seller-mode'}`}>
      <header className="live-hero">
        <div className="live-hero-heading">
          <div>
            <span className="live-eyebrow">CHIDI · LIVE COMMERCE</span>
            <h2>Bàn điều hành livestream</h2>
            <p>Bình luận → kiểm tra → chốt phiếu → in & xếp giỏ.</p>
          </div>
          <span className="live-hero-mark">
            <Music2 size={30} />
            <small>LIVE</small>
          </span>
        </div>
        {advancedMode && (
          <div className="live-topbar">
            {operations && (
              <Field label="Tài khoản / nguồn">
                <select
                  aria-label="Tài khoản / nguồn"
                  value={accountFilter}
                  disabled={modalOpen}
                  onChange={(e) => {
                    setAccountFilter(e.target.value);
                    changeSession({ target: { value: '' } });
                  }}
                >
                  <option value="">Tất cả tài khoản</option>
                  <option value="manual">Thủ công / mô phỏng</option>
                  {intake.integration_accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      @{a.username}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Field label="Phiên đang vận hành">
              <Select
                aria-label="Phiên đang vận hành"
                items={intake.sessions
                  .filter(
                    (s) =>
                      !accountFilter ||
                      (accountFilter === 'manual'
                        ? s.provider !== 'tiktok_live'
                        : s.integration_account_id === accountFilter),
                  )
                  .map((s) => ({
                    id: s.id,
                    code: s.code,
                    name: `${s.title} · ${statusText[s.status]}`,
                  }))}
                value={sessionId}
                disabled={modalOpen}
                onChange={changeSession}
              />
            </Field>
            <div className="live-sync">
              <button
                className="button secondary"
                disabled={modalOpen}
                onClick={() => {
                  reload();
                  setContextRevision((v) => v + 1);
                }}
              >
                <RefreshCw size={17} />
                <span>Tải lại bàn live</span>
              </button>
              <small>
                {connection === 'SUBSCRIBED' ? 'Đồng bộ realtime' : 'Tự cập nhật mỗi 10 giây'}
              </small>
            </div>
          </div>
        )}
        <div className="live-simple-mode">
          <button
            type="button"
            className="button secondary"
            disabled={modalOpen}
            onClick={() => setAdvancedMode(!advancedMode)}
          >
            {advancedMode ? 'Về kết nối TikTok đơn giản' : 'Thủ công / mô phỏng'}
          </button>
          <button type="button" className="button secondary" disabled={modalOpen} onClick={reload}>
            <RefreshCw size={16} />
            Tải lại
          </button>
        </div>
      </header>
      <nav className="live-navigation" aria-label="Phân hệ Live">
        {tabs.map(([key, label, short, Icon]) => (
          <button
            key={key}
            aria-label={label}
            aria-current={view === key ? 'page' : undefined}
            disabled={modalOpen}
            onClick={() => {
              setView(key);
              if (key === 'print') setPrintCartId('');
            }}
          >
            <Icon size={21} />
            <span className="live-nav-full">{label}</span>
            <span className="live-nav-short" aria-hidden="true">
              {short}
            </span>
          </button>
        ))}
      </nav>
      <ErrorMessage error={error || contextError || loadError} />
      {!advancedMode && <ErrorMessage error={channelError} />}
      {!advancedMode && (
        <div hidden={view !== 'board'}>
          <fieldset className="sales-fieldset" disabled={modalOpen}>
            <TikTokLiveHome
              repo={repo}
              state={channelState}
              onChanged={reload}
              canOperate={canSell}
              canManage={canManage}
              runtime={
                runtimeState?.repo === repo && runtimeState.sessionId === sessionId
                  ? runtimeState.result
                  : null
              }
              runtimeError={
                runtimeState?.repo === repo && runtimeState.sessionId === sessionId
                  ? runtimeState.error
                  : ''
              }
              onManageChannels={() => setView('setup')}
              onChannelChange={() => {
                if (!advancedMode && !modalOpen) changeSession({ target: { value: '' } });
              }}
              onSession={(id) => {
                if (!advancedMode && !modalOpen && sessionId !== id)
                  changeSession({ target: { value: id } });
              }}
              printerStatus={
                printerMode === 'queue'
                  ? 'Máy tính nhận hàng đợi'
                  : printerMode === 'browser'
                    ? 'USB / hộp thoại in'
                    : printerHealth
              }
              metrics={(channelId, sid) => {
                const m = operations?.session_metrics?.find((x) => x.session_id === sid);
                const liveSession = state?.intake?.sessions?.find((x) => x.id === sid);
                const cc = sid === sessionId ? commerce.campaign_customers : [];
                return {
                  session_id: sid,
                  comments: m?.comment_count,
                  item_count: m?.qty,
                  customer_count: sid === sessionId ? cc.length : undefined,
                  next_customer_no:
                    sid === sessionId
                      ? Math.max(0, ...cc.map((x) => x.customer_no)) + 1
                      : undefined,
                  started_at: liveSession?.started_at,
                  ended_at: liveSession?.ended_at,
                  session_status: liveSession?.status,
                };
              }}
            />
          </fieldset>
        </div>
      )}
      {operationsError && view === 'setup' && <ErrorMessage error={operationsError} />}
      {notice && (
        <p className="sales-note" role="status">
          {notice}
        </p>
      )}
      {session && advancedMode && (
        <div className="live-session-context">
          <span>
            <span className={`live-status ${session.status}`}>{statusText[session.status]}</span>
            <strong>{campaign?.name}</strong> ·{' '}
            {find(data.warehouses, campaign?.warehouse_id)?.name}
          </span>
          <small>
            {session.code} ·{' '}
            {liveAccount
              ? `@${liveAccount.username}`
              : session.provider === 'simulator'
                ? 'Mô phỏng'
                : 'Thủ công'}
          </small>
        </div>
      )}
      {advancedMode && !['setup', 'history'].includes(view) && !session && (
        <div className="live-welcome">
          <span className="live-connect-icon">
            <Radio size={38} />
          </span>
          <h2>Sẵn sàng cho buổi live tiếp theo</h2>
          <p>
            Chọn phiên ở đầu trang để mở bình luận và giỏ khách. Tài khoản và máy in có thể chuẩn bị
            trong Thiết lập.
          </p>
          <button className="button primary" onClick={() => setView('history')}>
            <CalendarDays size={18} /> Chọn từ lịch sử phiên
          </button>
          {canManage && (
            <button className="button secondary" onClick={() => setView('setup')}>
              Thiết lập phiên mới <ChevronRight size={16} />
            </button>
          )}
        </div>
      )}
      {view === 'history' && (
        <LiveSessionHistory
          sessions={intake.sessions}
          campaigns={intake.campaigns}
          accounts={intake.integration_accounts}
          simple={!advancedMode}
          metrics={operations?.session_metrics}
          onOpen={(id) => {
            changeSession({ target: { value: id } });
            setView('board');
          }}
        />
      )}
      {view === 'reports' && session && campaign && (
        <LiveCampaignReport
          key={campaign.id}
          commerce={commerce}
          campaign={campaign}
          today={today()}
        />
      )}
      {view === 'board' && session && (
        <>
          {operations && advancedMode && (
            <LiveOperatorControls
              key={session.id}
              repo={repo}
              session={session}
              campaign={campaign}
              commerce={commerce}
              operations={operations}
              canManage={canManage}
              disabled={modalOpen}
              onChanged={reload}
            />
          )}
          {operations && (
            <div className="live-periods" role="group" aria-label="Nội dung phiên live">
              <button
                aria-pressed={boardTab === 'comments'}
                onClick={() => setBoardTab('comments')}
              >
                LIVE · Tất cả bình luận
              </button>
              <button aria-pressed={boardTab === 'tickets'} onClick={() => setBoardTab('tickets')}>
                Đơn đã tạo · Phiếu live
              </button>
            </div>
          )}
          {boardTab === 'tickets' && operations && (
            <Panel
              title="Phiếu đã tạo trong phiên"
              note="Phiếu live chưa phải Final Order. Tổng và giỏ được tính từ phiếu đã chốt."
            >
              <div className="live-session-ticket-list">
                {commerce.tickets
                  .filter((t) => t.session_id === session.id)
                  .map((t) => (
                    <article key={t.id}>
                      <strong>
                        {t.ticket_no} · #{String(t.customer_snapshot.customer_no).padStart(3, '0')}
                      </strong>
                      <span>
                        {t.product_snapshot.sku} × {t.qty} · {money(t.line_total)} ·{' '}
                        {statusText[t.status]}
                      </span>
                      <button
                        className="button secondary"
                        onClick={() => setCartDetailId(t.cart_id)}
                      >
                        Xem giỏ / tổng đơn
                      </button>
                    </article>
                  ))}
                {!commerce.tickets.some((t) => t.session_id === session.id) && (
                  <p>Phiên chưa có phiếu đã chốt.</p>
                )}
              </div>
            </Panel>
          )}
          <div hidden={boardTab === 'tickets' && Boolean(operations)}>
            {advancedMode && (
              <details
                className="live-overview"
                open={overviewOpen}
                onToggle={(e) => setOverviewOpen(e.currentTarget.open)}
              >
                <summary>
                  <span>Thống kê & kết nối</span>
                  <small>
                    {sourceIsFresh ? 'Nguồn live đang có tín hiệu' : 'Xem thông tin nguồn và phiếu'}
                  </small>
                  <ChevronRight size={18} />
                </summary>
                <LiveQuickStats commerce={commerce} onNavigate={setView} />
                <section className="live-source-card">
                  <div className="live-source-identity">
                    <span className="live-connect-icon">
                      <Music2 size={25} />
                    </span>
                    <div>
                      <strong>{liveAccount ? `@${liveAccount.username}` : session.title}</strong>
                      <small>
                        {session.provider === 'tiktok_live'
                          ? 'Nguồn bình luận TikTok LIVE'
                          : 'Phiên nhập bình luận để thực hành'}
                      </small>
                    </div>
                  </div>
                  <div className="live-source-status">
                    <span className={`live-connection-pill ${sourceIsFresh ? 'connected' : ''}`}>
                      {sourceIsFresh ? <Wifi size={16} /> : <WifiOff size={16} />}{' '}
                      {sourceIsFresh
                        ? 'Đang nhận tín hiệu'
                        : session.provider === 'tiktok_live'
                          ? 'Chưa nhận tín hiệu TikTok'
                          : 'Nguồn thủ công / mô phỏng'}
                    </span>
                    {session.heartbeat_at && (
                      <small>
                        Cập nhật {new Date(session.heartbeat_at).toLocaleTimeString('vi-VN')}
                      </small>
                    )}
                  </div>
                  {canManage && (
                    <button className="button secondary" onClick={() => setView('setup')}>
                      Thiết lập kết nối <ChevronRight size={16} />
                    </button>
                  )}
                </section>
              </details>
            )}
            <Panel
              title="Bình luận và gợi ý SKU"
              note="Gợi ý không tự chốt. Nhận bình luận, kiểm tra sản phẩm/giá rồi mới CHỐT & IN."
              action={
                canSell &&
                session.status === 'live' &&
                session.provider !== 'tiktok_live' && (
                  <div className="foundation-actions">
                    <button className="button secondary" onClick={manualCommentForm}>
                      Nhập bình luận
                    </button>
                    <button className="button secondary" onClick={ingestJsonForm}>
                      Nhập JSON
                    </button>
                  </div>
                )
              }
            >
              <div className="live-filterbar live-panel-filters">
                <label className="live-search">
                  <Search size={18} />
                  <input
                    aria-label="Tìm bình luận"
                    placeholder="Tên khách, nội dung hoặc ID nguồn..."
                    value={commentQuery}
                    onChange={(e) => setCommentQuery(e.target.value)}
                  />
                </label>
                <select
                  aria-label="Lọc trạng thái bình luận"
                  value={commentStatus}
                  onChange={(e) => setCommentStatus(e.target.value)}
                >
                  <option value="all">Tất cả bình luận</option>
                  <option value="new">Chưa chốt</option>
                  <option value="committed">Đã chốt</option>
                  <option value="voided">Đã VOID</option>
                  {operations && <option value="ignored">Đã bỏ qua</option>}
                </select>
                <span className="live-page-count">
                  {shownComments.length}/{intake.comments.length} trên trang này
                </span>
              </div>
              <div className="live-comments">
                {shownComments.length ? (
                  shownComments.map((c) => {
                    const suggestion = parseLiveComment(c.raw_text, parserCatalog),
                      ticket = commerce.tickets.find((t) => t.comment_id === c.id),
                      claim = intake.claims.find((r) => r.comment_id === c.id);
                    const claimedOther =
                      claim && !claim.claim_token && Date.parse(claim.expires_at) > Date.now();
                    const stateLabel = commentState(c);
                    return (
                      <article className="live-comment" key={c.id}>
                        <div>
                          <div className="live-comment-author">
                            <span className="live-avatar">
                              {[...(c.author_display_name || '?')][0]}
                            </span>
                            <strong>{c.author_display_name}</strong>
                            {c.author_username && (
                              <small>@{c.author_username.replace(/^@/, '')}</small>
                            )}
                          </div>
                          <small>
                            ID {c.author_external_id} ·{' '}
                            {new Date(c.occurred_at).toLocaleString('vi-VN')}
                          </small>
                          <p className="live-comment-text">{c.raw_text}</p>
                          <span className="live-suggestion">
                            {parseText[suggestion.status]}
                            {suggestion.product_id &&
                              ` · ${find(data.products, suggestion.product_id)?.code} × ${suggestion.quantity}`}
                          </span>
                          {operations && suggestion.product_id && (
                            <small className="live-candidate-detail">
                              {suggestion.candidates[0]?.color || 'Chưa rõ màu'} /{' '}
                              {suggestion.candidates[0]?.size || 'Chưa rõ size'} ·
                              {` Khớp rõ mã/thuộc tính · SL ${suggestion.quantity} · giá: nhập khi kiểm tra`}
                              {context.inventory &&
                                ` · Khả dụng hiện tại: ${context.inventory.find((i) => i.product_id === suggestion.product_id && i.warehouse_id === campaign?.warehouse_id)?.available ?? 0}`}
                            </small>
                          )}
                        </div>
                        <div className="live-comment-action">
                          <span className={`live-status ${stateLabel}`}>
                            {statusText[stateLabel] || stateLabel}
                          </span>
                          {canSell && stateLabel === 'new' && (
                            <button
                              className="button primary"
                              disabled={
                                working ||
                                Boolean(claimedOther) ||
                                session.status !== 'live' ||
                                campaign?.status !== 'active'
                              }
                              onClick={() =>
                                perform(async () => {
                                  const owned = await repo.claimLiveComment(c.id);
                                  if (mounted.current)
                                    setCommitForm({ comment: c, claim: owned, suggestion });
                                })
                              }
                            >
                              <MessageSquare size={16} />
                              {claimedOther ? 'Đang có người xử lý' : 'Nhận & kiểm tra'}
                            </button>
                          )}
                          {operations && canSell && ['new', 'ignored'].includes(stateLabel) && (
                            <button
                              className="button secondary"
                              disabled={working || Boolean(claimedOther)}
                              onClick={() =>
                                reviewComment(c, stateLabel === 'ignored' ? 'new' : 'ignored')
                              }
                            >
                              {stateLabel === 'ignored' ? 'Khôi phục bình luận' : 'Bỏ qua'}
                            </button>
                          )}
                        </div>
                      </article>
                    );
                  })
                ) : (
                  <div className="live-empty">
                    <MessageSquare size={30} />
                    <h3>
                      {intake.comments.length
                        ? 'Không có bình luận phù hợp'
                        : 'Đang chờ bình luận đầu tiên'}
                    </h3>
                    <p>
                      {intake.comments.length
                        ? 'Thử từ khóa hoặc trạng thái khác; bộ lọc chỉ áp dụng trên trang đang xem.'
                        : session.provider === 'tiktok_live'
                          ? 'Khởi động worker đúng phiên để nhận bình luận TikTok.'
                          : 'Nhập bình luận hoặc JSON để thực hành trước buổi live.'}
                    </p>
                  </div>
                )}
              </div>
              <div className="operations-padding foundation-actions">
                <button
                  className="button secondary"
                  disabled={!cursor || modalOpen}
                  onClick={() => setCursor(null)}
                >
                  Về bình luận mới nhất
                </button>
                <button
                  className="button secondary"
                  disabled={!intake.has_more || modalOpen}
                  onClick={() =>
                    setCursor({ before: intake.next_before, before_id: intake.next_before_id })
                  }
                >
                  Xem bình luận cũ hơn
                </button>
                <small>Mỗi trang tối đa 100 bình luận.</small>
              </div>
            </Panel>
          </div>
        </>
      )}
      {view === 'carts' && session && (
        <>
          <LiveCartList
            key={campaign?.id}
            commerce={commerce}
            onDetail={setCartDetailId}
            onPrintQueue={openCartQueue}
          />
          <Panel title="Phiếu Live Sale Ticket">
            <Table
              headers={['Phiếu', 'Rổ', 'SKU', 'SL', 'Thành tiền', 'Trạng thái', 'Thao tác']}
              empty={!commerce.tickets.length}
            >
              {commerce.tickets.map((t) => (
                <tr key={t.id}>
                  <td>{t.ticket_no}</td>
                  <td>
                    #
                    {String(
                      find(commerce.campaign_customers, t.campaign_customer_id)?.customer_no || '',
                    ).padStart(3, '0')}
                  </td>
                  <td>
                    {t.product_snapshot?.code ||
                      t.product_snapshot?.sku ||
                      find(data.products, t.product_id)?.code}
                  </td>
                  <td>{t.qty}</td>
                  <td>{money(t.line_total)}</td>
                  <td>{statusText[t.status]}</td>
                  <td>
                    {canManage && t.status === 'committed' && (
                      <button className="button secondary" onClick={() => voidForm(t)}>
                        VOID
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </Table>
          </Panel>
        </>
      )}
      {view === 'print' && session && (
        <Panel
          title="Hàng đợi in phiếu"
          note="Một phiếu kinh doanh, nhiều lần thử in. Chỉ xác nhận đã in sau khi nhìn thấy giấy đúng phiếu."
        >
          <div className="live-filterbar live-panel-filters">
            <Field label="Lọc giỏ trong hàng đợi in">
              <select value={printCartId} onChange={(e) => setPrintCartId(e.target.value)}>
                <option value="">Tất cả giỏ trong chiến dịch</option>
                {cartRows.map((c) => (
                  <option key={c.id} value={c.id}>
                    #{String(c.customer_no || '').padStart(3, '0')} ·{' '}
                    {c.campaign_customer?.display_name_snapshot}
                  </option>
                ))}
              </select>
            </Field>
            <span className="live-page-count">{shownPrintJobs.length} phiếu</span>
          </div>
          <Table
            headers={['Phiếu / Rổ', 'Trạng thái', 'Lần in lại', 'Thao tác']}
            empty={!shownPrintJobs.length}
          >
            {shownPrintJobs.map((j) => (
              <tr key={j.id}>
                <td>
                  {j.snapshot.ticket_no}
                  <small>
                    #{String(j.snapshot.customer_no).padStart(3, '0')} · {j.snapshot.customer_name}
                  </small>
                </td>
                <td>
                  {statusText[j.status]}
                  {j.status === 'printing' && (
                    <small>
                      Hết hạn nhận:{' '}
                      {new Date(j.lease_expires_at || j.expires_at).toLocaleTimeString('vi-VN')}
                    </small>
                  )}
                </td>
                <td>{j.reprint_count || 0}</td>
                <td>
                  <div className="foundation-actions">
                    {canSell && j.status === 'queued' && (
                      <>
                        <button
                          className="button primary"
                          disabled={working}
                          onClick={() => printFromQueue(j)}
                        >
                          In phiếu
                        </button>
                        <button
                          className="button secondary"
                          disabled={working}
                          onClick={() => printFromQueue(j, true)}
                        >
                          Đối soát giấy
                        </button>
                      </>
                    )}
                    {canSell && ['printed', 'failed', 'printing'].includes(j.status) && (
                      <button
                        className="button secondary"
                        disabled={working}
                        onClick={() => requeueForm(j)}
                      >
                        Kiểm tra / in lại
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        </Panel>
      )}
      {view === 'setup' && (
        <>
          {!advancedMode && (
            <TikTokChannelSettings
              repo={repo}
              state={channelState}
              onChanged={reload}
              canManage={canManage}
            />
          )}
          {advancedMode && (
            <>
              <Panel
                title="Tài khoản tích hợp TikTok LIVE"
                note="Hồ sơ công khai trong workspace; API key và phiên xác thực của worker được thiết lập trên máy vận hành."
                action={
                  canManage && (
                    <button className="button primary" onClick={() => accountForm()}>
                      Thêm tài khoản TikTok
                    </button>
                  )
                }
              >
                <Table
                  headers={['Tên hồ sơ', 'TikTok username', 'Cho phép', 'Thao tác']}
                  empty={!intake.integration_accounts?.length}
                >
                  {intake.integration_accounts?.map((r) => (
                    <tr key={r.id}>
                      <td>{r.name}</td>
                      <td>@{r.username}</td>
                      <td>{r.enabled ? 'Bật' : 'Tắt'}</td>
                      <td>
                        {canManage && (
                          <button className="button secondary" onClick={() => accountForm(r)}>
                            Thiết lập tài khoản
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </Table>
                <p className="operations-padding">
                  Sau khi tạo hồ sơ, tạo phiên TikTok cùng username, mở chiến dịch/phiên rồi chạy
                  worker theo docs/PHASE_C_LIVE_COMMERCE.md. Nhãn kết nối và heartbeat giúp phân
                  biệt phiên đang mở với nguồn thực sự đang nhận bình luận.
                </p>
              </Panel>
              <Panel
                title="Chiến dịch"
                action={
                  canManage && (
                    <button className="button primary" onClick={() => campaignForm()}>
                      Tạo chiến dịch
                    </button>
                  )
                }
              >
                <Table
                  headers={['Mã', 'Tên', 'Kho', 'Trạng thái', 'Thao tác']}
                  empty={!intake.campaigns.length}
                >
                  {intake.campaigns.map((r) => (
                    <tr key={r.id}>
                      <td>{r.code}</td>
                      <td>{r.name}</td>
                      <td>{find(data.warehouses, r.warehouse_id)?.name}</td>
                      <td>{statusText[r.status]}</td>
                      <td>
                        {canManage && (
                          <button className="button secondary" onClick={() => campaignForm(r)}>
                            Sửa chiến dịch
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </Table>
              </Panel>
              <Panel
                title="Phiên live"
                action={
                  canManage && (
                    <button className="button primary" onClick={() => sessionForm()}>
                      Tạo phiên live
                    </button>
                  )
                }
              >
                <Table
                  headers={['Mã / Tên', 'Nguồn', 'Trạng thái', 'Kết nối', 'Thao tác']}
                  empty={!intake.sessions.length}
                >
                  {intake.sessions.map((r) => (
                    <tr key={r.id}>
                      <td>
                        {r.code}
                        <small>{r.title}</small>
                      </td>
                      <td>
                        {r.provider}
                        <small>{r.room_id}</small>
                      </td>
                      <td>{statusText[r.status]}</td>
                      <td>
                        {r.connection_status}
                        <small>{r.connection_message}</small>
                      </td>
                      <td>
                        {canManage && (
                          <button className="button secondary" onClick={() => sessionForm(r)}>
                            Sửa phiên
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </Table>
                {canManage && (
                  <details className="operations-padding">
                    <summary>Thông tin cấu hình worker trên máy tính</summary>
                    <p>Chọn đúng phiên ở đầu trang, rồi sao chép hai mã này vào cấu hình worker.</p>
                    <Field label="LIVE_WORKSPACE_ID">
                      <input
                        readOnly
                        value={data.workspace.id}
                        onFocus={(e) => e.target.select()}
                      />
                    </Field>
                    <Field label="LIVE_SESSION_ID">
                      <input
                        readOnly
                        value={session?.id || ''}
                        placeholder="Chọn phiên đang vận hành"
                        onFocus={(e) => e.target.select()}
                      />
                    </Field>
                  </details>
                )}
              </Panel>
            </>
          )}
          <Panel
            title="Máy in ZYWELL 822 · USB + LAN"
            note="Cấu hình máy in dùng cho phiên trình duyệt này; token ghép nối chỉ giữ trong bộ nhớ."
          >
            <div className="form-body form-grid">
              <Field label="Cách in">
                <Select
                  aria-label="Cách in"
                  items={choice(
                    ['browser', 'USB / driver hệ điều hành qua trình duyệt'],
                    ['lan', 'LAN qua cầu nối trên máy tính'],
                    ['queue', 'Chỉ xếp hàng đợi — máy tính sẽ in'],
                  )}
                  value={printerMode}
                  onChange={(e) => setPrinterMode(e.target.value)}
                />
              </Field>
              {printerMode === 'lan' && (
                <>
                  <Field label="Địa chỉ cầu nối local">
                    <input
                      type="url"
                      value={bridgeUrl}
                      onChange={(e) => setBridgeUrl(e.target.value)}
                    />
                  </Field>
                  <Field label="Token ghép nối máy in">
                    <input
                      type="password"
                      autoComplete="off"
                      value={bridgeToken}
                      onChange={(e) => setBridgeToken(e.target.value)}
                    />
                  </Field>
                </>
              )}
              <p className="span-2 sales-note">
                Khổ mặc định 80 mm. USB: cài driver ZYWELL và chọn máy in trong hộp thoại. LAN: chạy
                bridge trên máy tính kết nối máy in; IP máy in được cấu hình cố định ở bridge, không
                lấy từ bình luận. Cần kiểm tra giấy/font Việt trên ZYWELL thật trước vận hành. Trên
                điện thoại có thể dùng trình duyệt để chốt; máy tính nhận hàng đợi và in.
              </p>
            </div>
          </Panel>
        </>
      )}
      {view === 'setup' && (
        <LivePrinterPreview
          mode={printerMode}
          bridgeUrl={bridgeUrl}
          bridgeToken={bridgeToken}
          canPrint={canSell}
        />
      )}
      {selectedCart && (
        <LiveCartDetail
          cart={selectedCart}
          customer={context.customers.find(
            (c) => c.id === selectedCart.campaign_customer?.customer_id,
          )}
          jobs={commerce.print_jobs}
          canManage={canManage}
          onClose={() => setCartDetailId(null)}
          onPrintQueue={openCartQueue}
          onVoid={(ticket) => {
            setCartDetailId(null);
            voidForm(ticket);
          }}
        />
      )}
      {form && <Form config={form} close={() => setForm(null)} done={saved} />}
      {commitForm && (
        <CommitForm
          {...commitForm}
          context={context}
          products={data.products}
          commit={commit}
          close={cancelClaim}
          printerMode={printerMode}
        />
      )}
      {printJob && (
        <PrintConfirmation
          job={printJob}
          close={() => {
            setPrintJob(null);
            reload();
          }}
          finish={(outcome, requestId) =>
            repo.finishLivePrintJob(
              printJob.job_id,
              printJob.lease_token,
              outcome,
              outcome === 'printed'
                ? 'Người vận hành xác nhận đã nhìn thấy giấy đúng phiếu.'
                : 'Người vận hành xác nhận lỗi hoặc chưa rõ kết quả in giấy.',
              requestId,
            )
          }
        />
      )}
    </div>
  );
}
