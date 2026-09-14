import { useEffect, useState } from 'react';
import { Users, RefreshCw, Plus, ShieldCheck, ArrowDownToLine, LoaderCircle } from 'lucide-react';
import {
  Panel,
  Table,
  Field,
  Select,
  ErrorMessage,
  Modal,
  Badge,
  ExportButton,
} from '../components.jsx';
import { categoryLabel, dateLabel, validDate } from '../lib/domain.js';

const roleOptions = [
  { value: 'viewer', label: 'Chỉ xem' },
  { value: 'staff', label: 'Nhân viên lập phiếu' },
  { value: 'manager', label: 'Quản lý / ghi sổ' },
  { value: 'owner', label: 'Chủ shop' },
];
const roleLabel = (role) => roleOptions.find((r) => r.value === role)?.label || role;
const integerString = (value) => {
  if (!/^-?\d+$/.test(String(value))) throw new Error('Báo cáo trả về số nguyên không hợp lệ.');
  return BigInt(value);
};
const exactMoney = (value) =>
  value === null
    ? 'Chưa xác nhận'
    : new Intl.NumberFormat('vi-VN', {
        style: 'currency',
        currency: 'VND',
        maximumFractionDigits: 0,
      }).format(integerString(value));
const exactQty = (value) => new Intl.NumberFormat('vi-VN').format(integerString(value));

