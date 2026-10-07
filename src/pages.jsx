import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import {
  ArrowUpRight,
  ArrowDownRight,
  Package,
  Wallet,
  Clock3,
  Plus,
  Check,
  FileSearch,
  Pencil,
  RotateCcw,
  Upload,
  FileJson,
  ShieldCheck,
  Database,
  BookOpen,
  ArrowRight,
  Download,
} from 'lucide-react';
import {
  Badge,
  Panel,
  Empty,
  SearchBox,
  Table,
  ExportButton,
  ErrorMessage,
  Modal,
  Field,
} from './components.jsx';
import {
  money,
  number,
  dateLabel,
  statistics,
  categoryLabel,
  CATEGORIES,
  download,
  validateImport,
  today,
  sum,
} from './lib/domain.js';
import { sampleImport } from './demo-sample.js';
import ExpenseCategories from './features/ExpenseCategories.jsx';
const BankStatementImport = lazy(() => import('./features/BankStatementImport.jsx'));

const nameOf = (data, table, id) => data[table].find((r) => r.id === id)?.name || 'Chưa xác định';
const codeOf = (data, id) => data.products.find((r) => r.id === id)?.code || 'Chưa có SKU';
const cashCategoryName = (data, code) =>
  data.expense_categories?.find((r) => r.code === code)?.name || categoryLabel(code);
const searchRows = (rows, search) =>
  rows.filter((r) =>
    JSON.stringify(r).toLocaleLowerCase('vi').includes(search.toLocaleLowerCase('vi')),
  );
const shortId = (row) => row.provenance?.kind === 'bank_statement'
  ? `NH-${String(row.source_id || '').slice(0, 8).toUpperCase()}-${row.provenance.row_number}`
  : row.legacy_id || `CD-${row.id.slice(0, 8).toUpperCase()}`;

