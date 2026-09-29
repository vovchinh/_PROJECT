// Suggestions only. This pure parser never creates a ticket, order or reservation.
export function normalizeLiveText(value) {
  return typeof value === 'string'
    ? value.normalize('NFC').toLowerCase().replace(/[\s\u0085\uFEFF]+/gu, ' ').trim()
    : '';
}

function candidate(product, variants, styles) {
  const rows = variants.filter((row) => row.product_id === product.id);
  const variant = rows.length === 1 ? rows[0] : null;
  const reviewed = product.provisional === false && variant?.mapping_status === 'confirmed'
    && styles.some((style) => style.id === variant.style_id);
  return {
    product_id: product.id,
    variant_id: variant?.id || null,
    code: product.code,
    name: product.name,
    provisional: product.provisional !== false,
    style_id: variant?.style_id || null,
    size: variant?.size || null,
    color: variant?.color || null,
    mapping_status: reviewed ? 'confirmed' : 'needs_review',
  };
}

function attributesMatch(row, remaining) {
  if (!remaining) return true;
  const size = normalizeLiveText(row.size);
  const color = normalizeLiveText(row.color);
  return [size, color, size && color && `${size} ${color}`, size && color && `${color} ${size}`]
    .filter(Boolean).includes(remaining);
}

function suffixQuantity(remaining) {
  // Explicit c/cái/chiếc or x/× markers; a final integer also works unless it
  // already exactly matched a known numeric size in the attribute-first step.
  const marked = /(?:^| )(?:(?:x|×)\s*([^\s]+)|([^\s]+?)\s*(?:c|cái|chiếc))$/u.exec(remaining);
  const bare = /(?:^| )([+-]?(?:\d[\d.,e+-]*|infinity|nan))$/u.exec(remaining);
  const match = marked || bare;
  if (!match) return null;
  const raw = marked ? marked[1] ?? marked[2] : bare[1];
  const quantity = /^\d+$/u.test(raw) ? Number(raw) : NaN;
  return {
    quantity: Number.isSafeInteger(quantity) && quantity >= 1 && quantity <= 1000 ? quantity : null,
    remaining: remaining.slice(0, match.index).trim(),
    source: marked ? 'explicit_marker' : 'explicit_integer',
  };
}

export function parseLiveComment(text, catalog = {}) {
  const normalized = normalizeLiveText(text);
  const result = (status, candidates = [], quantity = 1, quantity_source = 'default', reason = '') => ({
    version: '1', status, product_id: status === 'unique' ? candidates[0].product_id : null,
    candidates, quantity, quantity_source, normalized, reason,
  });
  if (typeof text !== 'string' || !normalized || text.length > 2000
    || /[\u0000-\u0008\u000E-\u001F\u007F]/u.test(text))
    return result('no_match', [], null, 'none', 'INVALID_TEXT');

  const products = Array.isArray(catalog.products) ? catalog.products : [];
  const variants = Array.isArray(catalog.variants) ? catalog.variants : [];
  const aliases = Array.isArray(catalog.aliases) ? catalog.aliases : [];
  const styles = Array.isArray(catalog.styles) ? catalog.styles : [];
  const byId = new Map(products.filter((row) => typeof row?.id === 'string').map((row) => [row.id, row]));
  const entries = [];
  const add = (key, id) => {
    const normalizedKey = normalizeLiveText(key);
    if (normalizedKey && byId.has(id)) entries.push({ key: normalizedKey, id });
  };
  for (const row of byId.values()) add(row.code, row.id);
  for (const row of aliases) if (row?.active === true) add(row.alias_text, row.product_id);
  for (const style of styles)
    for (const variant of variants)
      if (variant.style_id === style.id) add(style.code, variant.product_id);

  const candidatesFor = (matches) => [...new Set(matches.map((entry) => entry.id))]
    .sort().map((id) => candidate(byId.get(id), variants, styles));
  const finish = (rows, quantity = 1, source = 'default') => {
    if (!rows.length) return result('no_match', [], quantity, source, 'UNKNOWN_ATTRIBUTES');
    if (rows.length > 1) return result('ambiguous', rows, quantity, source, 'MULTIPLE_SKUS');
    return result(rows[0].mapping_status === 'confirmed' ? 'unique' : 'needs_review', rows,
      quantity, source, rows[0].mapping_status === 'confirmed' ? 'EXACT_MATCH' : 'UNREVIEWED_VARIANT');
  };

  // Protect numeric SKUs and aliases containing suffix-like text (e.g. "49 2c").
  const whole = entries.filter((entry) => entry.key === normalized);
  if (whole.length) return finish(candidatesFor(whole));
  const prefixes = entries.filter((entry) => normalized.startsWith(`${entry.key} `));
  if (!prefixes.length) return result('no_match', [], 1, 'default', 'UNKNOWN_CODE');
  const longest = Math.max(...prefixes.map((entry) => entry.key.length));
  const matches = prefixes.filter((entry) => entry.key.length === longest);
  const rows = candidatesFor(matches);
  const remaining = normalized.slice(longest).trim();
  const exactAttributes = rows.filter((row) => attributesMatch(row, remaining));
  if (exactAttributes.length) return finish(exactAttributes);

  const quantity = suffixQuantity(remaining);
  if (!quantity) return result('no_match', rows, 1, 'default', 'UNKNOWN_ATTRIBUTES');
  if (quantity.quantity === null) return result('no_match', rows, null, quantity.source, 'INVALID_QUANTITY');
  const filtered = rows.filter((row) => attributesMatch(row, quantity.remaining));
  if (!filtered.length) return result('no_match', rows, quantity.quantity, quantity.source, 'UNKNOWN_ATTRIBUTES');
  return finish(filtered, quantity.quantity, quantity.source);
}
