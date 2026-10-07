import { lazy, Suspense, useEffect, useState } from 'react';
import { useErpSession } from './lib/useErpSession.js';
import {
  LayoutDashboard,
  PackagePlus,
  Boxes,
  Wallet,
  Tags,
  FileSearch,
  ChartNoAxesCombined,
  History,
  Settings as SettingsIcon,
  Menu,
  X,
  ChevronRight,
  RefreshCw,
  LogOut,
  ArrowUpRight,
  Check,
  RotateCcw,
  LoaderCircle,
  ShieldCheck,
  ArrowRight,
  ShoppingBag,
  Users,
  Layers3,
} from 'lucide-react';
import { cloudConfigured, requestedCloud, supabase } from './lib/repository.js';
import { today, money, validDate } from './lib/domain.js';
import { CloudReport, TeamManagement } from './features/Operations.jsx';
import { sampleImport } from './demo-sample.js';
import {
  Overview,
  Documents,
  CashManagement,
  Catalog,
  Reconciliation,
  Reports,
  Audit,
  Settings,
} from './pages.jsx';
import { DocumentForm, MasterForm } from './forms.jsx';
import { Modal, ErrorMessage, Field } from './components.jsx';
const SalesWorkspace = lazy(() => import('./features/Sales.jsx'));
const CommerceFoundation = lazy(() => import('./features/CommerceFoundation.jsx'));
const LiveCommerce = lazy(() => import('./features/LiveCommerce.jsx'));

const NAV = [
  ['overview', 'Tổng quan', LayoutDashboard, 'Toàn cảnh vận hành'],
  ['purchases', 'Nhập hàng', PackagePlus, 'Từ phiếu nhập đến hàng trong kho'],
  ['sales', 'Bán hàng', ShoppingBag, 'Giữ hàng, giao hàng và xử lý hàng hoàn'],
  ['customers', 'Khách hàng', Users, 'Thông tin liên hệ dùng chung cho đơn bán'],
  ['inventory', 'Kho hàng', Boxes, 'Tồn kho, đã giữ và hàng đang giao'],
  ['cash', 'Thu chi', Wallet, 'Kiểm soát từng khoản tiền'],
  ['catalog', 'Danh mục', Tags, 'Dữ liệu dùng chung cho nghiệp vụ'],
  ['foundation', 'Nền tảng thương mại', Layers3, 'Biến thể, khách hàng, giữ tồn và kế hoạch thanh toán'],
  ['live', 'Live · Chốt & In', Layers3, 'Chiến dịch, bình luận, giỏ khách và hàng đợi in'],
  ['reconciliation', 'Đối chiếu dữ liệu', FileSearch, 'Bảo toàn nguồn, nhập đúng một lần'],
  ['reports', 'Báo cáo', ChartNoAxesCombined, 'Thu chi và số dư đã ghi sổ'],
  ['audit', 'Nhật ký', History, 'Dấu vết thao tác và chứng từ'],
  ['settings', 'Thiết lập', SettingsIcon, 'Môi trường, kết nối và tài liệu'],
];
const path = () => location.hash.replace('#/', '') || 'overview';