export function CloudReport({ repo, from, to }) {
  const [report, setReport] = useState(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    let alive = true;
    setReport(null);
    setError('');
    if (!validDate(from) || !validDate(to) || from > to) {
      setError('Chọn khoảng ngày báo cáo hợp lệ.');
      setLoading(false);
      return;
    }
    setLoading(true);
    repo
      .report(from, to)
      .then((value) => {
        if (alive) setReport(value);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [repo, from, to, revision]);
  if (loading)
    return (
      <div className="loading-screen">
        <LoaderCircle className="spin" />
        <p>Đang tổng hợp báo cáo trên database…</p>
      </div>
    );
  if (error)
    return (
      <Panel title="Chưa lấy được báo cáo">
        <ErrorMessage error={error} />
        <div className="operations-padding">
          <button className="button secondary" onClick={() => setRevision((r) => r + 1)}>
            <RefreshCw size={16} />
            Thử lại
          </button>
        </div>
      </Panel>
    );
  if (!report) return null;
  const o = report.overview;
  const csvRows = [
    [
      'Tài khoản',
      'Trạng thái số dư',
      'Ngày mở sổ',
      'Số dư đầu kỳ',
      'Mở sổ trong kỳ',
      'Thu',
      'Chi',
      'Số dư cuối kỳ',
    ],
    ...report.cash_accounts.map((a) => [
      a.code,
      a.state,
      a.opening_date,
      a.opening_cash,
      a.openings_in_period,
      a.cash_in,
      a.cash_out,
      a.closing_cash,
    ]),
  ];
  return (
    <>
      <div className="notice">
        <ShieldCheck size={21} />
        <span>
          <strong>Số liệu tính trực tiếp trên PostgreSQL</strong> · Cùng một lần tổng hợp, từ{' '}
          {dateLabel(from)} đến {dateLabel(to)}. Chỉ có phát sinh đã ghi và chứng từ đảo; chưa phải
          P&amp;L đầy đủ.
        </span>
      </div>
      {report.warnings.map((w) => (
        <div className="soft-note" key={w.code}>
          {w.message}
        </div>
      ))}
      <div className="kpi-grid three">
        {[
          ['Tiền thu trong kỳ', o.cash_in],
          ['Tiền chi trong kỳ', o.cash_out],
          ['Chênh lệch tiền', o.net_cash_flow],
        ].map(([label, value]) => (
          <article className="kpi" key={label}>
            <div className="kpi-top">{label}</div>
            <strong>{exactMoney(value)}</strong>
          </article>
        ))}
      </div>
      <Panel
        title="Số dư tiền có đối chiếu"
        note={`Tổng hợp lúc ${new Date(report.generated_at).toLocaleString('vi-VN')}`}
        action={
          <div className="toolbar">
            <ExportButton name={`chidi-cash-report-${to}.csv`} rows={csvRows} />
            <button
              className="icon-button"
              aria-label="Cập nhật báo cáo"
              onClick={() => setRevision((r) => r + 1)}
            >
              <RefreshCw size={17} />
            </button>
          </div>
        }
      >
        <Table
          headers={['Tài khoản', 'Ngày mở sổ', 'Đầu kỳ', 'Mở trong kỳ', 'Thu', 'Chi', 'Cuối kỳ']}
          empty={!report.cash_accounts.length}
        >
          {report.cash_accounts.map((a) => (
            <tr key={a.id}>
              <td>
                <strong>{a.name}</strong>
                <small>{a.code}</small>
              </td>
              <td>{dateLabel(a.opening_date)}</td>
              {a.state === 'included' ? (
                <>
                  {[
                    'opening_cash',
                    'openings_in_period',
                    'cash_in',
                    'cash_out',
                    'closing_cash',
                  ].map((k) => (
                    <td className="numeric" key={k}>
                      {exactMoney(a[k])}
                    </td>
                  ))}
                </>
              ) : (
                <td colSpan={5}>
                  <Badge status="draft">
                    {a.state === 'unconfirmed'
                      ? 'Chưa xác nhận số dư đầu'
                      : 'Ngày mở sổ sau kỳ báo cáo'}
                  </Badge>
                </td>
              )}
            </tr>
          ))}
        </Table>
        <div className="soft-note">
          Đầu kỳ {exactMoney(o.opening_cash)} + mở sổ trong kỳ {exactMoney(o.openings_in_period)} +
          thu − chi = cuối kỳ {exactMoney(o.closing_cash)}. Chênh lệch kiểm tra:{' '}
          {exactMoney(o.reconciliation_difference)}. Tổng số dư chỉ gồm tài khoản đã xác nhận phù
          hợp ngày.
        </div>
      </Panel>
      <div className="dashboard-grid">
        <Panel
          title="Dòng tiền theo nhóm"
          note="Chi ròng đã trừ phát sinh đảo. Thu COD không tạo thêm doanh thu."
        >
          <Table
            headers={['Nhóm', 'Thu', 'Chi', 'Chi ròng']}
            empty={!report.cash_categories.length}
          >
            {report.cash_categories.map((c) => (
              <tr key={c.category}>
                <td>{categoryLabel(c.category)}</td>
                <td className="numeric">{exactMoney(c.cash_in)}</td>
                <td className="numeric">{exactMoney(c.cash_out)}</td>
                <td className="numeric">
                  {exactMoney((-integerString(c.net_cash_flow)).toString())}
                </td>
              </tr>
            ))}
          </Table>
        </Panel>
        <Panel
          title="Nhận hàng và đảo trong kỳ"
          note="Chưa có xuất bán / hoàn bán, nên chưa đại diện tồn kho thực tế."
        >
          <div className="operations-padding">
            <p>
              Số lượng ròng trong kỳ: <strong>{exactQty(o.purchase_qty)}</strong>
            </p>
            <p>
              Giá trị ròng trong kỳ: <strong>{exactMoney(o.purchase_amount)}</strong>
            </p>
            <p>
              Số lượng đến cuối kỳ: <strong>{exactQty(o.stock_qty_as_of)}</strong>
            </p>
            <p>
              Giá trị đến cuối kỳ: <strong>{exactMoney(o.stock_value_as_of)}</strong>
            </p>
          </div>
        </Panel>
      </div>
      <Panel title="Kho nhận theo SKU đến cuối kỳ">
        <Table
          headers={[
            'SKU',
            'Sản phẩm',
            'SL trong kỳ',
            'Giá trị trong kỳ',
            'SL cuối kỳ',
            'Giá trị cuối kỳ',
          ]}
          empty={!report.stock_by_sku.length}
        >
          {report.stock_by_sku.map((p) => (
            <tr key={p.product_id}>
              <td className="mono">{p.code}</td>
              <td>{p.name}</td>
              <td className="numeric">{exactQty(p.qty_in_period)}</td>
              <td className="numeric">{exactMoney(p.amount_in_period)}</td>
              <td className="numeric">{exactQty(p.qty_as_of)}</td>
              <td className="numeric">{exactMoney(p.amount_as_of)}</td>
            </tr>
          ))}
        </Table>
      </Panel>
    </>
  );
}

export function TeamManagement({ repo, data, onChanged }) {
  const [rows, setRows] = useState([]),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [email, setEmail] = useState(''),
    [role, setRole] = useState('viewer'),
    [busy, setBusy] = useState(false),
    [action, setAction] = useState(null),
    [revision, setRevision] = useState(0);
  const allowed = repo.mode === 'cloud' && data.role === 'owner';
  useEffect(() => {
    let alive = true;
    setRows([]);
    setError('');
    if (!allowed) return;
    setLoading(true);
    repo
      .listMembers()
      .then((r) => {
        if (alive) setRows(r);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [repo, allowed, revision]);
  async function add(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await repo.addMember(email.trim(), role);
      setEmail('');
      setRole('viewer');
      setMessage('Đã cấp quyền cho tài khoản đã đăng ký.');
      setRevision((n) => n + 1);
      await onChanged();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function change() {
    setBusy(true);
    setError('');
    try {
      if (action.type === 'remove') await repo.removeMember(action.row.user_id);
      else await repo.setMemberRole(action.row.user_id, action.role);
      setAction(null);
      setMessage('Đã cập nhật thành viên và lưu nhật ký.');
      setRevision((n) => n + 1);
      await onChanged();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel
      title="Thành viên và quyền"
      note="Mỗi người dùng tài khoản riêng; chủ shop quản lý quyền trong workspace đang chọn."
    >
      {!allowed ? (
        <div className="operations-padding">
          <div className="notice">
            <Users size={20} />
            <span>
              {repo.mode === 'demo'
                ? 'Quản lý thành viên chỉ hoạt động trên Supabase. Bản chạy thử không giả lập bảo mật nhiều người.'
                : 'Bạn không có quyền quản lý thành viên. Liên hệ chủ shop khi cần thay đổi quyền.'}
            </span>
          </div>
        </div>
      ) : (
        <>
          <form className="member-form" onSubmit={add}>
            <Field label="Email đã đăng ký và xác nhận">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="off"
                maxLength={254}
              />
            </Field>
            <Field label="Quyền cấp">
              <Select value={role} onChange={(e) => setRole(e.target.value)} items={roleOptions} />
            </Field>
            <button className="button primary" disabled={busy}>
              <Plus size={16} />
              Thêm thành viên
            </button>
          </form>
          <div className="soft-note">
            Thành viên cần tự đăng ký và xác nhận email trước. Thao tác này cấp quyền ERP, không gửi
            thư mời và không cấp quyền quản trị Supabase.
          </div>
          <ErrorMessage error={error} />
          {message && (
            <p className="success-message operations-padding" role="status">
              {message}
            </p>
          )}
          {loading ? (
            <p className="operations-padding">Đang tải thành viên…</p>
          ) : (
            <Table
              headers={['Thành viên', 'Vai trò', 'Thay đổi quyền', 'Thao tác']}
              empty={!rows.length}
            >
              {rows.map((row) => (
                <tr key={row.user_id}>
                  <td>
                    <strong>
                      {row.email_hint}
                      {row.is_self && ' · bạn'}
                    </strong>
                    <small className="mono">{row.user_id}</small>
                  </td>
                  <td>{roleLabel(row.role)}</td>
                  <td>
                    <select
                      aria-label={`Đổi quyền ${row.email_hint}`}
                      disabled={busy}
                      value={row.role}
                      onChange={(e) => setAction({ type: 'role', row, role: e.target.value })}
                    >
                      {roleOptions.map((r) => (
                        <option key={r.value} value={r.value}>
                          {r.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <button
                      className="small-button muted"
                      disabled={busy || row.is_self}
                      onClick={() => setAction({ type: 'remove', row })}
                    >
                      Thu hồi quyền
                    </button>
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </>
      )}
      {action && (
        <Modal
          title={
            action.type === 'remove' ? 'Thu hồi quyền thành viên' : 'Thay đổi quyền thành viên'
          }
          onClose={() => {
            if (!busy) setAction(null);
          }}
        >
          <div className="operations-padding">
            <p>
              {action.row.email_hint} · {action.row.user_id}
            </p>
            <p>
              {action.type === 'remove'
                ? 'Người này sẽ mất quyền truy cập workspace này.'
                : `Vai trò mới: ${roleLabel(action.role)}.`}
            </p>
            <p>Hệ thống chặn việc làm workspace mất chủ shop cuối cùng.</p>
            <ErrorMessage error={error} />
          </div>
          <footer className="modal-actions">
            <button className="button secondary" disabled={busy} onClick={() => setAction(null)}>
              Hủy
            </button>
            <button className="button primary" disabled={busy} onClick={change}>
              Xác nhận thay đổi
            </button>
          </footer>
        </Modal>
      )}
    </Panel>
  );
}
