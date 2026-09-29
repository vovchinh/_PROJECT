import { useState } from 'react';
import {
  ArrowUpRight,
  BarChart3,
  CalendarDays,
  ChevronRight,
  Clock3,
  Radio,
  Search,
  ShoppingBasket,
  Users,
} from 'lucide-react';
import { Panel, Field, Modal } from '../components.jsx';
import {
  filterLiveTickets,
  groupLiveSessions,
  groupLiveTicketDays,
  liveDateRange,
  summarizeLiveTickets,
  summarizeLiveCarts,
} from '../lib/live-view.js';

const money = (value = 0n) =>
  new Intl.NumberFormat('vi-VN', {
    style: 'currency',
    currency: 'VND',
    maximumFractionDigits: 0,
  }).format(BigInt(value));
const dateLabel = (value) => (value ? value.split('-').reverse().join('/') : 'Chưa rõ ngày tạo');
const initials = (name) =>
  (name || '?')
    .trim()
    .split(/\s+/)
    .slice(-2)
    .map((x) => [...x][0])
    .join('')
    .toLocaleUpperCase('vi-VN');
const providerName = (value) =>
  ({ tiktok_live: 'TikTok LIVE', manual: 'Thủ công', simulator: 'Mô phỏng' })[value] || value;
const statusName = (value) =>
  ({
    live: 'Đang live',
    draft: 'Chưa bắt đầu',
    ended: 'Đã kết thúc',
    committed: 'Đã chốt',
    voided: 'Đã VOID',
  })[value] || value;

export function LiveQuickStats({ commerce, onNavigate }) {
  const summary = summarizeLiveTickets(commerce.tickets);
  const queued = commerce.print_jobs.filter((j) =>
    ['queued', 'failed', 'printing'].includes(j.status),
  ).length;
  return (
    <div className="live-kpis" aria-label="Tổng quan chiến dịch">
      <div className="live-kpi live-kpi-value">
        <span>
          <BarChart3 size={16} /> Giá trị phiếu còn hiệu lực
        </span>
        <strong>{money(summary.total_amount)}</strong>
        <small>Toàn chiến dịch · chưa ghi nhận doanh thu</small>
      </div>
      <button className="live-kpi" onClick={() => onNavigate('carts')}>
        <span>
          <ShoppingBasket size={16} /> Phiếu đã chốt
        </span>
        <strong>
          {summary.committed_count}
          <small> / {String(summary.qty)} sản phẩm</small>
        </strong>
        <small>
          Xem giỏ khách <ArrowUpRight size={13} />
        </small>
      </button>
      <button className="live-kpi" onClick={() => onNavigate('print')}>
        <span>
          <Clock3 size={16} /> Phiếu cần xử lý in
        </span>
        <strong>{queued}</strong>
        <small>
          Chờ in, đang in hoặc cần đối soát <ArrowUpRight size={13} />
        </small>
      </button>
    </div>
  );
}