function AuthScreen({ onDemo, recovery = false, onRecovered, sessionError = '' }) {
  const [action, setAction] = useState(recovery ? 'password' : 'signin'),
    [email, setEmail] = useState(''),
    [password, setPassword] = useState(''),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [error, setError] = useState('');
  useEffect(() => {
    if (recovery) setAction('password');
  }, [recovery]);
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    try {
      let result;
      if (action === 'signup') {
        result = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: location.origin },
        });
        if (!result.error)
          setMessage('Đã gửi yêu cầu đăng ký. Kiểm tra email xác nhận, rồi quay lại đăng nhập.');
      } else if (action === 'reset') {
        result = await supabase.auth.resetPasswordForEmail(email, { redirectTo: location.origin });
        if (!result.error)
          setMessage('Nếu tài khoản hợp lệ, hướng dẫn đặt lại mật khẩu sẽ được gửi đến email.');
      } else if (action === 'password') {
        result = await supabase.auth.updateUser({ password });
        if (!result.error) {
          setMessage('Đã cập nhật mật khẩu.');
          onRecovered?.();
        }
      } else result = await supabase.auth.signInWithPassword({ email, password });
      if (result.error) throw result.error;
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-layout">
      <section className="auth-story">
        <span className="brand wordmark">
          ChiDi<span>ERP</span>
        </span>
        <h1>
          Mỗi con số
          <br />
          đều có câu chuyện.
        </h1>
        <p>
          Giữ dữ liệu rõ ràng. Theo dõi hàng hóa, tiền và chứng từ trong cùng một không gian quản
          trị.
        </p>
        <div className="auth-features">
          <span>
            <Check size={18} /> Dữ liệu theo workspace
          </span>
          <span>
            <Check size={18} /> Ghi sổ có kiểm tra
          </span>
          <span>
            <Check size={18} /> Truy vết về nguồn
          </span>
        </div>
      </section>
      <section className="auth-panel">
        <div className="auth-card">
          <ShieldCheck size={30} />
          <h2>
            {action === 'signup'
              ? 'Tạo tài khoản ChiDi'
              : action === 'reset'
                ? 'Lấy lại mật khẩu'
                : action === 'password'
                  ? 'Đặt mật khẩu mới'
                  : 'Chào mừng trở lại'}
          </h2>
          <p>Đăng nhập vào Supabase project đã cấu hình.</p>
          <form onSubmit={submit}>
            {action !== 'password' && (
              <Field label="Email">
                <input
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </Field>
            )}
            {action !== 'reset' && (
              <Field label="Mật khẩu">
                <input
                  type="password"
                  autoComplete={action === 'signin' ? 'current-password' : 'new-password'}
                  minLength={8}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>
            )}
            <ErrorMessage error={error || sessionError} />
            {message && (
              <p className="success-message" role="status">
                {message}
              </p>
            )}
            <button className="button primary full" disabled={busy}>
              {busy ? <LoaderCircle size={17} className="spin" /> : <ArrowRight size={17} />}{' '}
              {action === 'signup'
                ? 'Đăng ký'
                : action === 'reset'
                  ? 'Gửi hướng dẫn'
                  : action === 'password'
                    ? 'Cập nhật mật khẩu'
                    : 'Đăng nhập'}
            </button>
          </form>
          <div className="auth-links">
            <button
              onClick={() => {
                setAction(action === 'signup' ? 'signin' : 'signup');
                setError('');
                setMessage('');
              }}
            >
              {action === 'signup' ? 'Đã có tài khoản' : 'Tạo tài khoản'}
            </button>
            <button
              onClick={() => {
                setAction('reset');
                setError('');
                setMessage('');
              }}
            >
              Quên mật khẩu
            </button>
          </div>
          <button className="text-button" onClick={onDemo}>
            Mở bản chạy thử trên máy này <ArrowUpRight size={15} />
          </button>
        </div>
      </section>
    </div>
  );
}

