import { describe, expect, it } from 'vitest';
import { normalizeLiveText, parseLiveComment } from './live-parser.js';

const catalog = {
  products: [
    { id: 'p1', code: 'JEAN-XANH-M', name: 'Quần xanh', provisional: false },
    { id: 'p2', code: 'JEAN-ĐỎ-L', name: 'Quần đỏ', provisional: false },
    { id: 'p3', code: '1024', name: 'SKU số', provisional: false },
    { id: 'p4', code: 'TẠM', name: 'Chưa đối chiếu', provisional: true },
  ],
  styles: [{ id: 's1', code: '49' }, { id: 's2', code: 'STANDALONE' }],
  variants: [
    { id: 'p1', product_id: 'p1', style_id: 's1', size: 'M', color: 'Xanh', mapping_status: 'confirmed' },
    { id: 'p2', product_id: 'p2', style_id: 's1', size: 'L', color: 'Đỏ', mapping_status: 'confirmed' },
    { id: 'p3', product_id: 'p3', style_id: 's2', size: '29', color: 'Xanh đậm', mapping_status: 'confirmed' },
    { id: 'p4', product_id: 'p4', style_id: null, size: null, color: null, mapping_status: 'needs_review' },
  ],
  aliases: [
    { product_id: 'p1', alias_text: 'QUẦN XANH', active: true },
    { product_id: 'p1', alias_text: 'Q49', active: true },
    { product_id: 'p2', alias_text: 'Q49', active: true },
    { product_id: 'p3', alias_text: 'quần xanh đậm', active: true },
    { product_id: 'p2', alias_text: 'HẾT', active: false },
  ],
};

describe('deterministic live suggestions', () => {
  it('normalizes NFC/case/Unicode whitespace without removing Vietnamese accents', () => {
    expect(normalizeLiveText('  QUẦN\u00a0XANH\u2003 ')).toBe('quần xanh');
    expect(parseLiveComment('QUẦN\u00a0XANH', catalog).product_id).toBe('p1');
    expect(parseLiveComment('quan xanh', catalog).status).toBe('no_match');
  });
  it('parses style + exact color + size + explicit quantity without mutation', () => {
    const original = JSON.stringify(catalog);
    const parsed = parseLiveComment('49 xanh m 2c', catalog);
    expect(parsed).toMatchObject({ status: 'unique', product_id: 'p1', quantity: 2, quantity_source: 'explicit_marker', version: '1' });
    expect(JSON.stringify(catalog)).toBe(original);
    expect(parseLiveComment('49 m xanh x3', catalog).quantity).toBe(3);
  });
  it('requires exact remaining attributes and supports registered multiword colors', () => {
    expect(parseLiveComment('1024 xanh đậm 29 2 cái', catalog)).toMatchObject({ status: 'unique', product_id: 'p3', quantity: 2 });
    expect(parseLiveComment('49 xanh xl 2c', catalog)).toMatchObject({ status: 'no_match', product_id: null, reason: 'UNKNOWN_ATTRIBUTES' });
    expect(parseLiveComment('49 xanh m cho tôi', catalog).status).toBe('no_match');
    expect(parseLiveComment('49 blue m', catalog).status).toBe('no_match');
  });
  it('preserves exact numeric SKUs and registered suffix-like aliases before extracting quantity', () => {
    expect(parseLiveComment('1024', catalog)).toMatchObject({ product_id: 'p3', quantity: 1, quantity_source: 'default' });
    expect(parseLiveComment('1024 29', catalog)).toMatchObject({ product_id: 'p3', quantity: 1 });
    const custom = { ...catalog, aliases: [...catalog.aliases, { alias_text: '49 2c', product_id: 'p2', active: true }] };
    expect(parseLiveComment('49 2c', custom)).toMatchObject({ product_id: 'p2', quantity: 1 });
  });
  it('uses the longest exact prefix and never falls back to a shorter alias after unknown text', () => {
    expect(parseLiveComment('quần xanh đậm 2c', catalog)).toMatchObject({ product_id: 'p3', quantity: 2 });
    expect(parseLiveComment('quần xanh đậm đỏ 2c', catalog).status).toBe('no_match');
    expect(parseLiveComment('quần xannh', catalog).status).toBe('no_match');
  });
  it('returns every distinct matching SKU; duplicated same-SKU aliases do not duplicate candidates', () => {
    const parsed = parseLiveComment('q49', catalog);
    expect(parsed.status).toBe('ambiguous');
    expect(parsed.product_id).toBeNull();
    expect(parsed.candidates.map((row) => row.product_id)).toEqual(['p1', 'p2']);
    const collision = { ...catalog, aliases: [...catalog.aliases,
      { product_id: 'p2', alias_text: 'JEAN-XANH-M', active: true },
      { product_id: 'p1', alias_text: 'JEAN-XANH-M', active: true }] };
    expect(parseLiveComment('JEAN-XANH-M', collision).status).toBe('ambiguous');
    expect(parseLiveComment('q49 xanh m', catalog).product_id).toBe('p1');
  });
  it('keeps provisional, absent and unreviewed variants pending and ignores inactive aliases', () => {
    expect(parseLiveComment('TẠM', catalog)).toMatchObject({ status: 'needs_review', product_id: null });
    expect(parseLiveComment('JEAN-XANH-M', { ...catalog, variants: [] }).status).toBe('needs_review');
    expect(parseLiveComment('HẾT', catalog).status).toBe('no_match');
    expect(parseLiveComment('49', catalog).status).toBe('ambiguous');
  });
  it.each(['0c', '-1c', '1.5c', '1001c', 'Infinityc', 'NaNc', '1e3c', 'x0', 'x1001'])(
    'rejects invalid quantity %s without assigning a product', (suffix) => {
      expect(parseLiveComment(`49 xanh m ${suffix}`, catalog)).toMatchObject({ status: 'no_match', product_id: null, quantity: null, reason: 'INVALID_QUANTITY' });
    },
  );
  it('accepts quantity boundaries and explicit final integers', () => {
    expect(parseLiveComment('49 xanh m 1000c', catalog).quantity).toBe(1000);
    expect(parseLiveComment('49 xanh m 2', catalog).quantity).toBe(2);
    expect(parseLiveComment('49 xanh m', catalog).quantity_source).toBe('default');
  });
  it.each([null, undefined, NaN, Infinity, {}, '', '\u0000', 'x'.repeat(2001)])('rejects malformed text %j', (text) => {
    expect(parseLiveComment(text, catalog)).toMatchObject({ status: 'no_match', product_id: null, reason: 'INVALID_TEXT' });
  });
});
