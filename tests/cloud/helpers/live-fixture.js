import { expect } from '@playwright/test';

const wid = '11111111-1111-4111-8111-111111111111',
  widB = '22222222-2222-4222-8222-222222222222';
const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  instant = '2026-09-01T00:00:00Z';
const user = {
  id: userId,
  aud: 'authenticated',
  role: 'authenticated',
  email: 'live@chidi.test',
  email_confirmed_at: instant,
  app_metadata: { provider: 'email' },
  user_metadata: {},
  created_at: instant,
};
const jwt = () =>
  [
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
    Buffer.from(
      JSON.stringify({
        sub: userId,
        aud: 'authenticated',
        role: 'authenticated',
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString('base64url'),
    'testsignature',
  ].join('.');
const product = {
  id: 'sku1',
  code: 'AO-01',
  name: 'Áo xanh',
  provisional: false,
  unit_cost: '80000',
};
const comment = {
  id: 'cm1',
  session_id: 's1',
  campaign_id: 'cp1',
  provider_message_id: '90071992547409931',
  author_external_id: '90071992547409932',
  author_display_name: 'Khách live',
  raw_text: 'áo hot 2c',
  occurred_at: instant,
  received_at: instant,
  state: 'new',
};
const snapshot = {
  ticket_no: 'LS-1',
  customer_no: 1,
  customer_name: 'Khách live',
  campaign_name: 'Chiến dịch thử',
  session_code: 'LIVE-01',
  committed_at: instant,
  lines: [
    {
      product_id: 'sku1',
      sku: 'AO-01',
      name: 'Áo xanh',
      color: 'Xanh',
      size: 'M',
      qty: 2,
      unit_price: '100000',
      line_total: '200000',
    },
  ],
  total_amount: '200000',
};
const catalog = {
  styles: [{ id: 'style1', code: 'AO', name: 'Áo' }],
  variants: [
    {
      id: 'sku1',
      product_id: 'sku1',
      style_id: 'style1',
      size: 'M',
      color: 'Xanh',
      mapping_status: 'confirmed',
    },
  ],
  aliases: [
    { id: 'al1', product_id: 'sku1', alias_text: 'áo hot', alias_key: 'áo hot', active: true },
  ],
  reconciliation: { product_count: 1, variant_count: 1, review_count: 0, unmapped_count: 0 },
};

export async function setup(
  page,
  {
    role = 'owner',
    failCommitResponse = false,
    insufficient = false,
    otherClaim = false,
    blockedPopup = false,
    missing = false,
    sellerMode = false,
    realtime = false,
    seed,
  } = {},
) {
  const state = {
    requests: [],
    pageErrors: [],
    commitCount: 0,
    hold: false,
    pending: [],
    hasMore: false,
    comment: { ...comment },
    jobs: [],
    tickets: [],
    customers: [],
    carts: [],
    items: [],
    comments: null,
    sessions: null,
    campaigns: null,
    accounts: null,
    claims: [],
    channels: [],
    connections: [],
    channelOutcome: 'offline',
    channelSaveFailures: 0,
    channelHistoryIds: [],
    runtime: {
      listener: { online: false, ready: false, heartbeat_at: null },
      telemetry: null,
      diagnostics: null,
    },
    runtimeMissing: false,
    sockets: [],
    salesCustomers: [{ id: 'c1', code: 'KH-01', name: 'Khách ERP' }],
  };
  seed?.(state);
  page.on('pageerror', (e) => state.pageErrors.push(e.message));
  await page.routeWebSocket('wss://chidi-test.supabase.co/**', (socket) => {
    if (!realtime) return socket.close();
    const entry = { socket, joins: [] };
    state.sockets.push(entry);
    socket.onMessage((wire) => {
      const parsed = JSON.parse(String(wire));
      const message = Array.isArray(parsed)
        ? {
            join_ref: parsed[0],
            ref: parsed[1],
            topic: parsed[2],
            event: parsed[3],
            payload: parsed[4],
          }
        : parsed;
      const send = (reply) =>
        socket.send(
          JSON.stringify(
            Array.isArray(parsed)
              ? [reply.join_ref, reply.ref, reply.topic, reply.event, reply.payload]
              : reply,
          ),
        );
      entry.send = send;
      if (message.event === 'phx_join') {
        entry.joins.push(message);
        send({
          topic: message.topic,
          event: 'phx_reply',
          ref: message.ref,
          join_ref: message.join_ref,
          payload: {
            status: 'ok',
            response: {
              postgres_changes: (message.payload.config?.postgres_changes || []).map(
                (filter, i) => ({ ...filter, id: i + 1 }),
              ),
            },
          },
        });
      } else if (message.event === 'heartbeat' || message.event === 'phx_leave') {
        send({
          ...message,
          event: 'phx_reply',
          payload: { status: 'ok', response: {} },
        });
      }
    });
  });
  await page.addInitScript(
    ({ blockedPopup }) => {
      window.__paperCalls = 0;
      window.open = () =>
        blockedPopup
          ? null
          : {
              closed: false,
              opener: null,
              document: { open() {}, write() {}, close() {}, fonts: { ready: Promise.resolve() } },
              focus() {},
              print() {
                window.__paperCalls++;
              },
              close() {
                this.closed = true;
              },
            };
    },
    { blockedPopup },
  );
  await page.route('https://chidi-test.supabase.co/**', async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname,
      input = req.postDataJSON();
    state.requests.push({ path, input });
    const json = (body, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/auth/v1/token')
      return json({
        access_token: jwt(),
        token_type: 'bearer',
        expires_in: 3600,
        refresh_token: 'fake-refresh',
        user,
      });
    if (path === '/auth/v1/user') return json(user);
    if (path === '/rest/v1/workspace_members')
      return json(
        [wid, widB].map((id, i) => ({
          workspace_id: id,
          role,
          workspaces: { id, name: `Workspace ${i ? 'B' : 'A'}` },
        })),
      );
    if (path.startsWith('/rest/v1/rpc/')) {
      const name = path.split('/').at(-1);
      if (name === 'get_live_runtime') {
        if (state.runtimeMissing)
          return json({ code: 'PGRST202', message: 'Missing runtime' }, 404);
        const runtime = structuredClone(state.runtime);
        if (input.p_workspace_id !== wid)
          return json({
            listener: { online: false, ready: false, heartbeat_at: null },
            telemetry: null,
            diagnostics: null,
          });
        if (runtime.telemetry?.session_id !== input.p_session_id) runtime.telemetry = null;
        if (!['owner', 'manager'].includes(role)) runtime.diagnostics = null;
        return json(runtime);
      }
      if (name === 'get_tiktok_channels')
        return json({
          channels: input.p_workspace_id === widB ? [] : state.channels,
          connections: input.p_workspace_id === widB ? [] : state.connections,
        });
      if (name === 'save_tiktok_channel') {
        if (state.channelSaveFailures > 0) {
          state.channelSaveFailures--;
          return json({ message: 'Mất phản hồi, hãy thử lưu lại.' }, 500);
        }
        const p = input.p_payload,
          username = p.username.trim().replace(/^@/, '').toLowerCase();
        const previous = state.channels.find((c) => c.id === p.id);
        if (
          previous &&
          previous.username !== username &&
          state.channelHistoryIds.includes(previous.id)
        )
          return json(
            {
              code: 'P0001',
              message:
                'TIKTOK_CHANNEL_USED: TikTok ID đã có phiên LIVE; thêm ID mới để giữ lịch sử.',
            },
            400,
          );
        if (state.channels.some((c) => c.username === username && c.id !== p.id))
          return json({ message: 'TikTok ID đã tồn tại.' }, 400);
        const id = p.id || `channel-${state.channels.length + 1}`;
        if (p.is_default)
          state.channels.forEach((c) => {
            c.is_default = false;
          });
        const old = state.channels.find((c) => c.id === id);
        const channel = { id, ...p, username, is_active: p.is_active !== false };
        if (old) Object.assign(old, channel);
        else state.channels.push(channel);
        state.accounts = state.channels.map((c) => ({
          ...c,
          name: c.display_name || c.username,
          enabled: c.is_active,
        }));
        return json(id);
      }
      if (name === 'request_tiktok_connection') {
        const channel = state.channels.find((c) => c.id === input.p_channel_id);
        if (!channel) return json({ message: 'Không tìm thấy kênh.' }, 400);
        let c = state.connections.find((c) => c.channel_id === channel.id);
        if (!c) {
          c = { channel_id: channel.id, revision: 0 };
          state.connections.push(c);
        }
        c.revision++;
        c.desired_state = input.p_desired_state;
        c.connection_status =
          input.p_desired_state === 'disconnected'
            ? 'OFFLINE'
            : state.channelOutcome === 'live'
              ? 'LIVE'
              : state.channelOutcome === 'waiting'
                ? 'CONNECTING'
                : 'OFFLINE';
        c.message_code =
          input.p_desired_state === 'disconnected'
            ? 'disconnected'
            : state.channelOutcome === 'offline'
              ? 'room_not_live'
              : 'connected';
        c.heartbeat_at = new Date().toISOString();
        c.requested_at = c.heartbeat_at;
        if (input.p_desired_state === 'disconnected') c.connected_since = null;
        if (c.connection_status === 'LIVE') {
          c.current_session_id ||= `live-${channel.id}`;
          c.connected_since ||= new Date().toISOString();
          state.sessions ||= [];
          state.campaigns ||= [];
          if (!state.sessions.some((s) => s.id === c.current_session_id))
            state.sessions.push({
              id: c.current_session_id,
              campaign_id: `cp-${channel.id}`,
              code: `AUTO-${channel.id}`,
              title: `LIVE @${channel.username}`,
              provider: 'tiktok_live',
              room_id: channel.username,
              integration_account_id: channel.id,
              status: 'live',
              connection_status: 'connected',
              heartbeat_at: c.heartbeat_at,
              created_at: c.heartbeat_at,
              started_at: c.heartbeat_at,
            });
          if (!state.campaigns.some((x) => x.id === `cp-${channel.id}`))
            state.campaigns.push({
              id: `cp-${channel.id}`,
              code: `CP-${channel.id}`,
              name: `@${channel.username}`,
              warehouse_id: 'w1',
              status: 'active',
            });
          state.comments ||= [];
          if (!state.comments.some((x) => x.session_id === c.current_session_id))
            state.comments.push({
              ...comment,
              id: `comment-${channel.id}`,
              session_id: c.current_session_id,
              campaign_id: `cp-${channel.id}`,
              author_display_name: `Khách @${channel.username}`,
            });
        }
        return json({
          channel_id: channel.id,
          revision: c.revision,
          connection_status: c.connection_status,
        });
      }
      if (name === 'get_catalog_state') return json(catalog);
      if (name === 'get_sales_state')
        return json({
          customers: state.salesCustomers,
          inventory: [],
          sales_orders: [],
          sales_order_lines: [],
          sales_events: [],
          summary: {},
        });
      if (name === 'get_live_intake') {
        if (missing) return json({ code: 'PGRST202', message: 'Missing intake' }, 404);
        if (state.hold && input.p_workspace_id === wid)
          await new Promise((resolve) => state.pending.push(resolve));
        const suffix = input.p_workspace_id === widB ? 'B' : 'A';
        return json({
          integration_accounts: state.accounts || [
            { id: 'a1', name: `Hồ sơ ${suffix}`, username: 'chidi.shop', enabled: true },
          ],
          campaigns: state.campaigns || [
            {
              id: 'cp1',
              code: 'CP-01',
              name: 'Chiến dịch thử',
              warehouse_id: 'w1',
              status: 'active',
              created_at: instant,
            },
          ],
          sessions: state.sessions || [
            {
              id: 's1',
              campaign_id: 'cp1',
              code: 'LIVE-01',
              title: `Phiên ${suffix}`,
              provider: 'manual',
              room_id: '',
              integration_account_id: null,
              status: 'live',
              connection_status: 'disconnected',
              created_at: instant,
            },
          ],
          comments: state.comments
            ? state.comments.filter(
                (row) => !input.p_session_id || row.session_id === input.p_session_id,
              )
            : [
                input.p_before
                  ? { ...state.comment, id: 'cm-old', raw_text: 'Bình luận trang cũ', state: 'new' }
                  : state.comment,
              ],
          claims: state.claims,
          has_more: state.hasMore && !input.p_before,
          next_before: instant,
          next_before_id: 'cm1',
        });
      }
      if (name === 'get_live_commerce') {
        const matchesCampaign = (row) =>
          !row.campaign_id || row.campaign_id === input.p_campaign_id;
        const tickets = state.tickets.filter(matchesCampaign);
        const carts = state.carts.filter(matchesCampaign);
        const ticketIds = new Set(tickets.map((row) => row.id));
        const cartIds = new Set(carts.map((row) => row.id));
        return json({
          campaign_customers: state.customers.filter(matchesCampaign),
          carts,
          items: state.items.filter((row) => cartIds.has(row.cart_id)),
          tickets,
          print_jobs: state.jobs.filter((row) => ticketIds.has(row.ticket_id)),
          print_attempts: [],
        });
      }
      if (name === 'claim_live_comment') {
        if (otherClaim)
          return json(
            { code: 'P0001', message: 'COMMENT_ALREADY_CLAIMED: Có người khác xử lý.' },
            400,
          );
        return json({
          comment_id: input.p_comment_id,
          claim_token: 'claim-token',
          claimed_by: userId,
          expires_at: new Date(Date.now() + 120000).toISOString(),
        });
      }
      if (name === 'commit_live_sale_ticket') {
        state.commitCount++;
        if (insufficient)
          return json({ code: 'P0001', message: 'Không đủ hàng khả dụng. Chưa tạo phiếu.' }, 400);
        if (!state.tickets.length) {
          state.comment.state = 'committed';
          state.tickets.push({
            id: 't1',
            workspace_id: wid,
            campaign_id: 'cp1',
            session_id: 's1',
            cart_id: 'cart1',
            business_date: '2026-09-01',
            committed_at: instant,
            ticket_no: 'LS-1',
            comment_id: 'cm1',
            product_id: 'sku1',
            campaign_customer_id: 'cc1',
            qty: 2,
            unit_price: '100000',
            line_total: '200000',
            status: 'committed',
            product_snapshot: snapshot.lines[0],
            customer_snapshot: {
              customer_no: 1,
              name: 'Khách live',
              author_external_id: comment.author_external_id,
            },
          });
          state.jobs.push({
            id: 'j1',
            ticket_id: 't1',
            status: 'queued',
            reprint_count: 0,
            snapshot,
          });
          state.customers.push({
            id: 'cc1',
            campaign_id: 'cp1',
            customer_no: 1,
            display_name_snapshot: 'Khách live',
            provider: 'manual',
            author_external_id: comment.author_external_id,
            customer_id: null,
          });
          state.carts.push({ id: 'cart1', campaign_id: 'cp1', campaign_customer_id: 'cc1' });
          state.items.push({
            id: 'i1',
            cart_id: 'cart1',
            ticket_id: 't1',
            qty: 2,
            unit_price: '100000',
            line_total: '200000',
            status: 'active',
          });
        }
        if (failCommitResponse && state.commitCount === 1)
          return json({ code: 'P0001', message: 'Phản hồi gián đoạn; thử lại cùng yêu cầu.' }, 500);
        return json({
          ticket_id: 't1',
          cart_id: 'cart1',
          reservation_id: 'r1',
          print_job_id: 'j1',
          customer_no: 1,
          ticket_no: 'LS-1',
          ticket_status: 'committed',
        });
      }
      if (name === 'void_live_sale_ticket') {
        const ticket = state.tickets.find((row) => row.id === input.p_ticket_id);
        if (!ticket) return json({ message: 'Không tìm thấy phiếu.' }, 400);
        ticket.status = 'voided';
        ticket.void_date = input.p_date;
        ticket.void_reason = input.p_reason;
        const original = state.comments?.find((row) => row.id === ticket.comment_id);
        if (original) original.state = 'voided';
        state.items
          .filter((row) => row.ticket_id === ticket.id)
          .forEach((row) => {
            row.status = 'voided';
          });
        state.jobs
          .filter((row) => row.ticket_id === ticket.id)
          .forEach((row) => {
            row.status = 'cancelled';
          });
        return json(ticket.id);
      }
      if (name === 'claim_live_print_job') {
        state.jobs[0].status = 'printing';
        return json({
          job_id: 'j1',
          attempt_id: 'attempt-1',
          lease_token: 'print-token',
          expires_at: new Date(Date.now() + 120000).toISOString(),
          snapshot,
        });
      }
      if (name === 'finish_live_print_job') {
        state.jobs[0].status = input.p_outcome === 'printed' ? 'printed' : 'failed';
        return json('j1');
      }
      if (name === 'requeue_live_print_job') {
        state.jobs[0].status = 'queued';
        state.jobs[0].reprint_count++;
        return json('j1');
      }
      return json('saved-id');
    }
    if (path.startsWith('/rest/v1/')) {
      const table = path.split('/').at(-1);
      return json(
        table === 'products'
          ? [product]
          : table === 'warehouses'
            ? [{ id: 'w1', code: 'KHO', name: 'Kho chính' }]
            : [],
      );
    }
    return json({ message: 'Unexpected fixture request' }, 500);
  });
  await page.goto('/');
  await page.getByLabel('Email', { exact: true }).fill(user.email);
  await page.getByLabel('Mật khẩu', { exact: true }).fill('FakePassword123!');
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await expect(page.getByLabel('Workspace đang làm việc')).toBeVisible();
  const menu = page.getByRole('button', { name: 'Mở menu', exact: true });
  if (await menu.isVisible()) await menu.click();
  await page
    .getByRole('navigation', { name: 'Điều hướng chính' })
    .getByRole('button', { name: 'Live · Chốt & In', exact: true })
    .click();
  if (!missing) {
    if (!sellerMode) {
      await page.getByRole('button', { name: 'Thủ công / mô phỏng', exact: true }).click();
      await expect(page.getByLabel('Phiên đang vận hành')).toBeVisible();
      await chooseSession(page);
    } else await expect(page.getByRole('region', { name: 'Kết nối TikTok LIVE' })).toBeVisible();
  }
  return state;
}
export const calls = (state, name) => state.requests.filter((r) => r.path.endsWith(`/rpc/${name}`));
export const tab = (page, name) =>
  page
    .getByRole('navigation', { name: 'Phân hệ Live' })
    .getByRole('button', { name, exact: true })
    .click();
export async function openCommit(page) {
  await page.getByRole('button', { name: 'Nhận & kiểm tra' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByLabel('SKU xác nhận')).toHaveValue('sku1');
  await expect(page.getByLabel('Số lượng chốt')).toHaveValue('2');
  await page.getByLabel('Giá bán mỗi sản phẩm (VND)').fill('100000');
  await page
    .getByLabel('Căn cứ kiểm tra', { exact: true })
    .fill('Đã kiểm tra SKU, khách và giá bán.');
  await page.getByRole('checkbox', { name: /Tôi đã kiểm tra đúng khách/ }).check();
}

export { wid, widB, userId, instant, snapshot, product, catalog };
export const review = openCommit;

export async function chooseSession(page, sessionId = 's1') {
  await page.getByLabel('Phiên đang vận hành').selectOption(sessionId);
  await expect(page.getByRole('heading', { name: 'Bình luận và gợi ý SKU' })).toBeVisible();
}

// Realistic, internally linked read fixtures. Equal display names deliberately
// belong to different stable author IDs/STTs; all money stays integer strings.
export function seedReferenceLive(state, { reportExtras = 0 } = {}) {
  state.campaigns = [
    {
      id: 'cp1',
      code: 'CP-01',
      name: 'ChiDi · Tháng 9',
      warehouse_id: 'w1',
      status: 'active',
      created_at: instant,
    },
    {
      id: 'cp2',
      code: 'CP-OLD',
      name: 'ChiDi · Chiến dịch cũ',
      warehouse_id: 'w1',
      status: 'closed',
      created_at: '2026-08-01T00:00:00Z',
    },
  ];
  state.sessions = [
    {
      id: 's1',
      campaign_id: 'cp1',
      code: 'LIVE-01',
      title: 'Bộ sưu tập xanh tháng 9',
      provider: 'manual',
      room_id: '',
      integration_account_id: null,
      status: 'live',
      connection_status: 'disconnected',
      created_at: '2026-09-20T18:30:00Z',
    },
    {
      id: 's2',
      campaign_id: 'cp1',
      code: 'LIVE-ARCHIVE',
      title: 'Phiên đầu tháng',
      provider: 'manual',
      room_id: '',
      integration_account_id: null,
      status: 'ended',
      connection_status: 'disconnected',
      created_at: '2026-09-05T00:00:00Z',
    },
    {
      id: 's3',
      campaign_id: 'cp2',
      code: 'LIVE-OLD',
      title: 'Phiên chiến dịch cũ',
      provider: 'simulator',
      room_id: '',
      integration_account_id: null,
      status: 'ended',
      connection_status: 'disconnected',
      created_at: null,
    },
    {
      id: 's4',
      campaign_id: 'cp1',
      code: 'LIVE-NEXT',
      title: 'Phiên dự kiến',
      provider: 'manual',
      room_id: '',
      integration_account_id: null,
      status: 'draft',
      connection_status: 'disconnected',
      created_at: '2026-09-21T00:00:00Z',
    },
  ];
  state.customers = [
    {
      id: 'cc27',
      customer_no: 27,
      display_name_snapshot: 'Nguyễn Mai Anh',
      provider: 'manual',
      author_external_id: 'author-27',
      customer_id: null,
      campaign_id: 'cp1',
    },
    {
      id: 'cc8',
      customer_no: 8,
      display_name_snapshot: 'Nguyễn Mai Anh',
      provider: 'manual',
      author_external_id: 'author-8',
      customer_id: null,
      campaign_id: 'cp1',
    },
    {
      id: 'cc105',
      customer_no: 105,
      display_name_snapshot: 'Khách đã VOID',
      provider: 'manual',
      author_external_id: 'author-105',
      customer_id: null,
      campaign_id: 'cp1',
    },
    {
      id: 'cc999',
      customer_no: 999,
      display_name_snapshot: 'Khách chiến dịch khác',
      provider: 'simulator',
      author_external_id: 'author-999',
      customer_id: null,
      campaign_id: 'cp2',
    },
  ];
  state.carts = state.customers.map((row) => ({
    id: `cart${row.customer_no}`,
    campaign_id: row.campaign_id,
    campaign_customer_id: row.id,
    status: 'open',
    created_at: instant,
  }));
  const addTicket = ({
    id,
    number,
    customerNo,
    sessionId = 's1',
    date,
    qty = 1,
    price,
    status = 'committed',
    printStatus = 'queued',
    name = 'Áo xanh',
    sku = 'AO-01',
  }) => {
    const customer = state.customers.find((row) => row.customer_no === customerNo);
    const session = state.sessions.find((row) => row.id === sessionId);
    const total = (BigInt(qty) * BigInt(price)).toString();
    const ticket = {
      id,
      workspace_id: wid,
      campaign_id: customer.campaign_id,
      session_id: sessionId,
      comment_id: `comment-${id}`,
      cart_id: `cart${customerNo}`,
      campaign_customer_id: customer.id,
      customer_id: customer.customer_id,
      product_id: 'sku1',
      variant_id: 'sku1',
      qty,
      unit_price: price,
      line_total: total,
      business_date: date,
      ticket_no: number,
      status,
      committed_at: `${date}T02:00:00Z`,
      product_snapshot: {
        product_id: 'sku1',
        variant_id: 'sku1',
        sku,
        name,
        size: 'M',
        color: 'Xanh',
      },
      customer_snapshot: {
        customer_id: null,
        customer_no: customerNo,
        name: customer.display_name_snapshot,
        author_external_id: customer.author_external_id,
      },
    };
    state.tickets.push(ticket);
    state.items.push({
      id: `item-${id}`,
      campaign_id: customer.campaign_id,
      cart_id: ticket.cart_id,
      ticket_id: id,
      qty,
      unit_price: price,
      line_total: total,
      status: status === 'voided' ? 'voided' : 'active',
    });
    state.jobs.push({
      id: `job-${id}`,
      ticket_id: id,
      status: status === 'voided' ? 'cancelled' : printStatus,
      reprint_count: 0,
      snapshot: {
        ticket_no: number,
        customer_no: customerNo,
        customer_name: customer.display_name_snapshot,
        campaign_name: state.campaigns.find((row) => row.id === customer.campaign_id).name,
        session_code: session.code,
        committed_at: ticket.committed_at,
        lines: [{ ...ticket.product_snapshot, qty, unit_price: price, line_total: total }],
        total_amount: total,
      },
    });
  };
  addTicket({
    id: 't27',
    number: 'LS-027',
    customerNo: 27,
    date: '2026-09-21',
    qty: 2,
    price: '100001',
  });
  addTicket({
    id: 't27void',
    number: 'LS-028',
    customerNo: 27,
    date: '2026-09-20',
    price: '999999',
    status: 'voided',
    name: 'Áo đã hủy',
  });
  addTicket({
    id: 't8',
    number: 'LS-008',
    customerNo: 8,
    date: '2026-09-16',
    price: '300003',
    name: 'Váy xanh',
    sku: 'VAY-02',
  });
  addTicket({
    id: 'tOld',
    number: 'LS-029',
    customerNo: 27,
    sessionId: 's2',
    date: '2026-09-01',
    price: '700007',
    printStatus: 'printed',
  });
  addTicket({
    id: 't105',
    number: 'LS-105',
    customerNo: 105,
    date: '2026-09-21',
    price: '900000',
    status: 'voided',
  });
  addTicket({
    id: 'tOther',
    number: 'LS-999',
    customerNo: 999,
    sessionId: 's3',
    date: '2026-09-21',
    price: '9999999',
  });
  for (let i = 0; i < reportExtras; i++)
    addTicket({
      id: `large-${i}`,
      number: `LS-LARGE-${i}`,
      customerNo: 27,
      date: '2026-09-21',
      price: '8999999999999',
    });
  state.comments = [
    {
      ...comment,
      id: 'cm-new',
      author_display_name: 'Khách mới Lan',
      author_external_id: 'author-new',
      raw_text: 'Áo nóng xanh M',
      occurred_at: '2026-09-21T02:15:00Z',
      state: 'new',
    },
    {
      ...comment,
      id: 'comment-t27',
      author_display_name: 'Nguyễn Mai Anh',
      author_external_id: 'author-27',
      raw_text: 'Chốt áo xanh M',
      occurred_at: '2026-09-21T02:00:00Z',
      state: 'committed',
    },
    {
      ...comment,
      id: 'comment-t27void',
      author_display_name: 'Nguyễn Mai Anh',
      author_external_id: 'author-27',
      raw_text: 'Khách đổi ý không lấy',
      occurred_at: '2026-09-20T02:00:00Z',
      state: 'voided',
    },
    {
      ...comment,
      id: 'cm-held',
      author_display_name: 'Khách chờ xử lý',
      author_external_id: 'author-held',
      raw_text: 'áo hot 1c',
      occurred_at: '2026-09-21T02:20:00Z',
      state: 'new',
    },
    {
      ...comment,
      id: 'comment-tOther',
      session_id: 's3',
      campaign_id: 'cp2',
      author_display_name: 'Khách chiến dịch khác',
      author_external_id: 'author-999',
      raw_text: 'Bình luận phiên chiến dịch cũ',
      state: 'committed',
    },
  ];
}