function ConfirmAction({ action, repo, onDone, onClose, onCorrected }) {
  const [busy, setBusy] = useState(false),
    [checked, setChecked] = useState(false),
    [reason, setReason] = useState(''),
    [date, setDate] = useState(today()),
    [error, setError] = useState(''),
    [requestId] = useState(() => crypto.randomUUID());
  const reverse = action.type === 'reverse',
    reset = action.type === 'reset',
    correcting = action.type === 'correct',
    deleting = action.type === 'deleteDraft';
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      let result;
      if (reset) result = await repo.reset();
      else if (deleting) result = await repo.deleteDraft(action.kind, action.row.id, reason, requestId);
      else if (correcting) result = await repo.correctPosted(action.kind, action.row.id, date, reason, requestId);
      else if (reverse) result = await repo.reverse(action.kind, action.row.id, date, reason, requestId);
      else result = await repo.post(action.kind, action.row.id, requestId);
      await onDone(
        reset
          ? 'Đã đặt lại bản chạy thử.'
          : deleting
            ? 'Đã xóa nháp; không có phát sinh sổ kho hoặc sổ tiền.'
          : correcting
            ? 'Đã đảo chứng từ gốc và tạo bản sửa ở trạng thái nháp.'
          : reverse
            ? 'Đã thêm chứng từ đảo; bản gốc vẫn được giữ.'
            : 'Đã ghi sổ thành công.',
      );
      if (correcting) onCorrected(result.replacement);
      else onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={
        reset ? 'Đặt lại dữ liệu chạy thử' : deleting ? 'Xóa chứng từ nháp'
          : correcting ? 'Đảo và tạo bản sửa' : reverse ? 'Đảo chứng từ đã ghi' : 'Xác nhận ghi sổ'
      }
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <div className="confirm-body">
          <p>
            {reset
              ? 'Thao tác này xóa dữ liệu chạy thử trong trình duyệt hiện tại. File Excel và database Supabase không bị thay đổi. Hãy xuất bản sao trước nếu cần giữ.'
              : deleting
                ? 'Phiếu nháp sẽ được đánh dấu đã xóa, giữ dấu vết kiểm toán và không ảnh hưởng tồn kho hoặc tiền.'
              : correcting
                ? 'Hệ thống sẽ đảo ảnh hưởng tồn kho hoặc tiền của bản gốc, giữ lịch sử và tạo một bản sửa ở trạng thái nháp để bạn kiểm tra trước khi ghi sổ.'
              : reverse
                ? 'Hệ thống sẽ thêm chuyển động ngược chiều và lưu lý do. Chứng từ gốc được giữ nguyên.'
                : 'Chứng từ sẽ ảnh hưởng sổ kho hoặc sổ tiền. Sau khi ghi, bạn không sửa trực tiếp được số lượng và số tiền.'}
          </p>
          {!reset && (
            <div className="confirmation-value">
              <span>{action.row.legacy_id || action.row.description || 'Chứng từ mới'}</span>
              <strong>{money(action.row.total_amount ?? action.row.amount)}</strong>
            </div>
          )}
          {(reverse || correcting || deleting) && (
            <>
              {!deleting && <Field label="Ngày đảo">
                <input
                  type="date"
                  required
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                />
              </Field>}
              <Field label={deleting ? 'Lý do xóa nháp' : 'Lý do đảo'}>
                <textarea
                  required
                  minLength={10}
                  rows={3}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </Field>
            </>
          )}
          <label className="checkbox">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
            />
            <span>
              {reset
                ? 'Tôi muốn đặt lại dữ liệu chạy thử.'
                : 'Tôi đã kiểm tra chứng từ, ngày và căn cứ của thao tác này.'}
            </span>
          </label>
          <ErrorMessage error={error} />
        </div>
        <footer className="modal-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            Hủy
          </button>
          <button
            className={`button ${reverse || reset || correcting || deleting ? 'danger' : 'primary'}`}
            disabled={!checked || busy}
          >
            {busy ? (
              <LoaderCircle className="spin" size={16} />
            ) : reverse || reset || correcting || deleting ? (
              <RotateCcw size={16} />
            ) : (
              <Check size={16} />
            )}
            Xác nhận
          </button>
        </footer>
      </form>
    </Modal>
  );
}

