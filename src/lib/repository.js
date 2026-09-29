import { createClient } from '@supabase/supabase-js';
import {
  emptySalesData,
  salesState,
  saveCustomer,
  saveSalesOrder,
  transitionSalesOrder,
  assertPurchaseStockChange,
} from './sales-demo.js';
import {
  assertCashPost,
  assertPurchasePost,
  integer,
  purchaseTotal,
  validateImport,
  validDate,
} from './domain.js';

const KEY = 'chidi.erp.demo.v1';
const TABLES = [
  'suppliers',
  'products',
  'warehouses',
  'cash_accounts',
  'purchase_receipts',
  'cash_transactions',
  'stock_movements',
  'cash_movements',
  'audit_events',
  'import_batches',
];
export const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const accountCodes = [
  ['CASH', 'Tiền mặt'],
  ['BANK_CHINH', 'Tài khoản Chinh'],
  ['BANK_DIEU', 'Tài khoản Diệu'],
  ['COD_SPX', 'Ví COD SPX'],
  ['COD_GHN', 'Ví COD GHN'],
  ['WALLET', 'Ví điện tử'],
  ['OTHER', 'Tài khoản khác'],
];
export function emptyData() {
  const workspace = { id: uid(), name: 'ChiDi · bản chạy thử' };
  return {
    version: 1,
    ...emptySalesData(),
    workspace,
    role: 'owner',
    suppliers: [],
    products: [],
    purchase_receipts: [],
    cash_transactions: [],
    stock_movements: [],
    cash_movements: [],
    audit_events: [],
    import_batches: [],
    warehouses: [{ id: uid(), workspace_id: workspace.id, code: 'CHIDI-MAIN', name: 'Kho ChiDi' }],
    cash_accounts: accountCodes.map(([code, name]) => ({
      id: uid(),
      workspace_id: workspace.id,
      code,
      name,
      opening_balance: 0,
      opening_date: null,
      opening_confirmed: false,
    })),
  };
}
const copy = (value) => structuredClone(value);
function rowSignature(row) {
  const clean = { ...row };
  delete clean.provenance;
  delete clean.source_status;
  return JSON.stringify(
    Object.keys(clean)
      .sort()
      .map((k) => [k, clean[k]]),
  );
}
export function demoRepository(storage = globalThis.localStorage) {
  function read() {
    const raw = storage.getItem(KEY);
    if (!raw) return emptyData();
    try {
      const value = JSON.parse(raw);
      if (value.version !== 1 || !Array.isArray(value.cash_transactions)) throw Error();
      return { ...emptySalesData(), ...value };
    } catch {
      throw new Error(
        'Dữ liệu chạy thử trong trình duyệt không đọc được. Xuất bản sao đang có trước khi xóa; không tự đặt lại dữ liệu.',
      );
    }
  }
  let initial = read();
  if (!storage.getItem(KEY)) storage.setItem(KEY, JSON.stringify(initial));
  function mutate(fn) {
    const data = read();
    const result = fn(data);
    storage.setItem(KEY, JSON.stringify(data));
    return copy(result);
  }
  function audit(data, action, entity_id = null, details = {}) {
    data.audit_events.unshift({
      id: uid(),
      workspace_id: data.workspace.id,
      action,
      entity_id,
      details,
      created_at: now(),
      actor_id: 'demo-owner',
    });
  }
  function saveMaster(data, kind, payload) {
    if (!['suppliers', 'products', 'warehouses', 'cash_accounts'].includes(kind))
      throw new Error('Danh mục không hợp lệ.');
    const name = String(payload.name || '').trim(),
      code = String(payload.code || '')
        .trim()
        .toUpperCase();
    if (!name || name.length > 200 || !code || code.length > 80)
      throw new Error('Cần mã và tên hợp lệ.');
    const old = data[kind].find((r) => r.id === payload.id);
    if (payload.id && !old) throw new Error('Không tìm thấy danh mục.');
    if (old && old.code !== code) throw new Error('Mã danh mục không được đổi.');
    if (data[kind].some((r) => r.code === code && r.id !== payload.id))
      throw new Error('Mã đã tồn tại.');
    let extra = {};
    if (kind === 'products') {
      if (payload.supplier_id && !data.suppliers.some((r) => r.id === payload.supplier_id))
        throw new Error('Nhà cung cấp không hợp lệ.');
      extra = {
        unit_cost: integer(payload.unit_cost ?? 0, 'Giá tham khảo'),
        provisional: Boolean(payload.provisional),
        supplier_id: payload.supplier_id || null,
      };
    }
    if (kind === 'cash_accounts') {
      extra = {
        opening_balance: integer(payload.opening_balance ?? 0, 'Số dư đầu', { min: -9e12 }),
        opening_date: payload.opening_date || null,
        opening_confirmed: Boolean(payload.opening_confirmed),
      };
      if (extra.opening_confirmed && !validDate(extra.opening_date))
        throw new Error('Cần ngày mở sổ hợp lệ.');
      if (
        old &&
        data.cash_movements.some((r) => r.account_id === old.id) &&
        Object.keys(extra).some((k) => old[k] !== extra[k])
      )
        throw new Error('Tài khoản đã có giao dịch; không sửa số dư/ngày mở sổ.');
    }
    const row = {
      ...old,
      ...extra,
      id: old?.id || uid(),
      workspace_id: data.workspace.id,
      code,
      name,
      note: String(payload.note || ''),
      created_at: old?.created_at || now(),
    };
    if (old) Object.assign(old, row);
    else data[kind].push(row);
    audit(data, `${kind}.saved`, row.id, { code });
    return row;
  }
  function create(data, kind, payload) {
    const table = kind === 'purchase' ? 'purchase_receipts' : 'cash_transactions';
    const old = data[table].find((r) => r.id === payload.id);
    if (payload.id && (!old || old.status !== 'draft'))
      throw new Error('Chỉ sửa được chứng từ nháp.');
    const numeric =
      kind === 'purchase'
        ? {
            qty: integer(payload.qty, 'Số lượng', { min: 1, max: 1000000 }),
            unit_cost: integer(payload.unit_cost, 'Đơn giá'),
            additional_cost: integer(payload.additional_cost ?? 0, 'Chi phí thêm'),
            total_amount: purchaseTotal(payload),
          }
        : { amount: integer(payload.amount, 'Số tiền', { min: 1 }) };
    if (kind === 'cash' && !['in', 'out'].includes(payload.direction))
      throw new Error('Chiều tiền không hợp lệ.');
    const row = {
      ...payload,
      ...numeric,
      id: old?.id || uid(),
      workspace_id: data.workspace.id,
      status: 'draft',
      created_at: old?.created_at || now(),
      updated_at: now(),
    };
    if (old) {
      row.legacy_id = old.legacy_id;
      row.source_id = old.source_id;
      row.import_row_hash = old.import_row_hash;
      row.provenance = old.provenance;
      Object.assign(old, row);
    } else data[table].push(row);
    audit(data, `${kind}.draft_saved`, row.id);
    return row;
  }
  return {
    mode: 'demo',
    salesState: async () => salesState(read()),
    saveCustomer: async (p) => mutate((d) => saveCustomer(d, p)),
    saveSalesOrder: async (p) => mutate((d) => saveSalesOrder(d, p)),
    transitionSalesOrder: async (id, action, payload, requestId) =>
      mutate((d) => transitionSalesOrder(d, id, action, payload, requestId)),
    load: async () => copy(read()),
    saveMaster: async (kind, p) => mutate((d) => saveMaster(d, kind, p)),
    createPurchase: async (p) => mutate((d) => create(d, 'purchase', p)),
    createCash: async (p) => mutate((d) => create(d, 'cash', p)),
    post: async (kind, id) =>
      mutate((data) => {
        const r = data[kind === 'purchase' ? 'purchase_receipts' : 'cash_transactions'].find(
          (r) => r.id === id,
        );
        if (!r) throw new Error('Không tìm thấy chứng từ.');
        if (r.status === 'posted') return r;
        if (r.status !== 'draft') throw new Error('Chứng từ đã đảo, không ghi lại.');
        if (kind === 'purchase') {
          assertPurchasePost(r, data);
          assertPurchaseStockChange(data, r, r.received_date);
          data.stock_movements.push({
            id: uid(),
            workspace_id: data.workspace.id,
            purchase_id: r.id,
            product_id: r.product_id,
            warehouse_id: r.warehouse_id,
            received_date: r.received_date,
            movement_kind: 'post',
            qty: r.qty,
            unit_cost: r.unit_cost,
            amount: r.total_amount,
            created_at: now(),
          });
        } else {
          assertCashPost(r, data);
          data.cash_movements.push({
            id: uid(),
            workspace_id: data.workspace.id,
            cash_id: r.id,
            account_id: r.account_id,
            transaction_date: r.transaction_date,
            movement_kind: 'post',
            direction: r.direction,
            amount: r.amount,
            signed_amount: r.direction === 'in' ? r.amount : -r.amount,
            category: r.category,
            created_at: now(),
          });
        }
        r.status = 'posted';
        r.updated_at = now();
        audit(data, `${kind}.posted`, id);
        return r;
      }),
    reverse: async (kind, id, date, reason) =>
      mutate((data) => {
        if (!validDate(date) || String(reason).trim().length < 10)
          throw new Error('Cần ngày và lý do đảo ít nhất 10 ký tự.');
        const r = data[kind === 'purchase' ? 'purchase_receipts' : 'cash_transactions'].find(
          (r) => r.id === id,
        );
        if (!r) throw new Error('Không tìm thấy chứng từ.');
        if (r.status === 'reversed') return r;
        const originalDate = kind === 'purchase' ? r.received_date : r.transaction_date;
        if (r.status !== 'posted' || date < originalDate)
          throw new Error('Chỉ đảo chứng từ đã ghi; ngày đảo không trước ngày gốc.');
        if (kind === 'purchase') assertPurchaseStockChange(data, r, date, true);
        const table = kind === 'purchase' ? 'stock_movements' : 'cash_movements';
        const field = kind === 'purchase' ? 'purchase_id' : 'cash_id';
        const original = data[table].find((m) => m[field] === id && m.movement_kind === 'post');
        const reversal = { ...original, id: uid(), movement_kind: 'reversal', created_at: now() };
        if (kind === 'purchase')
          Object.assign(reversal, {
            qty: -original.qty,
            amount: -original.amount,
            received_date: date,
          });
        else
          Object.assign(reversal, {
            direction: original.direction === 'in' ? 'out' : 'in',
            signed_amount: -original.signed_amount,
            transaction_date: date,
          });
        data[table].push(reversal);
        r.status = 'reversed';
        audit(data, `${kind}.reversed`, id, { reason, date });
        return r;
      }),
    importLegacy: async (payload) =>
      mutate((data) => {
        validateImport(payload);
        const prior = data.import_batches.find((b) => b.source_id === payload.source_id);
        if (prior) return { ...prior.stats, already_imported: true };
        const result = { inserted_purchases: 0, inserted_cash: 0, skipped: 0, conflicts: [] };
        for (const r of payload.suppliers)
          if (!data.suppliers.some((s) => s.code === r.code.toUpperCase()))
            saveMaster(data, 'suppliers', r);
        for (const r of payload.products)
          if (!data.products.some((s) => s.code === r.code.toUpperCase()))
            saveMaster(data, 'products', {
              ...r,
              provisional: true,
              supplier_id: data.suppliers.find((s) => s.code === r.supplier_code)?.id,
            });
        for (const [list, kind, table] of [
          ['purchases', 'purchase', 'purchase_receipts'],
          ['cash', 'cash', 'cash_transactions'],
        ])
          for (const r of payload[list]) {
            const old = data[table].find((x) => x.legacy_id === r.legacy_id);
            const signature = rowSignature(r);
            if (old) {
              result.skipped++;
              if (old.import_row_hash !== signature)
                result.conflicts.push({
                  type: kind,
                  legacy_id: r.legacy_id,
                  reason: 'Dòng nguồn thay đổi; giữ nguyên bản đã nhập.',
                });
              continue;
            }
            const fields =
              kind === 'purchase'
                ? {
                    supplier_id: data.suppliers.find((s) => s.code === r.supplier_code)?.id || null,
                    product_id: data.products.find((s) => s.code === r.product_code)?.id || null,
                    warehouse_id: data.warehouses[0]?.id || null,
                  }
                : {
                    account_id:
                      data.cash_accounts.find((s) => s.code === r.account_code)?.id || null,
                  };
            create(data, kind, {
              ...r,
              ...fields,
              id: undefined,
              source_id: payload.source_id,
              import_row_hash: signature,
              provenance: {
                ...r.provenance,
                source_status: r.source_status,
                source_id: payload.source_id,
              },
            });
            result[kind === 'purchase' ? 'inserted_purchases' : 'inserted_cash']++;
          }
        data.import_batches.unshift({
          id: uid(),
          workspace_id: data.workspace.id,
          source_id: payload.source_id,
          source_name: payload.source_name,
          stats: result,
          created_at: now(),
        });
        audit(data, 'legacy.imported', null, result);
        return result;
      }),
    reset: async () => {
      storage.setItem(KEY, JSON.stringify(emptyData()));
    },
  };
}