export function Overview({ data, from, to, onNavigate, onSample, mode }) {
  const stats = statistics(data, from, to);
  const pendingAmount = sum(stats.pendingPurchases, (r) => r.total_amount);
  const pendingCash = sum(
    stats.pendingCash.filter((r) => r.direction === 'out'),
    (r) => r.amount,
  );
  const cards = [
    [
      'Tiền hàng chờ xác nhận',
      money(pendingAmount),
      `${stats.pendingPurchases.length} phiếu · toàn bộ kỳ`,
      Clock3,
      'amber',
    ],
    [
      'Kho từ phiếu đã ghi',
      number(stats.units) + ' sản phẩm',
      `Giá trị: ${money(stats.stockValue)}`,
      Package,
      'green',
    ],
    [
      'Chi tiền chờ xác nhận',
      money(pendingCash),
      `${stats.pendingCash.length} phiếu thu / chi · toàn bộ kỳ`,
      Wallet,
      'amber',
    ],
    [
      'Dòng tiền đã ghi trong kỳ',
      money(stats.cashIn - stats.cashOut),
      `Thu ${money(stats.cashIn)} · Chi ${money(stats.cashOut)}`,
      ArrowUpRight,
      'green',
    ],
  ];
  const totalDraft = stats.pendingCash.length + stats.pendingPurchases.length;
  const bySupplier = data.suppliers
    .map((s) => ({
      name: s.name,
      value: sum(
        data.purchase_receipts.filter((r) => r.supplier_id === s.id && r.status === 'draft'),
        (r) => r.total_amount,
      ),
    }))
    .filter((r) => r.value)
    .sort((a, b) => b.value - a.value)
    .slice(0, 5);
  const largest = Math.max(...bySupplier.map((r) => r.value), 1);
  return (
    <>
      <div className="overview-intro">
        <div>
          <span className="eyebrow">KHÔNG GIAN VẬN HÀNH</span>
          <h2>
            Nhìn rõ số liệu.
            <br />
            <span>Chủ động mỗi quyết định.</span>
          </h2>
          <p>Theo dõi nhập hàng và dòng tiền, từ chứng từ nguồn đến từng lần xác nhận.</p>
        </div>
        <div className="intro-note">
          <span className="live-dot" />
          <strong>{mode === 'demo' ? 'Môi trường chạy thử' : 'Đang kết nối Supabase'}</strong>
          <p>
            {mode === 'demo'
              ? 'Thao tác ở đây chỉ lưu trong trình duyệt này. Dữ liệu minh họa tách riêng dữ liệu shop.'
              : 'Quyền truy cập và việc ghi sổ được kiểm tra tại database.'}
          </p>
          <button className="text-button" onClick={() => onNavigate('reconciliation')}>
            Đi tới khu vực đối chiếu <ArrowRight size={16} />
          </button>
        </div>
      </div>
      <div className="kpi-grid">
        {cards.map(([label, value, note, Icon, tone]) => (
          <article className="kpi" key={label}>
            <div className="kpi-top">
              <span>{label}</span>
              <Icon size={19} className={tone} />
            </div>
            <strong>{value}</strong>
            <small>{note}</small>
          </article>
        ))}
      </div>
      <div className="dashboard-grid">
        <Panel title="Cần xử lý hôm nay" note="Xác nhận đúng căn cứ trước khi đưa vào sổ.">
          <button className="task-row" onClick={() => onNavigate('purchases')}>
            <span className="task-icon amber-bg">
              <Package size={19} />
            </span>
            <span>
              <strong>Phiếu nhập chờ xác nhận</strong>
              <small>Kiểm tra SKU, nhà cung cấp và ngày nhận</small>
            </span>
            <b>{stats.pendingPurchases.length}</b>
            <ArrowUpRight size={18} />
          </button>
          <button className="task-row" onClick={() => onNavigate('cash')}>
            <span className="task-icon teal-bg">
              <Wallet size={19} />
            </span>
            <span>
              <strong>Thu chi chờ ghi sổ</strong>
              <small>Bổ sung ngày thật, tài khoản và chứng từ</small>
            </span>
            <b>{stats.pendingCash.length}</b>
            <ArrowUpRight size={18} />
          </button>
          <button className="task-row" onClick={() => onNavigate('catalog')}>
            <span className="task-icon gray-bg">
              <FileSearch size={19} />
            </span>
            <span>
              <strong>SKU tạm cần rà soát</strong>
              <small>Giữ riêng các mẫu hàng chưa xác định</small>
            </span>
            <b>{data.products.filter((r) => r.provisional).length}</b>
            <ArrowUpRight size={18} />
          </button>
          <div className="soft-note">
            {totalDraft
              ? `${totalDraft} chứng từ đang chờ; chưa cộng vào kho và dòng tiền đã ghi.`
              : 'Chưa có chứng từ chờ. Tạo mới hoặc nhập bộ dữ liệu để bắt đầu.'}
          </div>
        </Panel>
        <Panel
          title="Tiền hàng chờ theo nhà cung cấp"
          note="Giá trị chứng từ nháp · chưa phải công nợ phải trả"
        >
          {bySupplier.length ? (
            <div className="bars">
              {bySupplier.map((r) => (
                <div key={r.name}>
                  <div className="bar-label">
                    <span>{r.name}</span>
                    <strong>{money(r.value)}</strong>
                  </div>
                  <div className="bar-track">
                    <span style={{ width: `${(r.value / largest) * 100}%` }} />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <Empty title="Chưa có phiếu nhập" />
          )}
        </Panel>
      </div>
      <Panel
        title="Hoạt động gần đây"
        action={
          <button className="text-button" onClick={() => onNavigate('audit')}>
            Xem nhật ký <ArrowRight size={15} />
          </button>
        }
      >
        {data.audit_events.length ? (
          <div className="recent-list">
            {[...data.audit_events]
              .sort((a, b) => b.created_at.localeCompare(a.created_at))
              .slice(0, 4)
              .map((r) => (
                <div key={r.id}>
                  <span className="activity-dot" />
                  <strong>{eventLabel(r.action)}</strong>
                  <span>{new Date(r.created_at).toLocaleString('vi-VN')}</span>
                </div>
              ))}
          </div>
        ) : (
          <Empty
            title="Sẵn sàng cho dữ liệu đầu tiên"
            action={
              mode === 'demo' ? (
                <button className="button secondary" onClick={onSample}>
                  Nạp dữ liệu minh họa
                </button>
              ) : null
            }
          >
            Bắt đầu bằng danh mục, hoặc mở Đối chiếu để nhập file JSON đã chuyển từ Excel.
          </Empty>
        )}
      </Panel>
      <p className="page-footnote">
        Kho V1 hiện phản ánh phiếu nhập và chứng từ đảo đã ghi; chưa gồm bán hàng / xuất kho. Số 0
        không có nghĩa shop không hoạt động.
      </p>
    </>
  );
}

export function Documents({
  kind,
  data,
  onCreate,
  onEdit,
  onPost,
  onReverse,
  onDeleteDraft,
  onCorrect,
  onViewSource,
  canPost,
  isOwner,
  canDraft,
}) {
  const [search, setSearch] = useState(''),
    [status, setStatus] = useState('all');
  const [categoryFilter, setCategoryFilter] = useState('');
  const purchase = kind === 'purchase';
  const all = data[purchase ? 'purchase_receipts' : 'cash_transactions'];
  const rows = searchRows(
    all.map((r) => ({
      ...r,
      _supplier: nameOf(data, 'suppliers', r.supplier_id),
      _product: codeOf(data, r.product_id),
      _account: nameOf(data, 'cash_accounts', r.account_id),
    })),
    search,
  )
    .filter((r) => status === 'all' || r.status === status)
    .filter((r) => purchase || !categoryFilter || r.category === categoryFilter)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const csvRows = purchase
    ? [
        [
          'Mã',
          'Ngày',
          'SKU',
          'NCC',
          'Số lượng',
          'Đơn giá',
          'Tổng tiền',
          'Trạng thái',
          'Ngày ước tính',
          'SHA-256 nguồn',
          'Vị trí nguồn',
        ],
        ...rows.map((r) => [
          shortId(r),
          r.received_date,
          r._product,
          r._supplier,
          r.qty,
          r.unit_cost,
          r.total_amount,
          r.status,
          r.date_estimated ? 'Có' : 'Không',
          r.source_id || '',
          r.provenance?.source_range || '',
        ]),
      ]
    : [
        [
          'Mã',
          'Ngày',
          'Nội dung',
          'Chiều',
          'Nhóm',
          'Tài khoản',
          'Số tiền',
          'Trạng thái',
          'Ngày ước tính',
          'SHA-256 nguồn',
          'Vị trí nguồn',
        ],
        ...rows.map((r) => [
          shortId(r),
          r.transaction_date,
          r.description,
          r.direction,
          cashCategoryName(data, r.category),
          r._account,
          r.amount,
          r.status,
          r.date_estimated ? 'Có' : 'Không',
          r.source_id || '',
          r.provenance?.source_range || '',
        ]),
      ];
  return (
    <Panel>
      <div className="list-tools">
        <div className="segments" aria-label="Lọc trạng thái">
          {[
            ['all', 'Tất cả'],
            ['draft', 'Chờ xác nhận'],
            ['posted', 'Đã ghi sổ'],
            ['reversed', 'Đã đảo'],
            ['deleted', 'Đã xóa nháp'],
          ].map(([v, l]) => (
            <button key={v} className={status === v ? 'selected' : ''} onClick={() => setStatus(v)}>
              {l}
              {v === 'draft' && <span>{all.filter((r) => r.status === 'draft').length}</span>}
            </button>
          ))}
        </div>
        <div className="toolbar">
          <SearchBox value={search} onChange={setSearch} />
          {!purchase && <select aria-label="Lọc nhóm thu chi" value={categoryFilter}
            onChange={(event) => setCategoryFilter(event.target.value)}>
            <option value="">Mọi nhóm thu chi</option>
            {(data.expense_categories || []).map((c) => <option key={c.id} value={c.code}>{c.name}</option>)}
          </select>}
          {(search || status !== 'all' || categoryFilter) && <button className="button secondary" onClick={() => {
            setSearch('');setStatus('all');setCategoryFilter('');
          }}>Xóa bộ lọc</button>}
          <ExportButton name={`chidi-${kind}-${today()}.csv`} rows={csvRows} />
          {canDraft && (
            <button className="button primary" onClick={onCreate}>
              <Plus size={17} />
              Tạo {purchase ? 'phiếu nhập' : 'thu chi'}
            </button>
          )}
        </div>
      </div>
      <Table
        headers={
          purchase
            ? [
                'Chứng từ / ngày',
                'Sản phẩm',
                'Nhà cung cấp',
                'SL',
                'Tiền hàng + phí',
                'Trạng thái',
                'Thao tác',
              ]
            : [
                'Chứng từ / ngày',
                'Nội dung',
                'Nhóm thu chi',
                'Tài khoản',
                'Số tiền',
                'Trạng thái',
                'Thao tác',
              ]
        }
        empty={!rows.length}
      >
        {rows.map((r) => (
          <tr key={r.id}>
            <td>
              <strong className="mono">{shortId(r)}</strong>
              <small>
                {dateLabel(purchase ? r.received_date : r.transaction_date)}
                {r.date_estimated && ' · ước tính'}
              </small>
            </td>
            {purchase ? (
              <>
                <td>
                  <strong>{r._product}</strong>
                  <small>{nameOf(data, 'products', r.product_id)}</small>
                </td>
                <td>{r._supplier}</td>
                <td className="numeric">{number(r.qty)}</td>
                <td className="numeric">
                  <strong>{money(r.total_amount)}</strong>
                  <small>{money(r.unit_cost)} / sản phẩm</small>
                </td>
              </>
            ) : (
              <>
                <td>
                  <strong>{r.description || 'Chưa có nội dung'}</strong>
                  <small>{r.provenance?.kind === 'bank_statement'
                    ? `Sao kê ${r.provenance.source_name} · dòng ${r.provenance.row_number}`
                    : r.legacy_id ? 'Có tham chiếu nguồn' : 'Nhập trực tiếp'}</small>
                  {r.provenance?.kind === 'bank_statement' && onViewSource &&
                    <button className="text-button" onClick={() => onViewSource(r)}>Xem file nguồn</button>}
                </td>
                <td>{cashCategoryName(data, r.category)}</td>
                <td>{r._account}</td>
                <td className={`numeric ${r.direction === 'in' ? 'positive' : ''}`}>
                  <strong>
                    {r.direction === 'in' ? '+' : '−'}
                    {money(r.amount)}
                  </strong>
                </td>
              </>
            )}
            <td>
              <Badge status={r.status} />
            </td>
            <td>
              <div className="row-actions">
                {r.status === 'draft' && canDraft ? (
                  <>
                    <button
                      className="icon-button"
                      aria-label={`Sửa ${shortId(r)}`}
                      title="Sửa chứng từ"
                      onClick={() => onEdit(r)}
                    >
                      <Pencil size={15} />
                    </button>
                    {canPost && (
                      <button className="small-button" onClick={() => onPost(r)}>
                        <Check size={14} />
                        Ghi sổ
                      </button>
                    )}
                    <button className="small-button muted" onClick={() => onDeleteDraft(r)}>
                      Xóa nháp
                    </button>
                  </>
                ) : r.status === 'posted' && isOwner ? (
                  <>
                    <button className="small-button muted" onClick={() => onReverse(r)}>
                      <RotateCcw size={14} />
                      Đảo
                    </button>
                    <button className="small-button" onClick={() => onCorrect(r)}>
                      Đảo + tạo bản sửa
                    </button>
                  </>
                ) : (
                  <span className="muted-text">Đã khóa</span>
                )}
              </div>
            </td>
          </tr>
        ))}
      </Table>
      <div className="table-footer">
        {rows.length} chứng từ{' '}
        <span>Chứng từ đã ghi được giữ nguyên; sửa sai bằng chứng từ đảo có lý do.</span>
      </div>
    </Panel>
  );
}

export function CashManagement({ repo, onChanged, canManage, ...documentProps }) {
  const [tab, setTab] = useState('transactions');
  const [source, setSource] = useState(null);
  return <>
    <div className="segments expense-tabs" role="group" aria-label="Quản lý thu chi">
      <button className={tab === 'transactions' ? 'selected' : ''} onClick={() => setTab('transactions')}>Giao dịch</button>
      <button className={tab === 'categories' ? 'selected' : ''} onClick={() => setTab('categories')}>Danh mục chi</button>
      <button className={tab === 'bank' ? 'selected' : ''} onClick={() => setTab('bank')}>Nhập sao kê</button>
    </div>
    {tab === 'transactions'
      ? <Documents kind="cash" {...documentProps} onViewSource={(row) => {
          setSource({ batchId: row.provenance.batch_id, rowNumber: row.provenance.row_number });setTab('bank');
        }} />
      : tab === 'categories'
        ? <ExpenseCategories data={documentProps.data} repo={repo} onChanged={onChanged}
            canManage={canManage} isOwner={documentProps.isOwner} />
        : <Suspense fallback={<p>Đang tải chức năng sao kê…</p>}>
            <BankStatementImport data={documentProps.data} repo={repo} onChanged={onChanged}
              initialBatchId={source?.batchId} initialRowNumber={source?.rowNumber} />
          </Suspense>}
  </>;
}

export function Catalog({ data, repo, onChanged, onCreate, onEdit, onDuplicate, isOwner, canManage }) {
  const [kind, setKind] = useState('products'),
    [search, setSearch] = useState('');
  const [action, setAction] = useState(null), [reason, setReason] = useState(''),
    [impact, setImpact] = useState(null), [actionError, setActionError] = useState(''),
    [busy, setBusy] = useState(false);
  const tabs = [
    ['products', 'Sản phẩm / SKU'],
    ['product_categories', 'Nhóm sản phẩm'],
    ['suppliers', 'Nhà cung cấp'],
    ['cash_accounts', 'Tài khoản tiền'],
    ['warehouses', 'Kho hàng'],
  ];
  const rows = searchRows(data[kind] || [], search);
  useEffect(() => {
    if (action?.type !== 'delete' || action.kind !== 'products') return;
    let active = true;
    repo.getCatalogProductUsage(action.row.id)
      .then((value) => { if (active) setImpact(value); })
      .catch((error) => { if (active) setActionError(error.message); });
    return () => { active = false; };
  }, [action, repo]);
  function openAction(next, event) {
    const menu = event?.currentTarget.closest('details');
    if (menu) menu.open = false;
    setReason('');setImpact(null);setActionError('');setAction(next);
  }
  async function confirmAction(event) {
    event.preventDefault();
    if (!action || reason.trim().length < 10) return;
    setBusy(true);setActionError('');
    try {
      const { row, type } = action;
      if (action.kind === 'products') {
        if (type === 'delete') await repo.deleteCatalogProduct(row.id, reason);
        else await repo.setCatalogProductArchived(row.id, type === 'archive', reason);
      } else {
        if (type === 'delete') await repo.deleteProductCategory(row.id, reason);
        else await repo.setProductCategoryArchived(row.id, type === 'archive', reason);
      }
      await onChanged(`Đã ${type === 'delete' ? 'xóa' : type === 'archive' ? 'lưu trữ' : 'khôi phục'} danh mục.`);
      setAction(null);
    } catch (error) { setActionError(error.message); }
    finally { setBusy(false); }
  }
  return (
    <><Panel>
      <div className="list-tools">
        <div className="segments">
          {tabs.map(([v, l]) => (
            <button
              key={v}
              className={kind === v ? 'selected' : ''}
              onClick={() => {
                setKind(v);
                setSearch('');
              }}
            >
              {l}
              <span>{(data[v] || []).length}</span>
            </button>
          ))}
        </div>
        <div className="toolbar">
          <SearchBox value={search} onChange={setSearch} />
          {canManage && (kind !== 'cash_accounts' || isOwner) && (
            <button className="button primary" onClick={() => onCreate(kind)}>
              <Plus size={17} />
              Thêm danh mục
            </button>
          )}
        </div>
      </div>
      <Table
        headers={[
          'Mã',
          'Tên',
          kind === 'products'
            ? 'Giá tham khảo'
            : kind === 'product_categories'
              ? 'Mô tả / cấp nhóm'
            : kind === 'cash_accounts'
              ? 'Số dư đầu'
              : 'Ghi chú',
          'Tình trạng',
          '',
        ]}
        empty={!rows.length}
      >
        {rows.map((r) => (
          <tr key={r.id}>
            <td className="mono">
              <strong>{r.code || '—'}</strong>
            </td>
            <td><strong>{r.name}</strong>{kind === 'products' && r.category_id &&
              <small>{nameOf(data, 'product_categories', r.category_id)}</small>}</td>
            <td>
              {kind === 'products'
                ? money(r.unit_cost)
                : kind === 'product_categories'
                  ? <>{r.description || '—'}{r.parent_id && <small>Thuộc {nameOf(data, 'product_categories', r.parent_id)}</small>}</>
                : kind === 'cash_accounts'
                  ? r.opening_confirmed
                    ? money(r.opening_balance)
                    : 'Chưa xác nhận'
                  : r.note || '—'}
            </td>
            <td>
              {['products', 'product_categories'].includes(kind) && r.archived_at ? (
                <Badge status="reversed">Đã lưu trữ</Badge>
              ) : kind === 'products' ? (
                <Badge status={r.provisional ? 'draft' : 'posted'}>
                  {r.provisional ? 'SKU tạm' : 'Đã xác nhận SKU'}
                </Badge>
              ) : kind === 'product_categories' ? (
                <Badge status="posted">Đang dùng</Badge>
              ) : kind === 'cash_accounts' ? (
                <>
                  <Badge status={r.opening_confirmed ? 'posted' : 'draft'}>
                    {r.opening_confirmed ? 'Đã mở sổ' : 'Chờ số dư đầu'}
                  </Badge>
                  <small>{dateLabel(r.opening_date)}</small>
                </>
              ) : (
                <Badge status="neutral">Đang sử dụng</Badge>
              )}
            </td>
            <td>
              {canManage && ['products', 'product_categories'].includes(kind) ? (
                <details className="entity-actions">
                  <summary aria-label={`Thao tác ${r.code || r.name}`}>⋯</summary>
                  <div className="entity-actions-list">
                    <button onClick={() => onEdit(kind, r)}>Sửa</button>
                    {kind === 'products' && <button onClick={() => onDuplicate(r)}>Nhân bản</button>}
                    <button onClick={(event) => openAction({ kind, row: r, type: r.archived_at ? 'restore' : 'archive' }, event)}>
                      {r.archived_at ? 'Khôi phục' : 'Lưu trữ'}
                    </button>
                    {isOwner && (kind === 'products' ||
                      (!data.products.some((p) => p.category_id === r.id) &&
                       !(data.product_categories || []).some((c) => c.parent_id === r.id))) &&
                      <button onClick={(event) => openAction({ kind, row: r, type: 'delete' }, event)}>Kiểm tra xóa</button>}
                  </div>
                </details>
              ) : canManage && (kind !== 'cash_accounts' || isOwner) && (
                <button
                  className="icon-button"
                  aria-label={`Sửa ${r.code}`}
                  onClick={() => onEdit(kind, r)}
                >
                  <Pencil size={15} />
                </button>
              )}
            </td>
          </tr>
        ))}
      </Table>
      <div className="table-footer">
        Danh mục dùng chung cho chứng từ.{' '}
        <span>Giá tham khảo không thay đổi đơn giá trên phiếu nhập đã ghi.</span>
      </div>
    </Panel>
    {action && <Modal title={`${action.type === 'delete' ? 'Kiểm tra xóa' : action.type === 'archive' ? 'Lưu trữ' : 'Khôi phục'} ${action.row.code || action.row.name}`}
      onClose={() => setAction(null)}>
      <form onSubmit={confirmAction}>
        <div className="confirm-body">
          {action.type === 'delete' && action.kind === 'products' ? (
            impact ? impact.can_delete ?
              <p>SKU chưa có chứng từ hoặc lịch sử kho. Xóa sẽ giữ lại bản ghi nhật ký thao tác.</p> :
              <p>SKU đã có lịch sử nghiệp vụ; hãy lưu trữ để ngừng sử dụng và giữ nguyên chứng từ.</p>
              : <p>Đang kiểm tra chứng từ, tồn kho và lượt giữ hàng…</p>
          ) : action.type === 'delete' ? (
            <p>{data.products.filter((p) => p.category_id === action.row.id).length} sản phẩm đang ở nhóm này. Nhóm đang dùng chỉ có thể lưu trữ.</p>
          ) : <p>{action.type === 'archive' ? 'Danh mục sẽ ngừng được chọn cho nghiệp vụ mới.' : 'Danh mục sẽ được dùng lại cho nghiệp vụ mới.'} Lịch sử chứng từ vẫn được giữ.</p>}
          <Field label="Lý do thao tác"><textarea required minLength={10} maxLength={4000} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <ErrorMessage error={actionError} />
        </div>
        <footer className="modal-actions"><button type="button" className="button secondary" onClick={() => setAction(null)}>Hủy</button>
          <button className={`button ${action.type === 'delete' ? 'danger' : 'primary'}`} disabled={busy || (action.type === 'delete' && action.kind === 'products' && !impact?.can_delete)}>
            {busy ? 'Đang thực hiện…' : action.type === 'delete' ? 'Xác nhận xóa' : action.type === 'archive' ? 'Lưu trữ' : 'Khôi phục'}</button>
        </footer>
      </form>
    </Modal>}
    </>
  );
}

export function Inventory({ data, to }) {
  const [search, setSearch] = useState('');
  const rows = searchRows(
    data.products.map((p) => {
      const entries = data.stock_movements.filter(
        (m) => m.product_id === p.id && (!to || m.received_date <= to),
      );
      return {
        ...p,
        qty: sum(entries, (r) => r.qty),
        value: sum(entries, (r) => r.amount),
        movements: entries.length,
      };
    }),
    search,
  );
  return (
    <>
      <div className="notice">
        <Package size={19} />
        <span>
          <strong>Kho từ chứng từ nhập đã ghi</strong> · V1 chưa có quy trình bán / xuất / hoàn
          hàng. Đây chưa phải tồn thực tế nếu chưa chuyển đủ số dư đầu và lịch sử bán.
        </span>
      </div>
      <Panel
        title="Theo dõi theo SKU"
        note={`Tính đến ${dateLabel(to)}`}
        action={<SearchBox value={search} onChange={setSearch} />}
      >
        <Table
          headers={['SKU', 'Sản phẩm', 'Tổng SL đã ghi', 'Giá trị đã ghi', 'Số chuyển động']}
          empty={!rows.length}
        >
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="mono">{r.code}</td>
              <td>{r.name}</td>
              <td className="numeric">
                <strong>{number(r.qty)}</strong>
              </td>
              <td className="numeric">{money(r.value)}</td>
              <td>{r.movements}</td>
            </tr>
          ))}
        </Table>
      </Panel>
    </>
  );
}