export default function App() {
  const [page, setPage] = useState(path),
    [mobile, setMobile] = useState(false),
    [forcedDemo, setForcedDemo] = useState(false);
  const useCloud = requestedCloud && !forcedDemo;
  const {
    session,
    authLoading,
    recovery,
    setRecovery,
    workspaces,
    chosen,
    chooseWorkspace,
    membershipsLoading,
    refreshMemberships,
    cloudError,
    data,
    loading,
    loadError,
    setLoadError,
    repo,
    refresh: reload,
    bootstrap,
    bootstrapBusy,
    contextKey,
  } = useErpSession(useCloud);
  const [toast, setToast] = useState(''),
    [modal, setModal] = useState(null),
    [salesModalOpen, setSalesModalOpen] = useState(false);
  const [from, setFrom] = useState(today().slice(0, 7) + '-01'),
    [to, setTo] = useState(today());
  useEffect(() => {
    const cb = () => setPage(path());
    window.addEventListener('hashchange', cb);
    return () => window.removeEventListener('hashchange', cb);
  }, []);
  useEffect(() => {
    setModal(null);
    setSalesModalOpen(false);
    setToast('');
  }, [contextKey]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 6500);
    return () => clearTimeout(t);
  }, [toast]);
  async function refresh(message = '') {
    const updated = await reload();
    if (updated && message) setToast(message);
    return updated;
  }
  function navigate(route) {
    location.hash = '/' + route;
    setPage(route);
    setMobile(false);
  }
  async function sample() {
    try {
      await repo.importLegacy(sampleImport(today()));
      await refresh('Đã nạp dữ liệu minh họa; mọi chứng từ vẫn chờ xác nhận.');
    } catch (e) {
      setLoadError(e.message);
    }
  }
  const closeModal = () => setModal((current) => (current === modal ? null : current));
  const demo = () => {
    setForcedDemo(true);
    setRecovery(false);
  };
  if (useCloud && !cloudConfigured)
    return (
      <main className="setup-screen">
        <span className="brand">
          ChiDi <small>ERP</small>
        </span>
        <h1>Chưa đủ cấu hình Supabase</h1>
        <p>
          Điền VITE_SUPABASE_URL và VITE_SUPABASE_PUBLISHABLE_KEY vào .env.local rồi khởi động lại.
          Không có kết nối cloud được tạo khi thiếu hai giá trị này.
        </p>
        <p>
          Hướng dẫn: <code>docs/SUPABASE_SETUP.md</code>
        </p>
        <button className="button primary" onClick={demo}>
          Tiếp tục với bản chạy thử
        </button>
      </main>
    );
  if (useCloud && authLoading)
    return (
      <main className="loading-screen">
        <LoaderCircle className="spin" />
        <p>Đang kiểm tra phiên đăng nhập...</p>
      </main>
    );
  if (useCloud && (!session || recovery))
    return (
      <AuthScreen
        onDemo={demo}
        recovery={recovery}
        onRecovered={() => setRecovery(false)}
        sessionError={cloudError}
      />
    );
  if (useCloud && membershipsLoading && !chosen)
    return (
      <main className="loading-screen">
        <LoaderCircle className="spin" />
        <p>Đang kiểm tra workspace và quyền của bạn…</p>
      </main>
    );
  if (useCloud && !chosen)
    return (
      <main className="setup-screen">
        <span className="brand">
          ChiDi <small>ERP</small>
        </span>
        <h1>Tạo không gian làm việc</h1>
        <p>
          Workspace giữ riêng danh mục và chứng từ của shop. Tài khoản tạo workspace sẽ có quyền chủ
          shop.
        </p>
        <ErrorMessage error={cloudError} />
        {cloudError && (
          <p>Kiểm tra đã chạy file SQL trong project Supabase mới. Xem docs/SUPABASE_SETUP.md.</p>
        )}
        <button
          className="button primary"
          onClick={bootstrap}
          disabled={bootstrapBusy || Boolean(cloudError)}
        >
          {bootstrapBusy ? 'Đang tạo…' : 'Tạo workspace ChiDi'}
        </button>
        {cloudError && (
          <button className="button secondary" onClick={() => refreshMemberships().catch(() => {})}>
            Kiểm tra lại quyền truy cập
          </button>
        )}
        <button className="button secondary" onClick={() => supabase.auth.signOut()}>
          Đăng xuất
        </button>
      </main>
    );
  const current = NAV.find((n) => n[0] === page) || NAV[0];
  const canPost = data && ['owner', 'manager'].includes(data.role),
    isOwner = data?.role === 'owner';
  const openDocument = (kind, row) => setModal({ type: 'document', kind, row });
  function content() {
    if (loading)
      return (
        <div className="loading-screen">
          <LoaderCircle className="spin" />
          <p>Đang đọc dữ liệu...</p>
        </div>
      );
    if (!data)
      return (
        <div className="setup-screen">
          <h2>Chưa đọc được dữ liệu</h2>
          <p>Kết nối cloud lỗi sẽ không tự chuyển sang dữ liệu chạy thử.</p>
          <button className="button secondary" onClick={() => refresh().catch(() => {})}>
            Thử lại
          </button>
        </div>
      );
    switch (current[0]) {
      case 'purchases':
      case 'cash': {
        const kind = current[0] === 'purchases' ? 'purchase' : 'cash';
        const Component = kind === 'cash' ? CashManagement : Documents;
        return (
          <Component
            kind={kind}
            data={data}
            repo={repo}
            onChanged={refresh}
            canManage={canPost}
            canPost={canPost}
            canDraft={['owner', 'manager', 'staff'].includes(data.role)}
            isOwner={isOwner}
            onCreate={() => openDocument(kind)}
            onEdit={(r) => openDocument(kind, r)}
            onPost={(r) => setModal({ type: 'post', kind, row: r })}
            onReverse={(r) => setModal({ type: 'reverse', kind, row: r })}
            onDeleteDraft={(r) => setModal({ type: 'deleteDraft', kind, row: r })}
            onCorrect={(r) => setModal({ type: 'correct', kind, row: r })}
          />
        );
      }
      case 'catalog':
        return (
          <Catalog
            data={data}
            repo={repo}
            onChanged={refresh}
            canManage={canPost}
            isOwner={isOwner}
            onCreate={(kind) => setModal({ type: 'master', kind })}
            onEdit={(kind, row) => setModal({ type: 'master', kind, row })}
            onDuplicate={(row) => setModal({ type: 'master', kind: 'products', row, duplicate: true })}
          />
        );
      case 'sales':
      case 'customers':
      case 'inventory':
        return <Suspense fallback={<p>Đang mở phân hệ V2…</p>}><SalesWorkspace key={current[0]} repo={repo} data={data} view={current[0]} onModalChange={setSalesModalOpen} /></Suspense>;
      case 'foundation':
        return <Suspense fallback={<p>Đang mở nền tảng thương mại…</p>}><CommerceFoundation repo={repo} data={data} onModalChange={setSalesModalOpen} /></Suspense>;
      case 'live':
        return <Suspense fallback={<p>Đang mở bàn live…</p>}><LiveCommerce repo={repo} data={data} onModalChange={setSalesModalOpen} /></Suspense>;
      case 'reconciliation':
        return <Reconciliation data={data} repo={repo} onDone={refresh} isOwner={isOwner} />;
      case 'reports':
        return useCloud ? (
          <CloudReport repo={repo} data={data} from={from} to={to} />
        ) : (
          <Reports data={data} from={from} to={to} />
        );
      case 'audit':
        return <Audit data={data} />;
      case 'settings':
        return (
          <>
            <TeamManagement
              repo={repo}
              data={data}
              onChanged={async () => {
                await refreshMemberships();
                await refresh();
              }}
            />
            <Settings
              data={data}
              mode={repo.mode}
              onSample={sample}
              onReset={() => setModal({ type: 'reset' })}
            />
          </>
        );
      default:
        return (
          <Overview
            data={data}
            from={from}
            to={to}
            onNavigate={navigate}
            onSample={sample}
            mode={repo.mode}
          />
        );
    }
  }
  return (
    <div className="app-shell">
      {mobile && <div className="sidebar-scrim" onClick={() => setMobile(false)} />}
      <aside className={`sidebar ${mobile ? 'open' : ''}`}>
        <div className="brand-row">
          <a className="brand" href="#/overview">
            ChiDi<span>ERP</span>
          </a>
          <button
            className="icon-button mobile-only"
            aria-label="Đóng menu"
            onClick={() => setMobile(false)}
          >
            <X size={20} />
          </button>
        </div>
        <div className="workspace-tag">
          <span className="workspace-logo">C</span>
          <div>
            <strong>{chosen?.workspaces.name || data?.workspace.name || 'ChiDi Shop'}</strong>
            <small>{useCloud ? 'Không gian quản trị' : 'Bản chạy thử trên máy'}</small>
          </div>
        </div>
        {useCloud && workspaces.length > 0 && (
          <div className="workspace-selector">
            <label htmlFor="workspace-select">Workspace đang làm việc</label>
            <select
              id="workspace-select"
              aria-label="Workspace đang làm việc"
              disabled={Boolean(modal) || salesModalOpen}
              value={chosen?.workspace_id || ''}
              onChange={(e) => chooseWorkspace(e.target.value)}
            >
              {workspaces.map((w) => (
                <option key={w.workspace_id} value={w.workspace_id}>
                  {w.workspaces.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <span className="nav-heading">ĐIỀU HÀNH</span>
        <nav aria-label="Điều hướng chính">
          {NAV.map(([id, label, Icon]) => (
            <button
              key={id}
              className={current[0] === id ? 'active' : ''}
              onClick={() => navigate(id)}
              aria-current={current[0] === id ? 'page' : undefined}
            >
              <Icon size={19} />
              <span>{label}</span>
              {id === 'reconciliation' && data && (
                <small>
                  {data.purchase_receipts.filter((r) => r.status === 'draft').length +
                    data.cash_transactions.filter((r) => r.status === 'draft').length}
                </small>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-help">
            <ShieldCheck size={19} />
            <strong>Ghi đúng. Giữ rõ.</strong>
            <p>Mỗi chứng từ đều có trạng thái và dấu vết đối chiếu.</p>
          </div>
          <div className="user-row">
            <div className="avatar">
              {useCloud ? (session?.user.email || 'C')[0].toUpperCase() : 'C'}
            </div>
            <div>
              <strong>{useCloud ? session?.user.email : 'Chủ shop · chạy thử'}</strong>
              <small>{data?.role || 'owner'} · ChiDi ERP V2.0</small>
            </div>
            {useCloud && (
              <button
                className="icon-button"
                aria-label="Đăng xuất"
                onClick={() => supabase.auth.signOut()}
              >
                <LogOut size={17} />
              </button>
            )}
          </div>
        </div>
      </aside>
      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-only"
              aria-label="Mở menu"
              onClick={() => setMobile(true)}
            >
              <Menu size={22} />
            </button>
            <span>ChiDi Shop</span>
            <ChevronRight size={14} />
            <strong>{current[1]}</strong>
          </div>
          <div className={`environment ${useCloud ? 'online' : 'local'}`}>
            <span />
            {useCloud ? 'Supabase online' : 'Chạy thử · lưu trên máy'}
          </div>
        </header>
        <div className="page-content">
          <div className="page-heading">
            <div>
              <h1>{current[1]}</h1>
              <p>{current[3]}</p>
            </div>
            <div className={`date-controls ${['sales', 'customers', 'inventory', 'foundation', 'live'].includes(current[0]) ? 'sales-hide-period' : ''}`}>
              <label>
                Kỳ báo cáo
                <input
                  aria-label="Từ ngày báo cáo"
                  type="date"
                  value={from}
                  max={to}
                  onChange={(e) => {
                    if (validDate(e.target.value) && e.target.value <= to) setFrom(e.target.value);
                  }}
                />
              </label>
              <span>—</span>
              <label>
                Đến ngày
                <input
                  aria-label="Đến ngày báo cáo"
                  type="date"
                  value={to}
                  min={from}
                  onChange={(e) => {
                    if (validDate(e.target.value) && e.target.value >= from) setTo(e.target.value);
                  }}
                />
              </label>
              <button
                className="icon-button reload"
                aria-label="Tải lại dữ liệu"
                onClick={() => refresh().catch(() => {})}
              >
                <RefreshCw size={17} />
              </button>
            </div>
          </div>
          <ErrorMessage error={loadError} />
          {useCloud && <ErrorMessage error={cloudError} />}
          <div key={contextKey}>{content()}</div>
        </div>
      </main>
      {toast && (
        <div className="toast" role="status">
          <Check size={18} />
          {toast}
          <button aria-label="Đóng thông báo" onClick={() => setToast('')}>
            <X size={15} />
          </button>
        </div>
      )}
      {modal?.type === 'document' && (
        <DocumentForm
          kind={modal.kind}
          row={modal.row}
          data={data}
          repo={repo}
          onDone={refresh}
          onClose={closeModal}
        />
      )}
      {modal?.type === 'master' && (
        <MasterForm
          kind={modal.kind}
          row={modal.row}
          duplicate={modal.duplicate}
          data={data}
          repo={repo}
          onDone={refresh}
          onClose={closeModal}
        />
      )}
      {['post', 'reverse', 'correct', 'deleteDraft', 'reset'].includes(modal?.type) && (
        <ConfirmAction action={modal} repo={repo} onDone={refresh} onClose={closeModal}
          onCorrected={(replacement) => setModal({ type: 'document', kind: modal.kind, row: replacement })} />
      )}
    </div>
  );
}