export const cloudConfigured = Boolean(
  import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
);
export const requestedCloud = import.meta.env.VITE_DEMO_MODE === 'false';
export const supabase =
  cloudConfigured && requestedCloud
    ? createClient(
        import.meta.env.VITE_SUPABASE_URL,
        import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } },
      )
    : null;
export function cloudRepository(workspace, role) {
  const liveMigrations = {
    get_live_runtime: '012_live_runtime_telemetry.sql',
    get_live_intake: '007_live_intake.sql',
    save_live_campaign: '007_live_intake.sql',
    save_live_session: '007_live_intake.sql',
    save_live_integration_account: '007_live_intake.sql',
    ingest_live_comments: '007_live_intake.sql',
    claim_live_comment: '007_live_intake.sql',
    release_live_comment_claim: '007_live_intake.sql',
    get_live_commerce: '008_live_tickets_print.sql',
    commit_live_sale_ticket: '008_live_tickets_print.sql',
    void_live_sale_ticket: '008_live_tickets_print.sql',
    claim_live_print_job: '008_live_tickets_print.sql',
    finish_live_print_job: '008_live_tickets_print.sql',
    requeue_live_print_job: '008_live_tickets_print.sql',
    ...Object.fromEntries(
      ['get_tiktok_channels', 'save_tiktok_channel', 'request_tiktok_connection'].map((name) => [
        name,
        '010_tiktok_channel_flow.sql',
      ]),
    ),
    ...Object.fromEntries(
      [
        'get_live_operations',
        'request_live_connection',
        'set_live_comment_review',
        'ingest_live_comments_v2',
        'save_live_printer',
        'claim_live_print_job_configured',
        'reset_live_campaign_counter',
        'get_live_stock_preview',
      ].map((name) => [name, '009_live_operations.sql']),
    ),
  };
  const foundationMigrations = {
    get_catalog_state: '004_catalog_variants_aliases.sql',
    save_product_style: '004_catalog_variants_aliases.sql',
    save_product_variant: '004_catalog_variants_aliases.sql',
    save_product_alias: '004_catalog_variants_aliases.sql',
    resolve_product_alias: '004_catalog_variants_aliases.sql',
    get_customer_foundation: '005_customer_order_foundation.sql',
    save_customer_identity: '005_customer_order_foundation.sql',
    save_customer_address: '005_customer_order_foundation.sql',
    set_order_address: '005_customer_order_foundation.sql',
    save_order_payment_intent: '005_customer_order_foundation.sql',
    void_order_payment_intent: '005_customer_order_foundation.sql',
    get_inventory_foundation: '006_inventory_reservations.sql',
    reserve_inventory: '006_inventory_reservations.sql',
    release_inventory_reservation: '006_inventory_reservations.sql',
    transfer_inventory_reservations: '006_inventory_reservations.sql',
  };
  const rpc = async (name, args) => {
    const { data, error } = await supabase.rpc(name, args);
    if (error)
      throw new Error(
        error.code === 'PGRST202'
          ? liveMigrations[name]
            ? `Chưa có chức năng Phase C trong database. Xem docs/PHASE_C_LIVE_COMMERCE.md và migration ${liveMigrations[name]}. Không chạy lại migration lịch sử.`
            : foundationMigrations[name]
              ? `Chưa có chức năng Phase B trong database. Xem docs/PHASE_B_COMMERCE_FOUNDATION.md và migration ${foundationMigrations[name]}. Không chạy lại migration lịch sử.`
              : [
                    'get_sales_state',
                    'save_customer',
                    'save_sales_order',
                    'transition_sales_order',
                  ].includes(name)
                ? 'Chưa có phân hệ V2 trong database. Chạy migration 003_sales_inventory.sql theo docs/THIET_LAP_V2.md, rồi tải lại. Không chạy lại 001 hoặc 002.'
                : 'Chưa có chức năng này trong database. Chủ shop chạy migration 002_operations.sql theo hướng dẫn vận hành V1.1, rồi tải lại.'
          : error.message,
      );
    return data;
  };
  // A timed-out command may have committed. Callers keep its request ID for retry.
  const boundedRpc = async (name, args, signal) => {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    let timer;
    try {
      const result = await Promise.race([
        supabase.rpc(name, args).abortSignal(controller.signal),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(
              new Error(
                'Chưa nhận được phản hồi trong 12 giây. Bấm thử lại để kiểm tra cùng yêu cầu; hệ thống chưa xác nhận kết nối.',
              ),
            );
          }, 12000);
        }),
      ]);
      if (result.error) {
        if (controller.signal.aborted)
          throw new Error(
            'Chưa nhận được phản hồi. Bấm thử lại để kiểm tra cùng yêu cầu; hệ thống chưa xác nhận kết nối.',
          );
        if (result.error.code === 'PGRST202' && liveMigrations[name])
          throw new Error(
            `Chưa có dữ liệu theo dõi LIVE. Chủ shop áp dụng migration ${liveMigrations[name]} rồi tải lại; không chạy lại migration lịch sử.`,
          );
        throw new Error(result.error.message);
      }
      return result.data;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }
  };
  const addWorkspace = (p) => ({ ...p, workspace_id: workspace.id });
  return {
    mode: 'cloud',
    liveRuntime: (sessionId = null, { signal } = {}) =>
      boundedRpc(
        'get_live_runtime',
        { p_workspace_id: workspace.id, p_session_id: sessionId },
        signal,
      ),
    tiktokChannels: () => rpc('get_tiktok_channels', { p_workspace_id: workspace.id }),
    saveTikTokChannel: (payload, requestId) =>
      rpc('save_tiktok_channel', {
        p_workspace_id: workspace.id,
        p_payload: payload,
        p_request_id: requestId,
      }),
    requestTikTokConnection: (channelId, desired, requestId, { signal } = {}) =>
      boundedRpc(
        'request_tiktok_connection',
        {
          p_workspace_id: workspace.id,
          p_channel_id: channelId,
          p_desired_state: desired,
          p_request_id: requestId,
        },
        signal,
      ),
    liveOperations: () => rpc('get_live_operations', { p_workspace_id: workspace.id }),
    requestLiveConnection: (sessionId, desired, requestId) =>
      rpc('request_live_connection', {
        p_workspace_id: workspace.id,
        p_session_id: sessionId,
        p_desired_state: desired,
        p_request_id: requestId,
      }),
    setLiveCommentReview: (commentId, status, reason, requestId) =>
      rpc('set_live_comment_review', {
        p_workspace_id: workspace.id,
        p_comment_id: commentId,
        p_status: status,
        p_reason: reason,
        p_request_id: requestId,
      }),
    liveStockPreview: (sessionId, productId, date) =>
      rpc('get_live_stock_preview', {
        p_workspace_id: workspace.id,
        p_session_id: sessionId,
        p_product_id: productId,
        p_date: date,
      }),
    saveLivePrinter: (payload, requestId) =>
      rpc('save_live_printer', {
        p_workspace_id: workspace.id,
        p_payload: payload,
        p_request_id: requestId,
      }),
    resetLiveCounter: (campaignId, requestId) =>
      rpc('reset_live_campaign_counter', {
        p_workspace_id: workspace.id,
        p_campaign_id: campaignId,
        p_request_id: requestId,
      }),
    claimConfiguredLivePrintJob: (jobId, requestId) =>
      rpc('claim_live_print_job_configured', {
        p_workspace_id: workspace.id,
        p_job_id: jobId,
        p_request_id: requestId,
      }),
    liveIntake: (sessionId = null, cursor = null) =>
      rpc('get_live_intake', {
        p_workspace_id: workspace.id,
        p_session_id: sessionId || null,
        p_before: cursor?.before || null,
        p_before_id: cursor?.before_id || null,
        p_limit: 100,
      }),
    liveCommerce: (campaignId) =>
      rpc('get_live_commerce', { p_workspace_id: workspace.id, p_campaign_id: campaignId }),
    liveContext: async () => {
      const [catalog, sales] = await Promise.all([
        rpc('get_catalog_state', { p_workspace_id: workspace.id }),
        rpc('get_sales_state', { p_workspace_id: workspace.id }),
      ]);
      return { catalog, customers: sales.customers, inventory: sales.inventory || [] };
    },
    saveLiveCampaign: (p) =>
      rpc('save_live_campaign', { p_workspace_id: workspace.id, p_payload: p }),
    saveLiveSession: (p) =>
      rpc('save_live_session', { p_workspace_id: workspace.id, p_payload: p }),
    saveLiveIntegrationAccount: (p) =>
      rpc('save_live_integration_account', { p_workspace_id: workspace.id, p_payload: p }),
    ingestLiveComments: (sessionId, comments) =>
      rpc('ingest_live_comments', {
        p_workspace_id: workspace.id,
        p_session_id: sessionId,
        p_comments: comments,
      }),
    claimLiveComment: (id) =>
      rpc('claim_live_comment', { p_workspace_id: workspace.id, p_comment_id: id }),
    releaseLiveCommentClaim: (id, token) =>
      rpc('release_live_comment_claim', {
        p_workspace_id: workspace.id,
        p_comment_id: id,
        p_claim_token: token,
      }),
    commitLiveSaleTicket: (p, requestId) =>
      rpc('commit_live_sale_ticket', {
        p_workspace_id: workspace.id,
        p_payload: p,
        p_request_id: requestId,
      }),
    voidLiveSaleTicket: (id, date, reason, requestId) =>
      rpc('void_live_sale_ticket', {
        p_workspace_id: workspace.id,
        p_ticket_id: id,
        p_date: date,
        p_reason: reason,
        p_request_id: requestId,
      }),
    claimLivePrintJob: (id, requestId) =>
      rpc('claim_live_print_job', {
        p_workspace_id: workspace.id,
        p_job_id: id,
        p_request_id: requestId,
      }),
    finishLivePrintJob: (id, token, outcome, detail, requestId) =>
      rpc('finish_live_print_job', {
        p_workspace_id: workspace.id,
        p_job_id: id,
        p_lease_token: token,
        p_outcome: outcome,
        p_detail: detail,
        p_request_id: requestId,
      }),
    requeueLivePrintJob: (id, reason, requestId) =>
      rpc('requeue_live_print_job', {
        p_workspace_id: workspace.id,
        p_job_id: id,
        p_reason: reason,
        p_request_id: requestId,
      }),
    watchLive: (onChange, onStatus) => {
      let channel = supabase.channel(`live:${workspace.id}:${uid()}`);
      for (const table of [
        'live_integration_accounts',
        'live_campaigns',
        'live_sessions',
        'live_comments',
        'live_comment_claims',
        'live_sale_tickets',
        'customer_cart_items',
        'live_print_jobs',
        'live_session_telemetry',
      ])
        channel = channel.on(
          'postgres_changes',
          { event: '*', schema: 'public', table, filter: `workspace_id=eq.${workspace.id}` },
          () => onChange(),
        );
      channel.subscribe((status) => onStatus?.(status));
      return () => {
        void supabase.removeChannel(channel);
      };
    },
    foundationState: async () => {
      const [catalog, customer, stock, sales] = await Promise.all(
        [
          'get_catalog_state',
          'get_customer_foundation',
          'get_inventory_foundation',
          'get_sales_state',
        ].map((name) => rpc(name, { p_workspace_id: workspace.id })),
      );
      return { catalog, customer, stock, sales };
    },
    saveProductStyle: (p) =>
      rpc('save_product_style', { p_workspace_id: workspace.id, p_payload: p }),
    saveProductVariant: (p) =>
      rpc('save_product_variant', { p_workspace_id: workspace.id, p_payload: p }),
    saveProductAlias: (p) =>
      rpc('save_product_alias', { p_workspace_id: workspace.id, p_payload: p }),
    resolveProductAlias: (query) =>
      rpc('resolve_product_alias', { p_workspace_id: workspace.id, p_query: query }),
    saveCustomerIdentity: (p) =>
      rpc('save_customer_identity', { p_workspace_id: workspace.id, p_payload: p }),
    saveCustomerAddress: (p) =>
      rpc('save_customer_address', { p_workspace_id: workspace.id, p_payload: p }),
    setOrderAddress: (id, addressId) =>
      rpc('set_order_address', {
        p_workspace_id: workspace.id,
        p_order_id: id,
        p_address_id: addressId || null,
      }),
    saveOrderPaymentIntent: (p) =>
      rpc('save_order_payment_intent', { p_workspace_id: workspace.id, p_payload: p }),
    voidOrderPaymentIntent: (id, reason) =>
      rpc('void_order_payment_intent', {
        p_workspace_id: workspace.id,
        p_id: id,
        p_reason: reason,
      }),
    reserveInventory: (p, requestId) =>
      rpc('reserve_inventory', {
        p_workspace_id: workspace.id,
        p_payload: p,
        p_request_id: requestId,
      }),
    releaseInventoryReservation: (id, date, reason, requestId) =>
      rpc('release_inventory_reservation', {
        p_workspace_id: workspace.id,
        p_reservation_id: id,
        p_date: date,
        p_reason: reason,
        p_request_id: requestId,
      }),
    transferInventoryReservations: (orderId, ids, date, requestId) =>
      rpc('transfer_inventory_reservations', {
        p_workspace_id: workspace.id,
        p_order_id: orderId,
        p_reservation_ids: ids,
        p_date: date,
        p_request_id: requestId,
      }),
    salesState: () => rpc('get_sales_state', { p_workspace_id: workspace.id }),
    saveCustomer: (p) => rpc('save_customer', { p_workspace_id: workspace.id, p_payload: p }),
    saveSalesOrder: (p) => rpc('save_sales_order', { p_workspace_id: workspace.id, p_payload: p }),
    transitionSalesOrder: (id, action, payload, requestId = uid()) =>
      rpc('transition_sales_order', {
        p_workspace_id: workspace.id,
        p_order_id: id,
        p_action: action,
        p_payload: payload,
        p_request_id: requestId,
      }),
    report: (from, to) =>
      rpc('get_workspace_report', { p_workspace_id: workspace.id, p_from: from, p_to: to }),
    listMembers: () => rpc('list_workspace_members', { p_workspace_id: workspace.id }),
    addMember: (email, role) =>
      rpc('add_workspace_member', { p_workspace_id: workspace.id, p_email: email, p_role: role }),
    setMemberRole: (userId, role) =>
      rpc('set_workspace_member_role', {
        p_workspace_id: workspace.id,
        p_user_id: userId,
        p_role: role,
      }),
    removeMember: (userId) =>
      rpc('remove_workspace_member', { p_workspace_id: workspace.id, p_user_id: userId }),
    load: async () => {
      // Fetch every page explicitly: the service's default row cap must not silently truncate reports.
      const entries = await Promise.all(
        TABLES.map(async (table) => {
          const rows = [];
          for (let offset = 0; ; offset += 1000) {
            const { data, error } = await supabase
              .from(table)
              .select('*')
              .eq('workspace_id', workspace.id)
              .order('created_at', { ascending: true })
              .order('id')
              .range(offset, offset + 999);
            if (error) throw new Error(error.message);
            rows.push(...data);
            if (data.length < 1000) break;
            if (offset >= 99000)
              throw new Error(
                'Tập dữ liệu vượt dung lượng V1. Cần API báo cáo phân trang trên server trước khi tiếp tục.',
              );
          }
          return [table, rows];
        }),
      );
      return { workspace, role, ...Object.fromEntries(entries) };
    },
    saveMaster: (kind, payload) =>
      rpc('save_master', { p_kind: kind, p_payload: addWorkspace(payload) }),
    createPurchase: (p) => rpc('create_purchase', { p_payload: addWorkspace(p) }),
    createCash: (p) => rpc('create_cash', { p_payload: addWorkspace(p) }),
    post: (kind, id) =>
      rpc(kind === 'purchase' ? 'post_purchase' : 'post_cash', { p_id: id, p_request_id: uid() }),
    reverse: (kind, id, date, reason) =>
      rpc('reverse_document', {
        p_kind: kind,
        p_id: id,
        p_request_id: uid(),
        p_date: date,
        p_reason: reason,
      }),
    importLegacy: (payload) => rpc('import_legacy', { p_payload: addWorkspace(payload) }),
  };
}
