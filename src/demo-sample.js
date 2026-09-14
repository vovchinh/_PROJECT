// Fictional tutorial records only. Actual ChiDi data stays in the private data/ folder.
export function sampleImport(date) {
  return {
    source_id: 'd'.repeat(64),
    source_name: 'Bộ hướng dẫn — dữ liệu minh họa, không phải số liệu shop',
    suppliers: [
      { code: 'DEMO-SUP-A', name: 'Nhà cung cấp A · minh họa' },
      { code: 'DEMO-SUP-B', name: 'Nhà cung cấp B · minh họa' },
    ],
    products: [
      {
        code: 'DEMO-JEAN-01',
        name: 'Jean straight · mẫu hướng dẫn',
        supplier_code: 'DEMO-SUP-A',
        unit_cost: 85000,
      },
      {
        code: 'DEMO-SHORT-01',
        name: 'Short denim · mẫu hướng dẫn',
        supplier_code: 'DEMO-SUP-B',
        unit_cost: 60000,
      },
      {
        code: 'DEMO-JEAN-02',
        name: 'Jean wide leg · mẫu hướng dẫn',
        supplier_code: 'DEMO-SUP-A',
        unit_cost: 95000,
      },
    ],
    purchases: [
      {
        legacy_id: 'DEMO-P001',
        supplier_code: 'DEMO-SUP-A',
        product_code: 'DEMO-JEAN-01',
        qty: 20,
        unit_cost: 85000,
        received_date: date,
        date_estimated: true,
        notes: 'Dữ liệu minh họa. Cần xác nhận SKU và ngày trước ghi.',
      },
      {
        legacy_id: 'DEMO-P002',
        supplier_code: 'DEMO-SUP-B',
        product_code: 'DEMO-SHORT-01',
        qty: 15,
        unit_cost: 60000,
        received_date: date,
        date_estimated: false,
        notes: 'Dữ liệu minh họa.',
      },
      {
        legacy_id: 'DEMO-P003',
        supplier_code: 'DEMO-SUP-A',
        product_code: 'DEMO-JEAN-02',
        qty: 12,
        unit_cost: 95000,
        received_date: date,
        date_estimated: true,
        notes: 'Dữ liệu minh họa.',
      },
    ],
    cash: [
      {
        legacy_id: 'DEMO-C001',
        direction: 'out',
        category: 'packaging',
        amount: 180000,
        description: 'Bao bì · minh họa',
        transaction_date: date,
        date_estimated: false,
      },
      {
        legacy_id: 'DEMO-C002',
        direction: 'out',
        category: 'software',
        amount: 300000,
        description: 'Phần mềm · minh họa',
        date_estimated: false,
      },
      {
        legacy_id: 'DEMO-C003',
        direction: 'in',
        category: 'legacy_cod',
        amount: 950000,
        description: 'COD chờ đối soát · minh họa',
        account_code: 'BANK_CHINH',
        date_estimated: false,
      },
    ],
  };
}