export function Reconciliation({ data, repo, onDone, isOwner }) {
  const selection = useRef(0);
  useEffect(
    () => () => {
      selection.current++;
    },
    [],
  );
  const [payload, setPayload] = useState(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [result, setResult] = useState(null);
  async function selectFile(event) {
    const ticket = ++selection.current;
    setError('');
    setResult(null);
    setPayload(null);
    const file = event.target.files[0];
    if (!file) return;
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error('File tối đa 10 MB.');
      const parsed = validateImport(JSON.parse(await file.text()));
      if (ticket === selection.current) setPayload(parsed);
    } catch (e) {
      if (ticket === selection.current) setError(e.message);
    }
  }
  async function apply() {
    setBusy(true);
    setError('');
    try {
      const r = await repo.importLegacy(payload);
      setResult(r);
      await onDone('Đã nhập vào khu vực chờ xác nhận.');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="import-layout">
        <Panel
          title="Nhập dữ liệu có đối chiếu"
          note="File JSON được chuyển từ Excel bằng script trong project."
        >
          <label className="dropzone">
            <FileJson size={37} />
            <strong>Chọn file dữ liệu ChiDi</strong>
            <span>JSON · tối đa 10 MB · xem trước rồi mới nhập</span>
            <input
              type="file"
              accept=".json,application/json"
              onChange={selectFile}
              disabled={!isOwner || busy}
            />
          </label>
          <ErrorMessage error={error} />
          {payload && (
            <div className="import-preview">
              <h3>{payload.source_name}</h3>
              <div className="import-counts">
                <span>
                  <b>{payload.products.length}</b> SKU
                </span>
                <span>
                  <b>{payload.purchases.length}</b> phiếu nhập
                </span>
                <span>
                  <b>{payload.cash.length}</b> thu chi
                </span>
              </div>
              {payload.cash.some(
                (r) => !CATEGORIES.some((c) => c[0] === r.category && c[2] === r.direction),
              ) && (
                <div className="soft-note">
                  Có{' '}
                  {
                    payload.cash.filter(
                      (r) => !CATEGORIES.some((c) => c[0] === r.category && c[2] === r.direction),
                    ).length
                  }{' '}
                  dòng chưa phân loại thu chi hợp lệ. Những dòng này cần rà soát trước khi ghi sổ.
                </div>
              )}
              <p>
                Mọi chứng từ được nhập ở trạng thái chờ xác nhận, kể cả dòng Excel đã đánh dấu “Có”.
                Dấu vết nguồn vẫn được giữ.
              </p>
              <button className="button primary" disabled={busy || !isOwner} onClick={apply}>
                <Upload size={17} />
                {busy ? 'Đang nhập...' : 'Nhập vào workspace hiện tại'}
              </button>
            </div>
          )}
          {result && (
            <div className="import-result" role="status">
              <strong>
                {result.already_imported
                  ? 'File này đã được nhập trước đó.'
                  : 'Đã hoàn tất nhập dữ liệu.'}
              </strong>
              <p>
                Thêm {result.inserted_purchases} phiếu nhập và {result.inserted_cash} thu chi. Bỏ
                qua {result.skipped} dòng đã có. {result.conflicts?.length || 0} dòng cần đối chiếu
                thay đổi.
              </p>
              {result.conflicts?.length > 0 && (
                <ul>
                  {result.conflicts.map((r, i) => (
                    <li key={i}>
                      {r.legacy_id}: {r.reason}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </Panel>
        <Panel title="Một dữ liệu, một dấu vết">
          <ol className="steps">
            <li>
              <span>1</span>
              <div>
                <strong>Giữ file nguồn</strong>
                <p>Không ghi đè workbook. Script lưu mã SHA-256, mã dòng và trạng thái nguồn.</p>
              </div>
            </li>
            <li>
              <span>2</span>
              <div>
                <strong>Đối chiếu thay đổi</strong>
                <p>
                  Nhập lại file không tạo thêm dòng đã có. Dòng bị sửa được báo xung đột để xem lại.
                </p>
              </div>
            </li>
            <li>
              <span>3</span>
              <div>
                <strong>Xác nhận nghiệp vụ</strong>
                <p>Điền ngày thật, SKU và tài khoản. Số tiền chờ không vào báo cáo đã ghi sổ.</p>
              </div>
            </li>
          </ol>
          <div className="soft-note">
            File riêng của shop nằm trong thư mục <code>data/</code>, được loại khỏi Git và bundle
            website. Không tự gửi lên cloud khi mở ứng dụng.
          </div>
        </Panel>
      </div>
      <Panel title="Lịch sử nhập">
        <Table
          headers={['File nguồn', 'Thời gian', 'Đã thêm', 'Bỏ qua / cần xem lại']}
          empty={!data.import_batches.length}
        >
          {[...data.import_batches].reverse().map((r) => (
            <tr key={r.id}>
              <td>
                <strong>{r.source_name}</strong>
                <small className="mono">{r.source_id.slice(0, 16)}…</small>
              </td>
              <td>{new Date(r.created_at).toLocaleString('vi-VN')}</td>
              <td>
                {r.stats.inserted_purchases} nhập · {r.stats.inserted_cash} thu chi
              </td>
              <td>
                {r.stats.skipped} bỏ qua · {r.stats.conflicts?.length || 0} cần xem
              </td>
            </tr>
          ))}
        </Table>
      </Panel>
    </>
  );
}

export function Reports({ data, from, to }) {
  const stats = statistics(data, from, to);
  const categories = data.expense_categories?.length
    ? data.expense_categories.filter((c) => c.direction === 'out').map((c) => [c.code, c.name, c.profit_eligible])
    : CATEGORIES.filter((c) => c[2] === 'out').map((c) => [c[0], c[1], c[3]]);
  const rows = categories.map((c) => ({
    category: c[1],
    expense: c[2],
    amount: sum(
      data.cash_movements.filter(
        (m) => m.category === c[0] && m.transaction_date >= from && m.transaction_date <= to,
      ),
      (r) => -Number(r.signed_amount),
    ),
  }));
  return (
    <>
      <div className="notice">
        <BookOpen size={19} />
        <span>
          <strong>Báo cáo thu chi đã ghi</strong> · Doanh thu, giá vốn bán, công nợ hóa đơn và P&L
          đầy đủ sẽ cần thêm phân hệ bán hàng / kế toán. Tiền COD nhận về không tự coi là doanh thu.
        </span>
      </div>
      <div className="kpi-grid three">
        <article className="kpi">
          <div className="kpi-top">
            Tiền thu trong kỳ
            <ArrowDownRight size={19} />
          </div>
          <strong>{money(stats.cashIn)}</strong>
        </article>
        <article className="kpi">
          <div className="kpi-top">
            Tiền chi trong kỳ
            <ArrowUpRight size={19} />
          </div>
          <strong>{money(stats.cashOut)}</strong>
        </article>
        <article className="kpi">
          <div className="kpi-top">
            Chênh lệch tiền
            <Wallet size={19} />
          </div>
          <strong>{money(stats.cashIn - stats.cashOut)}</strong>
          <small>Bao gồm chứng từ đảo có trong kỳ</small>
        </article>
      </div>
      <div className="dashboard-grid">
        <Panel title="Số dư tài khoản" note={`Đầu sổ + chuyển động đã ghi đến ${dateLabel(to)}`}>
          <Table
            headers={['Tài khoản', 'Ngày mở sổ', 'Số dư theo sổ']}
            empty={!data.cash_accounts.length}
          >
            {data.cash_accounts.map((a) => (
              <tr key={a.id}>
                <td>{a.name}</td>
                <td>{dateLabel(a.opening_date)}</td>
                <td className="numeric">
                  {a.opening_confirmed && a.opening_date <= to ? (
                    money(
                      sum([
                        a.opening_balance,
                        ...data.cash_movements
                          .filter((m) => m.account_id === a.id && m.transaction_date <= to)
                          .map((r) => r.signed_amount),
                      ]),
                    )
                  ) : (
                    <Badge status="draft">Chưa có số dư cho ngày này</Badge>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        </Panel>
        <Panel title="Chi tiền theo nhóm" note="Không cộng tiền mua hàng vào chi phí lần hai.">
          <Table headers={['Nhóm', 'Chi ròng sau đảo', 'Cách đọc']} empty={false}>
            {rows
              .filter((r) => r.amount !== 0)
              .map((r) => (
                <tr key={r.category}>
                  <td>{r.category}</td>
                  <td className="numeric">{money(r.amount)}</td>
                  <td>{r.expense ? 'Chi tiền hoạt động' : 'Chờ nghiệp vụ đối ứng'}</td>
                </tr>
              ))}
            {!rows.some((r) => r.amount !== 0) && (
              <tr>
                <td colSpan={3}>
                  <Empty title="Chưa có khoản chi ghi sổ trong kỳ" />
                </td>
              </tr>
            )}
          </Table>
        </Panel>
      </div>
    </>
  );
}

export function eventLabel(action) {
  return (
    {
      'workspace.created': 'Tạo workspace',
      'purchase.draft_saved': 'Lưu phiếu nhập chờ xác nhận',
      'cash.draft_saved': 'Lưu thu chi chờ xác nhận',
      'purchase.posted': 'Ghi sổ phiếu nhập',
      'cash.posted': 'Ghi sổ thu chi',
      'purchase.reversed': 'Đảo phiếu nhập',
      'cash.reversed': 'Đảo thu chi',
      'legacy.imported': 'Nhập dữ liệu nguồn',
      'products.saved': 'Cập nhật sản phẩm',
      'suppliers.saved': 'Cập nhật nhà cung cấp',
      'cash_accounts.saved': 'Cập nhật tài khoản tiền',
      'warehouses.saved': 'Cập nhật kho',
      'member.added': 'Thêm thành viên',
      'member.role_changed': 'Đổi quyền thành viên',
      'member.removed': 'Thu hồi quyền thành viên',
    }[action] || action
  );
}
export function Audit({ data }) {
  return (
    <Panel
      title="Nhật ký thay đổi"
      note="Xem ai đã thực hiện thao tác và căn cứ của lần ghi sổ / đảo chứng từ."
    >
      <Table
        headers={['Thời gian', 'Thao tác', 'Chứng từ', 'Chi tiết']}
        empty={!data.audit_events.length}
      >
        {[...data.audit_events]
          .sort((a, b) => b.created_at.localeCompare(a.created_at))
          .map((r) => (
            <tr key={r.id}>
              <td>{new Date(r.created_at).toLocaleString('vi-VN')}</td>
              <td>
                <strong>{eventLabel(r.action)}</strong>
                <small className="mono">{r.actor_id?.slice(0, 12)}</small>
              </td>
              <td className="mono">{r.entity_id?.slice(0, 12) || '—'}</td>
              <td className="detail-text">{JSON.stringify(r.details)}</td>
            </tr>
          ))}
      </Table>
    </Panel>
  );
}

export function Settings({ mode, data, onSample, onReset }) {
  return (
    <>
      <div className="settings-grid">
        <Panel
          title="Kết nối Supabase khi bạn sẵn sàng"
          note="Bạn có thể tiếp tục chạy thử trước khi thêm tài khoản online."
        >
          <ol className="steps">
            <li>
              <span>1</span>
              <div>
                <strong>Tạo project Supabase Free</strong>
                <p>
                  Vào supabase.com/dashboard, tạo tài khoản và New project. Chọn khu vực gần Việt
                  Nam.
                </p>
              </div>
            </li>
            <li>
              <span>2</span>
              <div>
                <strong>Tạo bảng và quy tắc quyền</strong>
                <p>
                  Chạy <code>supabase/migrations/001_core.sql</code> trong SQL Editor của project
                  mới.
                </p>
              </div>
            </li>
            <li>
              <span>3</span>
              <div>
                <strong>Điền cấu hình frontend</strong>
                <p>
                  Copy <code>.env.example</code> thành <code>.env.local</code>. Điền URL và
                  publishable key; đổi demo mode thành false.
                </p>
              </div>
            </li>
            <li>
              <span>4</span>
              <div>
                <strong>Khởi động lại và đăng ký</strong>
                <p>Chạy lại npm run dev, đăng ký, xác nhận email rồi tạo workspace ChiDi.</p>
              </div>
            </li>
          </ol>
          <div className="code-sample">
            VITE_SUPABASE_URL=https://…supabase.co
            <br />
            VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_…
            <br />
            VITE_DEMO_MODE=false
          </div>
          <p className="page-footnote">
            Không đưa service_role key, secret key hoặc mật khẩu database vào frontend. Hướng dẫn
            đầy đủ: docs/SUPABASE_SETUP.md.
          </p>
        </Panel>
        <div>
          <Panel title="Trạng thái môi trường">
            <div className="setting-line">
              <span>Nơi lưu dữ liệu</span>
              <Badge status={mode === 'demo' ? 'draft' : 'posted'}>
                {mode === 'demo' ? 'Trình duyệt này' : 'Supabase online'}
              </Badge>
            </div>
            <div className="setting-line">
              <span>Workspace</span>
              <strong>{data.workspace.name}</strong>
            </div>
            <div className="setting-line">
              <span>Quyền hiện tại</span>
              <strong>{data.role}</strong>
            </div>
            <div className="soft-note">
              {mode === 'demo'
                ? 'Chạy thử không mô phỏng khả năng phân quyền hay đồng bộ nhiều người. Không dùng bộ nhớ trình duyệt làm sổ chính.'
                : 'Supabase Free phù hợp thử nghiệm. Cần xuất backup riêng và kiểm tra khôi phục trước vận hành thực tế.'}
            </div>
          </Panel>
          {mode === 'demo' && (
            <Panel title="Dữ liệu chạy thử">
              <div className="button-stack">
                <button className="button secondary" onClick={onSample}>
                  <Plus size={16} />
                  Nạp dữ liệu minh họa
                </button>
                <button
                  className="button secondary"
                  onClick={() =>
                    download(`chidi-demo-backup-${today()}.json`, JSON.stringify(data, null, 2))
                  }
                >
                  <Download size={16} />
                  Xuất bản sao chạy thử
                </button>
                <button className="button danger-outline" onClick={onReset}>
                  <RotateCcw size={16} />
                  Đặt lại dữ liệu chạy thử
                </button>
              </div>
            </Panel>
          )}
        </div>
      </div>
      <Panel
        title="Kiến trúc đã chọn"
        note="React hiển thị; PostgreSQL giữ dữ liệu và quyết định ghi sổ."
      >
        <div className="architecture-inline">
          <div>
            <BookOpen />
            <strong>React / JavaScript</strong>
            <span>Giao diện, form, bộ lọc</span>
          </div>
          <ArrowRight />
          <div>
            <ShieldCheck />
            <strong>Supabase Auth + RLS</strong>
            <span>Đăng nhập và workspace</span>
          </div>
          <ArrowRight />
          <div>
            <Database />
            <strong>PostgreSQL + RPC</strong>
            <span>Chứng từ, sổ, nhật ký</span>
          </div>
        </div>
        <p className="page-footnote">
          Thiết kế và prompt chi tiết nằm trong docs/. Tích hợp hãng vận chuyển, đối soát COD, kế
          toán kép và lương/tài sản có lộ trình riêng; V1 chưa giả lập các nghiệp vụ đó.
        </p>
      </Panel>
    </>
  );
}