export function LiveSessionHistory({ sessions, campaigns, accounts, onOpen, simple = false }) {
  const [query, setQuery] = useState(''),
    [status, setStatus] = useState('all'),
    [provider, setProvider] = useState('all');
  const groups = groupLiveSessions(
    sessions.filter((s) => provider === 'all' || s.provider === provider),
    { query, status },
  );
  return (
    <div className="live-history">
      <div className="live-section-heading">
        <div>
          <span className="live-eyebrow">LỊCH SỬ</span>
          <h2>Các phiên livestream</h2>
          <p>Mở lại bình luận, giỏ và hàng đợi của một phiên.</p>
        </div>
        <CalendarDays size={28} />
      </div>
      <div className="live-filterbar">
        <label className="live-search">
          <Search size={18} />
          <input
            aria-label="Tìm phiên live"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Tên phiên, mã hoặc tài khoản..."
          />
        </label>
        <select
          aria-label="Lọc nguồn phiên"
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
        >
          <option value="all">Tất cả nguồn</option>
          <option value="tiktok_live">TikTok LIVE</option>
          <option value="manual">Thủ công</option>
          <option value="simulator">Mô phỏng</option>
        </select>
        <select
          aria-label="Lọc trạng thái phiên"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="all">Tất cả trạng thái</option>
          <option value="live">Đang live</option>
          <option value="draft">Chưa bắt đầu</option>
          <option value="ended">Đã kết thúc</option>
        </select>
      </div>
      {groups.map((group) => (
        <section className="live-history-day" key={group.created_date || 'unknown'}>
          <h3>
            <CalendarDays size={17} />{' '}
            {group.created_date ? `Tạo ngày ${dateLabel(group.created_date)}` : 'Chưa rõ ngày tạo'}{' '}
            <span>{group.sessions.length} phiên</span>
          </h3>
          {group.sessions.map((session) => {
            const account = accounts.find((a) => a.id === session.integration_account_id),
              campaign = campaigns.find((c) => c.id === session.campaign_id);
            return (
              <button
                key={session.id}
                className="live-session-row"
                onClick={() => onOpen(session.id)}
                aria-label={simple ? `Xem buổi LIVE ${session.title}` : `Mở phiên ${session.code}`}
              >
                <span className={`live-session-icon ${session.status === 'live' ? 'is-live' : ''}`}>
                  <Radio size={23} />
                </span>
                <span className="live-session-description">
                  <strong>{session.title}</strong>
                  <small>
                    {simple
                      ? campaign?.name || 'Buổi LIVE'
                      : `${session.code} · ${campaign?.name || 'Chiến dịch'}`}
                  </small>
                  <span>{account ? `@${account.username}` : providerName(session.provider)}</span>
                </span>
                <span className={`live-status ${session.status}`}>
                  {statusName(session.status)}
                </span>
                <ChevronRight size={20} />
              </button>
            );
          })}
        </section>
      ))}
      {!groups.length && (
        <div className="live-empty">
          <CalendarDays size={32} />
          <h3>Chưa có phiên phù hợp</h3>
          <p>Thử thay bộ lọc hoặc tạo phiên trong Thiết lập.</p>
        </div>
      )}
    </div>
  );
}

