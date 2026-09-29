import { describe, expect, it } from 'vitest';
import {
  filterLiveTickets,
  groupLiveSessions,
  groupLiveTicketDays,
  liveDateRange,
  summarizeLiveCarts,
  summarizeLiveTickets,
  toVietnamDate,
} from './live-view.js';

const ticket = (id, changes = {}) => ({
  id,
  ticket_no: `LS-${id}`,
  campaign_id: 'campaign-1',
  session_id: 'session-1',
  cart_id: 'cart-1',
  campaign_customer_id: 'buyer-27',
  status: 'committed',
  qty: 2,
  line_total: '240001',
  business_date: '2026-09-21',
  committed_at: '2026-09-21T08:00:00Z',
  product_snapshot: { sku: 'Q49-M', name: 'Quần xanh', color: 'Xanh', size: 'M' },
  customer_snapshot: { name: 'Nguyễn Diệu', customer_no: 27, author_external_id: 'user-1' },
  ...changes,
});

describe('live read models', () => {
  it('counts committed goods and buyers while excluding VOID from value and quantity', () => {
    const rows = [
      ticket('1'),
      ticket('2', { status: 'voided', qty: 90, line_total: '999999' }),
      ticket('3', {
        cart_id: 'cart-2',
        campaign_customer_id: 'buyer-28',
        qty: 1,
        line_total: '120000',
      }),
      ticket('4', { status: 'draft', line_total: '5000000' }),
    ];
    expect(summarizeLiveTickets(rows)).toEqual({
      ticket_count: 4,
      committed_count: 2,
      voided_count: 1,
      qty: 3,
      total_amount: 360001n,
      cart_count: 2,
      customer_count: 2,
    });
    expect(summarizeLiveTickets()).toEqual({
      ticket_count: 0,
      committed_count: 0,
      voided_count: 0,
      qty: 0,
      total_amount: 0n,
      cart_count: 0,
      customer_count: 0,
    });
  });

  it('keeps exact VND when a campaign total exceeds JavaScript safe integer precision', () => {
    const rows = Array.from({ length: 1001 }, (_, index) =>
      ticket(String(index), { qty: 1, line_total: '9000000000000' }),
    );
    rows.push(ticket('small', { qty: 1, line_total: '1' }));
    expect(summarizeLiveTickets(rows).total_amount).toBe(9009000000000001n);
    expect(groupLiveTicketDays(rows)[0].total_amount).toBe(9009000000000001n);
  });

  it('filters inclusive business dates without substituting commit timestamps or VOID dates', () => {
    const rows = [
      ticket('before', { business_date: '2026-09-19' }),
      ticket('start', { business_date: '2026-09-20', committed_at: '2026-09-22T01:00:00Z' }),
      ticket('end', { status: 'voided', void_date: '2026-09-25' }),
      ticket('after', { business_date: '2026-09-22' }),
      ticket('unknown', { business_date: null }),
    ];
    const filters = { from: '2026-09-20', to: '2026-09-21' };
    expect(filterLiveTickets(rows, filters).map((row) => row.id)).toEqual(['start', 'end']);
    expect(
      filterLiveTickets(rows, { ...filters, status: 'committed' }).map((row) => row.id),
    ).toEqual(['start']);
    expect(filterLiveTickets(rows)).toHaveLength(5);
  });

  it('uses the explicitly supplied Vietnam today for calendar presets and custom ranges', () => {
    expect(liveDateRange('today', '2026-09-21')).toMatchObject({
      from: '2026-09-21',
      to: '2026-09-21',
    });
    expect(liveDateRange('7d', '2024-03-01')).toMatchObject({
      from: '2024-02-24',
      to: '2024-03-01',
    });
    expect(liveDateRange('30d', '2026-09-21').from).toBe('2026-08-23');
    expect(liveDateRange('180d', '2026-09-21').from).toBe('2026-03-26');
    expect(liveDateRange('365d', '2026-09-21').from).toBe('2025-09-22');
    expect(
      liveDateRange('custom', '2026-09-21', { from: '2026-08-01', to: '2026-08-31' }),
    ).toMatchObject({ from: '2026-08-01', to: '2026-08-31' });
    expect(liveDateRange('all', '2026-09-21')).toMatchObject({ from: null, to: null });
  });

  it('rejects malformed ranges or imprecise money instead of silently producing an incorrect report', () => {
    expect(() => liveDateRange('today', '2026-02-30')).toThrow('LIVE_TODAY_INVALID');
    expect(() =>
      liveDateRange('custom', '2026-09-21', { from: '2026-09-22', to: '2026-09-21' }),
    ).toThrow('LIVE_DATE_RANGE_INVALID');
    expect(() => liveDateRange('custom', '2026-09-21')).toThrow('LIVE_DATE_RANGE_INVALID');
    expect(() => filterLiveTickets([], { from: '2026-02-30' })).toThrow('LIVE_DATE_RANGE_INVALID');
    for (const value of [Number.MAX_SAFE_INTEGER + 1, 1.5, '1.5', '-1', null, NaN])
      expect(() => summarizeLiveTickets([ticket('bad', { line_total: value })])).toThrow(
        'LIVE_AMOUNT_INVALID',
      );
    expect(() => summarizeLiveTickets([ticket('bad', { qty: 0 })])).toThrow(
      'LIVE_QUANTITY_INVALID',
    );
  });

  it('fills only explicitly selected daily gaps and retains unknown dates without inventing observations', () => {
    const rows = [
      ticket('1', { business_date: '2026-09-19' }),
      ticket('2', { status: 'voided', void_date: '2026-09-23' }),
      ticket('unknown', { business_date: null }),
    ];
    const series = groupLiveTicketDays(rows, {
      from: '2026-09-19',
      to: '2026-09-21',
      fillMissing: true,
    });
    expect(series.map((row) => [row.date, row.total_amount, row.voided_count])).toEqual([
      ['2026-09-19', 240001n, 0],
      ['2026-09-20', 0n, 0],
      ['2026-09-21', 0n, 1],
    ]);
    expect(groupLiveTicketDays(rows).at(-1)).toMatchObject({ date: null, total_amount: 240001n });
    expect(() => groupLiveTicketDays([], { fillMissing: true })).toThrow(
      'LIVE_SERIES_RANGE_REQUIRED',
    );
    expect(() =>
      groupLiveTicketDays([], { from: '2024-01-01', to: '2026-01-01', fillMissing: true }),
    ).toThrow('LIVE_SERIES_RANGE_LIMIT');
  });

  it('keeps one original cart/STT across sessions and does not merge display names or double-count items', () => {
    const commerce = {
      campaign_customers: [
        {
          id: 'buyer-27',
          customer_no: 27,
          display_name_snapshot: 'Nguyễn Diệu',
          author_external_id: 'user-1',
        },
        {
          id: 'buyer-28',
          customer_no: 28,
          display_name_snapshot: 'Nguyễn Diệu',
          author_external_id: 'user-2',
        },
      ],
      carts: [
        {
          id: 'cart-1',
          campaign_id: 'campaign-1',
          campaign_customer_id: 'buyer-27',
          total_amount: '999',
        },
        { id: 'cart-2', campaign_id: 'campaign-1', campaign_customer_id: 'buyer-28' },
      ],
      tickets: [
        ticket('1'),
        ticket('2', { session_id: 'session-2', qty: 1, line_total: '100000' }),
        ticket('3', { cart_id: 'cart-2', campaign_customer_id: 'buyer-28', status: 'voided' }),
      ],
      items: [{ ticket_id: '1', status: 'active', line_total: '240001' }],
    };
    const rows = summarizeLiveCarts(commerce);
    expect(rows.map((row) => [row.customer_no, row.committed_count, row.total_amount])).toEqual([
      [27, 2, 340001n],
      [28, 0, 0n],
    ]);
    expect(rows[0].tickets).toHaveLength(2);
    expect(rows[1].voided_count).toBe(1);
    expect(summarizeLiveCarts(commerce, { sessionId: 'session-2' })).toHaveLength(1);
    expect(summarizeLiveCarts(commerce, { sessionId: 'session-2' })[0]).toMatchObject({
      customer_no: 27,
      total_amount: 100000n,
    });
  });

  it('searches ticket snapshots and customer labels while keeping a matching cart total intact', () => {
    const first = ticket('1'),
      second = ticket('2', {
        product_snapshot: { sku: 'OTHER', name: 'Áo đỏ' },
        line_total: '100000',
      });
    const commerce = {
      tickets: [first, second],
      carts: [{ id: 'cart-1', campaign_id: 'campaign-1', campaign_customer_id: 'buyer-27' }],
      campaign_customers: [
        { id: 'buyer-27', customer_no: 27, display_name_snapshot: 'Nguyễn Diệu' },
      ],
    };
    expect(filterLiveTickets([first, second], { query: 'quần' }).map((row) => row.id)).toEqual([
      '1',
    ]);
    expect(filterLiveTickets([first, second], { campaignId: 'other' })).toEqual([]);
    expect(summarizeLiveCarts(commerce, { query: 'QUẦN' })[0].total_amount).toBe(340001n);
    expect(summarizeLiveCarts(commerce, { query: '#027' })[0].customer_no).toBe(27);
    expect(summarizeLiveCarts(commerce, { query: 'nguyễn' })).toHaveLength(1);
  });

  it('groups session creation dates in Vietnam and preserves missing dates without assuming start or duration', () => {
    const sessions = [
      {
        id: 'old',
        campaign_id: 'c1',
        code: 'A',
        status: 'ended',
        created_at: '2026-09-20T16:59:59Z',
      },
      {
        id: 'new',
        campaign_id: 'c1',
        code: 'B',
        status: 'live',
        created_at: '2026-09-20T17:00:00Z',
      },
      { id: 'missing', campaign_id: 'c1', code: 'C', status: 'draft' },
      { id: 'invalid', campaign_id: 'c2', code: 'D', status: 'ended', created_at: 'invalid' },
    ];
    expect(toVietnamDate('2026-09-20T17:00:00Z')).toBe('2026-09-21');
    expect(toVietnamDate('2026-09-20T17:00:00')).toBeNull();
    expect(toVietnamDate('2026-02-30')).toBeNull();
    const groups = groupLiveSessions(sessions);
    expect(groups.map((row) => row.created_date)).toEqual(['2026-09-21', '2026-09-20', null]);
    expect(groups.at(-1).sessions).toHaveLength(2);
    expect(
      groupLiveSessions(sessions, { from: '2026-09-21', to: '2026-09-21' })[0].sessions,
    ).toEqual([sessions[1]]);
    expect(
      groupLiveSessions(sessions, { campaignId: 'c1', status: 'draft', query: 'c' })[0],
    ).toEqual({ created_date: null, sessions: [sessions[2]] });
    expect(groups[0]).not.toHaveProperty('duration');
  });

  it('leaves source arrays and persisted rows unchanged during filtering/grouping', () => {
    const tickets = [
      ticket('2', { business_date: '2026-09-21' }),
      ticket('1', { business_date: '2026-09-20' }),
    ];
    const sessions = [
      { id: '2', created_at: '2026-09-20T08:00:00Z' },
      { id: '1', created_at: '2026-09-21T08:00:00Z' },
    ];
    const before = JSON.stringify({ tickets, sessions });
    filterLiveTickets(tickets, { query: 'xanh' });
    summarizeLiveTickets(tickets);
    groupLiveTicketDays(tickets);
    groupLiveSessions(sessions);
    expect(JSON.stringify({ tickets, sessions })).toBe(before);
  });
});
