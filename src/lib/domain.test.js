import { describe, it, expect } from 'vitest';
import {
  integer,
  validDate,
  purchaseTotal,
  sum,
  statistics,
  csv,
  validateImport,
} from './domain.js';
import { demoRepository } from './repository.js';
import { sampleImport } from '../demo-sample.js';
const storage = () => {
  const values = new Map();
  return { getItem: (k) => values.get(k) || null, setItem: (k, v) => values.set(k, v) };
};

describe('Financial input and reporting invariants', () => {
  it('rejects fractional VND, blanks, unsafe integers and overflowing receipts', () => {
    for (const n of [null, '', undefined, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])
      expect(() => integer(n, 'Tiền')).toThrow();
    expect(purchaseTotal({ qty: 3, unit_cost: 85000, additional_cost: 5000 })).toBe(260000);
    expect(() => purchaseTotal({ qty: 1000000, unit_cost: 9000000000000 })).toThrow();
  });
  it('validates real calendar dates without rolling into next month', () => {
    expect(validDate('2026-02-30')).toBe(false);
    expect(validDate('2024-02-29')).toBe(true);
    expect(validDate('2026-13-01')).toBe(false);
    expect(validDate('18/08/2026')).toBe(false);
  });
  it('accumulates exactly, tolerates cancelling intermediate totals and refuses unsafe final totals', () => {
    expect(sum([Number.MAX_SAFE_INTEGER, 1, -1])).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => sum([Number.MAX_SAFE_INTEGER, 1])).toThrow();
    expect(() => sum([NaN])).toThrow();
  });
  it('escapes CSV spreadsheet formulas, quotes and multiline content', () => {
    const result = csv([['=HYPERLINK("x")', ' +SUM(1,2)', 'A\nB', 'Tên']]);
    expect(result).toContain("'=HYPERLINK");
    expect(result).toContain("' +SUM");
    expect(result).toContain('"A\nB"');
    expect(result.startsWith('\uFEFF')).toBe(true);
  });
  it('rejects duplicate source identifiers before any import', () => {
    const payload = sampleImport('2026-08-18');
    payload.purchases.push({ ...payload.purchases[0] });
    expect(() => validateImport(payload)).toThrow();
  });
});

describe('Demo workflow contract', () => {
  it('imports as drafts, never trusts source posted flags, and reimports changed files without duplicates', async () => {
    const repo = demoRepository(storage()),
      p = sampleImport('2026-08-18');
    p.purchases[0].source_status = 'Có';
    await repo.importLegacy(p);
    let data = await repo.load();
    expect(data.purchase_receipts).toHaveLength(3);
    expect(data.stock_movements).toHaveLength(0);
    expect(data.purchase_receipts.every((r) => r.status === 'draft')).toBe(true);
    expect(data.products.every((r) => r.provisional)).toBe(true);
    expect((await repo.importLegacy(p)).already_imported).toBe(true);
    p.source_id = 'e'.repeat(64);
    p.purchases[0].unit_cost += 1000;
    const result = await repo.importLegacy(p);
    expect(result.conflicts).toHaveLength(1);
    expect(result.inserted_purchases).toBe(0);
    data = await repo.load();
    expect(data.purchase_receipts).toHaveLength(3);
    expect(data.purchase_receipts[0].unit_cost).not.toBe(p.purchases[0].unit_cost);
  });
  it('posting a receipt requires evidence, is idempotent, and reversal retains the original', async () => {
    const repo = demoRepository(storage());
    await repo.importLegacy(sampleImport('2026-08-18'));
    let data = await repo.load(),
      row = data.purchase_receipts[0];
    await expect(repo.post('purchase', row.id)).rejects.toThrow();
    const product = data.products.find((p) => p.id === row.product_id);
    await repo.saveMaster('products', { ...product, provisional: false });
    row = await repo.createPurchase({ ...row, date_estimated: false });
    await repo.post('purchase', row.id);
    await repo.post('purchase', row.id);
    data = await repo.load();
    expect(data.stock_movements).toHaveLength(1);
    expect(statistics(data).units).toBe(row.qty);
    await expect(repo.createPurchase({ ...row, qty: 99 })).rejects.toThrow();
    await repo.reverse('purchase', row.id, '2026-08-19', 'Đối chiếu chứng từ phát hiện sai');
    data = await repo.load();
    expect(data.purchase_receipts).toHaveLength(3);
    expect(data.stock_movements).toHaveLength(2);
    expect(statistics(data).units).toBe(0);
    expect(statistics(data, '', '2026-08-18').units).toBe(row.qty);
  });
  it('cash cannot post to unknown balances; reversal cancels expense without counting COD as revenue', async () => {
    const repo = demoRepository(storage());
    let data = await repo.load();
    const a = data.cash_accounts[0];
    const row = await repo.createCash({
      transaction_date: '2026-08-18',
      date_estimated: false,
      account_id: a.id,
      direction: 'out',
      amount: 125000,
      category: 'packaging',
      description: 'Bao bì',
    });
    await expect(repo.post('cash', row.id)).rejects.toThrow();
    await repo.saveMaster('cash_accounts', {
      ...a,
      opening_confirmed: true,
      opening_date: '2026-08-01',
      opening_balance: 1000000,
    });
    await repo.post('cash', row.id);
    expect(statistics(await repo.load()).expense).toBe(125000);
    await expect(
      repo.saveMaster('cash_accounts', {
        ...a,
        opening_confirmed: true,
        opening_date: '2026-08-01',
        opening_balance: 2000000,
      }),
    ).rejects.toThrow();
    await repo.reverse('cash', row.id, '2026-08-19', 'Hủy do nhập trùng chứng từ giấy');
    const cod = await repo.createCash({
      transaction_date: '2026-08-20',
      date_estimated: false,
      account_id: a.id,
      direction: 'in',
      amount: 500000,
      category: 'legacy_cod',
    });
    await repo.post('cash', cod.id);
    const stats = statistics(await repo.load());
    expect(stats.expense).toBe(0);
    expect(stats.cashIn - stats.cashOut).toBe(500000);
    expect(statistics(await repo.load(), '2026-08-01', '2026-08-18').expense).toBe(125000);
  });
  it('a failed import leaves no half-imported state', async () => {
    const repo = demoRepository(storage()),
      p = sampleImport('2026-08-18');
    p.cash[0].amount = 0;
    await expect(repo.importLegacy(p)).rejects.toThrow();
    const data = await repo.load();
    expect(data.products).toHaveLength(0);
    expect(data.import_batches).toHaveLength(0);
  });
  it('malformed local data is preserved and produces a clear error', () => {
    const s = storage();
    s.setItem('chidi.erp.demo.v1', '{broken');
    expect(() => demoRepository(s)).toThrow();
    expect(s.getItem('chidi.erp.demo.v1')).toBe('{broken');
  });
});