export function LiveCampaignReport({ commerce, campaign, today }) {
  const [preset, setPreset] = useState('7d');
  const range = liveDateRange(preset, today),
    tickets = filterLiveTickets(commerce.tickets, { ...range, campaignId: campaign.id });
  const summary = summarizeLiveTickets(tickets),
    days = groupLiveTicketDays(tickets, { ...range, fillMissing: true });
  const maximum = days.reduce((max, d) => (d.total_amount > max ? d.total_amount : max), 0n);
  return (
    <div className="live-reports">
      <div className="live-section-heading">
        <div>
          <span className="live-eyebrow">BÁO CÁO LIVE</span>
          <h2>{campaign.name}</h2>
          <p>Theo ngày nghiệp vụ của phiếu · giá trị còn hiệu lực, chưa ghi nhận doanh thu.</p>
        </div>
        <BarChart3 size={28} />
      </div>
      <div className="live-periods" role="group" aria-label="Khoảng thời gian báo cáo live">
        {[
          ['7d', '7 ngày'],
          ['30d', '30 ngày'],
          ['180d', '6 tháng'],
          ['365d', '1 năm'],
        ].map(([key, label]) => (
          <button key={key} aria-pressed={preset === key} onClick={() => setPreset(key)}>
            {label}
          </button>
        ))}
      </div>
      <p className="live-range-label">
        {dateLabel(range.from)} — {dateLabel(range.to)} · chỉ chiến dịch đang chọn
      </p>
      <div className="live-kpis">
        <div className="live-kpi live-kpi-value">
          <span>Giá trị phiếu đã chốt</span>
          <strong>{money(summary.total_amount)}</strong>
          <small>Đã loại phiếu VOID</small>
        </div>
        <div className="live-kpi">
          <span>Phiếu / sản phẩm</span>
          <strong>
            {summary.committed_count} <small>/ {String(summary.qty)}</small>
          </strong>
          <small>{summary.voided_count} phiếu VOID trong kỳ</small>
        </div>
        <div className="live-kpi">
          <span>
            <Users size={16} /> Giỏ có phiếu còn hiệu lực
          </span>
          <strong>{summary.cart_count}</strong>
          <small>Không phải số người đã thanh toán</small>
        </div>
      </div>
      <section className="live-chart-card">
        <h3>
          <BarChart3 size={20} /> Giá trị chốt theo ngày
        </h3>
        {maximum > 0n ? (
          <>
            <div
              className="live-chart-scroll"
              role="img"
              aria-label="Biểu đồ giá trị phiếu còn hiệu lực theo ngày; bảng số liệu chi tiết ở bên dưới."
            >
              <div className="live-bars">
                {days.map((day) => (
                  <div
                    className="live-bar-column"
                    key={day.date}
                    title={`${dateLabel(day.date)}: ${money(day.total_amount)}`}
                  >
                    <div className="live-bar-track">
                      <i
                        style={{
                          height: `${Number((day.total_amount * 10000n) / maximum) / 100}%`,
                        }}
                      />
                    </div>
                    <small>
                      {day.date.slice(8)}/{day.date.slice(5, 7)}
                    </small>
                  </div>
                ))}
              </div>
            </div>
            <p className="live-chart-hint">
              Cuộn ngang để xem thêm ngày. Giá trị chi tiết nằm trong bảng bên dưới.
            </p>
          </>
        ) : (
          <div className="live-empty">
            <BarChart3 size={30} />
            <h3>Chưa có phiếu còn hiệu lực trong kỳ</h3>
            <p>Chọn khoảng thời gian khác để xem các phiếu đã ghi nhận.</p>
          </div>
        )}
        <details className="live-report-data">
          <summary>Xem bảng số liệu theo ngày</summary>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Ngày</th>
                  <th>Phiếu</th>
                  <th>Sản phẩm</th>
                  <th>Giá trị</th>
                </tr>
              </thead>
              <tbody>
                {days.map((day) => (
                  <tr key={day.date}>
                    <td>{dateLabel(day.date)}</td>
                    <td>{day.committed_count}</td>
                    <td>{String(day.qty)}</td>
                    <td>{money(day.total_amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </section>
    </div>
  );
}

export function LiveCartList({ commerce, onDetail, onPrintQueue }) {
  const [query, setQuery] = useState(''),
    [scope, setScope] = useState('active');
  const carts = summarizeLiveCarts(commerce, { query });
  const visible = carts.filter((c) => scope === 'all' || c.committed_count > 0);
  return (
    <Panel
      title="Giỏ khách theo chiến dịch"
      note="STT giữ xuyên các phiên cùng chiến dịch. Mở giỏ để xem thông tin và từng phiếu đã chốt."
    >
      <div className="live-filterbar live-panel-filters">
        <label className="live-search">
          <Search size={18} />
          <input
            aria-label="Tìm giỏ khách"
            placeholder="STT, tên khách, SKU hoặc mã phiếu..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <select aria-label="Lọc giỏ khách" value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="active">Giỏ còn hàng</option>
          <option value="all">Tất cả giỏ</option>
        </select>
      </div>
      <div className="live-cart-list">
        {visible.map((cart) => {
          const customer = cart.campaign_customer,
            summary = cart;
          return (
            <article key={cart.id} className="live-customer-card">
              <header>
                <span className="live-avatar">{initials(customer?.display_name_snapshot)}</span>
                <div>
                  <span className="live-customer-number">
                    #{String(customer?.customer_no || '').padStart(3, '0')}
                  </span>
                  <h3>{customer?.display_name_snapshot || 'Khách live'}</h3>
                  <small>
                    {providerName(customer?.provider)} · {customer?.author_external_id}
                  </small>
                </div>
                <span className="live-status committed">{summary.committed_count} phiếu</span>
              </header>
              <div className="live-cart-products">
                {cart.tickets
                  .filter((t) => t.status === 'committed')
                  .slice(0, 3)
                  .map((ticket) => (
                    <div key={ticket.id}>
                      <span>
                        {ticket.product_snapshot?.name ||
                          ticket.product_snapshot?.sku ||
                          'Sản phẩm'}
                        <small>
                          {[ticket.product_snapshot?.color, ticket.product_snapshot?.size]
                            .filter(Boolean)
                            .join(' · ')}
                        </small>
                      </span>
                      <strong>× {ticket.qty}</strong>
                    </div>
                  ))}
                {summary.committed_count > 3 && (
                  <small>Và {summary.committed_count - 3} phiếu khác trong giỏ</small>
                )}
              </div>
              <div className="live-cart-total">
                <span>
                  {String(summary.qty)} sản phẩm <small>· Giá trị còn hiệu lực</small>
                </span>
                <strong>{money(summary.total_amount)}</strong>
              </div>
              <footer>
                <button className="button primary" onClick={() => onDetail(cart.id)}>
                  Xem giỏ & thông tin
                </button>
                <button className="button secondary" onClick={() => onPrintQueue(cart.id)}>
                  Hàng đợi của giỏ
                </button>
              </footer>
            </article>
          );
        })}
      </div>
      {!visible.length && (
        <div className="live-empty">
          <ShoppingBasket size={32} />
          <h3>{query ? 'Không tìm thấy giỏ phù hợp' : 'Chưa có giỏ còn hàng'}</h3>
          <p>
            Giỏ xuất hiện sau khi chốt phiếu đầu tiên. Có thể chọn “Tất cả giỏ” để xem lịch sử VOID.
          </p>
        </div>
      )}
    </Panel>
  );
}

export function LiveCartDetail({ cart, customer, jobs, onClose, onVoid, onPrintQueue, canManage }) {
  const [tab, setTab] = useState('tickets');
  const cc = cart.campaign_customer;
  return (
    <Modal
      title={`Giỏ #${String(cc?.customer_no || '').padStart(3, '0')} · ${cc?.display_name_snapshot || 'Khách live'}`}
      onClose={onClose}
    >
      <div className="live-cart-detail">
        <div className="live-segmented" role="group" aria-label="Chi tiết giỏ">
          <button aria-pressed={tab === 'info'} onClick={() => setTab('info')}>
            Thông tin
          </button>
          <button aria-pressed={tab === 'tickets'} onClick={() => setTab('tickets')}>
            Phiếu đã chốt
          </button>
        </div>
        <div className="live-detail-person">
          <span className="live-avatar">{initials(cc?.display_name_snapshot)}</span>
          <h3>{cc?.display_name_snapshot}</h3>
          <span className="live-customer-number">
            #{String(cc?.customer_no || '').padStart(3, '0')}
          </span>
          <small>
            {providerName(cc?.provider)} · {cc?.author_external_id}
          </small>
        </div>
        {tab === 'info' ? (
          <div className="live-info-fields">
            <Field label="Liên kết khách ERP">
              <input readOnly value={customer?.name || 'Chưa liên kết khách ERP'} />
            </Field>
            <Field label="Điện thoại trong hồ sơ ERP hiện tại">
              <input readOnly value={customer?.phone || 'Chưa có thông tin'} />
            </Field>
            <p>
              Thông tin chỉ hiển thị khi đã liên kết khách ERP. Tên người xem không tự xác nhận danh
              tính; nội dung và giá trên phiếu giữ theo thời điểm chốt.
            </p>
          </div>
        ) : (
          <>
            <div className="live-cart-total">
              <span>{String(cart.qty)} sản phẩm còn giữ</span>
              <strong>{money(cart.total_amount)}</strong>
            </div>
            <div className="live-detail-tickets">
              {cart.tickets.map((ticket) => (
                <article key={ticket.id}>
                  <header>
                    <strong>{ticket.ticket_no}</strong>
                    <span className={`live-status ${ticket.status}`}>
                      {statusName(ticket.status)}
                    </span>
                  </header>
                  <h4>
                    {ticket.product_snapshot?.name || ticket.product_snapshot?.sku || 'Sản phẩm'}
                  </h4>
                  <p>
                    {[
                      ticket.product_snapshot?.sku,
                      ticket.product_snapshot?.color,
                      ticket.product_snapshot?.size,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                  <div className="live-cart-total">
                    <span>
                      {ticket.qty} × {money(ticket.unit_price || 0)}
                    </span>
                    <strong>{money(ticket.line_total)}</strong>
                  </div>
                  <small>
                    {dateLabel(ticket.business_date)} ·{' '}
                    {jobs.find((j) => j.ticket_id === ticket.id)?.status === 'printed'
                      ? 'Đã xác nhận giấy'
                      : 'Xem trạng thái trong hàng đợi in'}
                  </small>
                  {canManage && ticket.status === 'committed' && (
                    <button className="button danger" onClick={() => onVoid(ticket)}>
                      VOID phiếu {ticket.ticket_no}
                    </button>
                  )}
                </article>
              ))}
            </div>
          </>
        )}
      </div>
      <footer className="modal-actions">
        <button className="button secondary" onClick={onClose}>
          Đóng giỏ
        </button>
        <button className="button primary" onClick={() => onPrintQueue(cart.id)}>
          Mở hàng đợi của giỏ
        </button>
      </footer>
    </Modal>
  );
}
