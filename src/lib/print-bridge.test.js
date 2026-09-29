import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PRINT_OPTIONS,
  normalizePrintOptions,
  normalizeReceiptSnapshot,
  prepareBrowserPrint,
  probeLanBridge,
  renderReceiptHtml,
  sendToLanBridge,
} from './print-bridge.js';

const receipt = {
  ticket_no: 'LIVE-001',
  customer_no: '027',
  customer_name: 'Nguyễn Thị Diệu',
  campaign_name: 'ChiDi tháng 9',
  session_code: 'LIVE-1',
  committed_at: '2026-09-17T09:00:00Z',
  lines: [
    {
      product_id: 'p1',
      sku: 'JEAN-49-XANH-M',
      name: 'Quần xanh đậm',
      color: 'Xanh đậm',
      size: 'M',
      qty: 2,
      unit_price: '120000',
      line_total: '240000',
    },
  ],
  total_amount: '240000',
};

describe('immutable receipt and browser printing', () => {
  it('keeps absent/null/explicit default options and absent username backward compatible', () => {
    const legacy = renderReceiptHtml(receipt);
    expect(renderReceiptHtml(receipt, { printOptions: null })).toBe(legacy);
    expect(renderReceiptHtml(receipt, { printOptions: {} })).toBe(legacy);
    expect(renderReceiptHtml(receipt, { printOptions: DEFAULT_PRINT_OPTIONS })).toBe(legacy);
    expect(normalizeReceiptSnapshot({ ...receipt, customer_username: null })).toEqual(receipt);
    expect(normalizePrintOptions(null)).toEqual(DEFAULT_PRINT_OPTIONS);
  });
  it('copies only supported settings without mutating inputs or canonical defaults', () => {
    const options = Object.freeze({ show_price: false, font_scale_customer: 3, auto_cut: false });
    const normalized = normalizePrintOptions(options);
    expect(normalized).toMatchObject(options);
    expect(normalized.copies).toBe(1);
    normalized.show_qty = false;
    expect(DEFAULT_PRINT_OPTIONS.show_qty).toBe(true);
  });
  it.each([
    { copies: 2 },
    { copies: '1' },
    { font_scale_customer: 0 },
    { font_scale_product: 4 },
    { font_scale_customer: 1.5 },
    { font_scale_product: Infinity },
    { show_qty: 'false' },
    { show_price: null },
    { auto_cut: 1 },
    { driver: 'TSPL' },
    { html: '<script>x()</script>' },
    { paper_width: 57 },
    [],
    'template',
  ])('rejects unsupported or unsafe print options %j', (printOptions) => {
    expect(() => renderReceiptHtml(receipt, { printOptions })).toThrow('PRINT_INVALID_OPTIONS');
  });
  it('hides individual sensitive display fields and retains the business snapshot unchanged', () => {
    const data = { ...receipt, customer_username: '@dieu_2004' };
    const before = JSON.stringify(data);
    const printOptions = Object.fromEntries(
      Object.keys(DEFAULT_PRINT_OPTIONS)
        .filter((key) => key.startsWith('show_'))
        .map((key) => [key, false]),
    );
    const html = renderReceiptHtml(data, { printOptions });
    for (const value of [
      'LIVE-001',
      '027',
      '@dieu_2004',
      'JEAN-49-XANH-M',
      'Quần xanh đậm',
      'Xanh đậm',
      'Cỡ:',
      '120.000',
      '240.000',
      '17/9/2026',
      '2 ×',
    ])
      expect(html).not.toContain(value);
    expect(html).toContain('Nguyễn Thị Diệu');
    expect(JSON.stringify(data)).toBe(before);
  });
  it('applies finite fonts and independent quantity/price visibility', () => {
    const scaled = renderReceiptHtml(receipt, {
      printOptions: { font_scale_customer: 3, font_scale_product: 2 },
    });
    expect(scaled).toContain('font-size:36px');
    expect(scaled).toContain('font-size:24px');
    const noPrice = renderReceiptHtml(receipt, { printOptions: { show_price: false } });
    expect(noPrice).toContain('SL: 2');
    expect(noPrice).not.toContain('120.000');
    const noQuantity = renderReceiptHtml(receipt, { printOptions: { show_qty: false } });
    expect(noQuantity).not.toContain('2 ×');
    expect(noQuantity).toContain('120.000');
  });
  it('validates and escapes optional observed username without assuming it is an identity', () => {
    const data = { ...receipt, customer_username: '@<img src=x>' };
    expect(renderReceiptHtml(data)).toContain('@&lt;img src=x&gt;');
    expect(renderReceiptHtml(data)).not.toContain('<img');
    expect(renderReceiptHtml(data, { printOptions: { show_username: false } })).not.toContain(
      '@&lt;img',
    );
    expect(() => normalizeReceiptSnapshot({ ...receipt, customer_username: 'x\nsecret' })).toThrow(
      'PRINT_INVALID_SNAPSHOT',
    );
    expect(() =>
      normalizeReceiptSnapshot({ ...receipt, customer_username: 'x'.repeat(201) }),
    ).toThrow('PRINT_INVALID_SNAPSHOT');
  });
  it('escapes all display fields, preserves Vietnamese, and ignores raw comments/URLs', () => {
    const malicious = {
      ...receipt,
      customer_name: '<img src=x onerror="alert(1)">',
      raw_comment: '<script>bad()</script>',
      url: 'https://attacker.invalid',
      lines: [{ ...receipt.lines[0], name: 'Quần <b>đẹp</b>' }],
    };
    const before = JSON.stringify(malicious);
    const html = renderReceiptHtml(malicious);
    expect(html).toContain('&lt;img');
    expect(html).toContain('Quần &lt;b&gt;đẹp&lt;/b&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('attacker.invalid');
    expect(JSON.stringify(malicious)).toBe(before);
  });
  it('supports only 58/80mm, validates totals and does not reconstruct prices', () => {
    expect(renderReceiptHtml(receipt, { paperWidth: 58 })).toContain('width:58mm');
    expect(renderReceiptHtml(receipt)).toContain('width:80mm');
    expect(() => renderReceiptHtml(receipt, { paperWidth: '80;url(x)' })).toThrow(
      'PRINT_INVALID_WIDTH',
    );
    expect(() => normalizeReceiptSnapshot({ ...receipt, total_amount: '999' })).toThrow(
      'PRINT_INVALID_SNAPSHOT',
    );
    expect(() =>
      normalizeReceiptSnapshot({ ...receipt, lines: [{ ...receipt.lines[0], qty: Infinity }] }),
    ).toThrow();
    expect(() => normalizeReceiptSnapshot({ ...receipt, committed_at: 'yesterday' })).toThrow();
  });
  it('opens synchronously, renders the committed snapshot, and never treats afterprint as paper proof', async () => {
    const popup = {
      closed: false,
      opener: {},
      document: {
        open: vi.fn(),
        write: vi.fn(),
        close: vi.fn(),
        fonts: { ready: Promise.resolve() },
      },
      focus: vi.fn(),
      print: vi.fn(),
      close: vi.fn(),
    };
    const windowObject = { open: vi.fn(() => popup) };
    const handle = prepareBrowserPrint({ windowObject });
    expect(windowObject.open).toHaveBeenCalledOnce();
    expect(popup.print).not.toHaveBeenCalled();
    expect(popup.opener).toBeNull();
    await expect(handle.print(receipt)).resolves.toEqual({
      status: 'dialog_opened',
      paper_confirmed: false,
    });
    expect(popup.print).toHaveBeenCalledOnce();
    await expect(handle.print(receipt)).rejects.toThrow('PRINT_WINDOW_UNAVAILABLE');
    handle.close();
    expect(popup.close).toHaveBeenCalledOnce();
  });
  it('reports blocked popups without any sale/print side effects', () => {
    expect(() => prepareBrowserPrint({ windowObject: { open: () => null } })).toThrow(
      'PRINT_POPUP_BLOCKED',
    );
  });
  it('accepts configured options after claim while opening the popup synchronously', async () => {
    const popup = {
      closed: false,
      document: { open: vi.fn(), write: vi.fn(), close: vi.fn() },
      focus: vi.fn(),
      print: vi.fn(),
    };
    const handle = prepareBrowserPrint({ windowObject: { open: () => popup } });
    await handle.print(receipt, { paperWidth: 58, printOptions: { show_price: false } });
    const html = popup.document.write.mock.calls.at(-1)[0];
    expect(html).toContain('width:58mm');
    expect(html).toContain('SL: 2');
    expect(html).not.toContain('240.000');
    expect(popup.print).toHaveBeenCalledOnce();
  });
});

describe('loopback LAN bridge client', () => {
  const options = {
    baseUrl: 'http://127.0.0.1:47831',
    token: 'a'.repeat(43),
    attemptId: 'attempt_1',
    snapshot: receipt,
  };
  it('sends structured snapshots exactly once and never marks sent bytes as paper success', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ status: 'sent', replayed: false }),
    }));
    await expect(sendToLanBridge({ ...options, fetchImpl })).resolves.toMatchObject({
      status: 'sent',
      paper_confirmed: false,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, request] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:47831/print');
    expect(request.redirect).toBe('error');
    expect(JSON.parse(request.body).snapshot).toEqual(receipt);
  });
  it.each([
    'https://attacker.invalid',
    'http://127.0.0.1.attacker.invalid',
    'http://user:pass@localhost:47831',
    'http://localhost:47831/redirect',
    'file:///tmp/printer',
  ])('rejects unsafe destination %s before sending credentials', async (baseUrl) => {
    const fetchImpl = vi.fn();
    await expect(sendToLanBridge({ ...options, baseUrl, fetchImpl })).rejects.toThrow(
      'PRINT_INVALID_BRIDGE',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('sanitizes network errors and never retries an ambiguous attempt', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error(`secret ${options.token}`);
    });
    await expect(sendToLanBridge({ ...options, fetchImpl })).rejects.toThrow(
      'PRINT_BRIDGE_UNKNOWN',
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it('sends canonical options with immutable snapshot and rejects unsupported copies before transport', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ status: 'dry_run' }) }));
    await sendToLanBridge({
      ...options,
      paperWidth: 58,
      printOptions: { auto_cut: false, show_price: false },
      fetchImpl,
    });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({
      paper_width: 58,
      print_options: { auto_cut: false, show_price: false, copies: 1 },
      snapshot: receipt,
    });
    await expect(
      sendToLanBridge({ ...options, printOptions: { copies: 2 }, fetchImpl }),
    ).rejects.toThrow('PRINT_INVALID_OPTIONS');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it('health performs one authenticated GET and reports neither paper nor printer connectivity', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        status: 'ready',
        mode: 'lan',
        paper_confirmed: true,
        secret: 'ignored',
      }),
    }));
    await expect(probeLanBridge({ ...options, fetchImpl })).resolves.toEqual({
      status: 'ready',
      mode: 'lan',
      paper_confirmed: false,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0][0]).toBe('http://127.0.0.1:47831/health');
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({
      method: 'GET',
      headers: { Authorization: `Bearer ${options.token}` },
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
    });
    expect(fetchImpl.mock.calls[0][1].body).toBeUndefined();
  });
  it('health rejects credential exfiltration destinations and unsafe response/errors without retry', async () => {
    const fetchImpl = vi.fn(async () => {
      throw Error(options.token);
    });
    await expect(
      probeLanBridge({ ...options, baseUrl: 'https://attacker.invalid', fetchImpl }),
    ).rejects.toThrow('PRINT_INVALID_BRIDGE');
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(probeLanBridge({ ...options, fetchImpl })).rejects.toThrow(
      'PRINT_BRIDGE_UNAVAILABLE',
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
    await expect(
      probeLanBridge({
        ...options,
        fetchImpl: async () => ({
          ok: true,
          json: async () => ({ status: 'printed', mode: 'lan' }),
        }),
      }),
    ).rejects.toThrow('PRINT_BRIDGE_UNAVAILABLE');
  });
});
