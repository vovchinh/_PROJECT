# Management flows implemented locally

**Catalog:** Danh mục → Nhóm sản phẩm or Sản phẩm / SKU → thêm/sửa. Product rows offer duplicate, archive/restore and a checked-delete dialog. The server returns usage/reason data and rejects deletion when business history exists. Archive keeps old references; a new purchase cannot use an archived SKU.

**Purchase:** Nhập hàng → create/edit draft → post to stock/FIFO → owner may reverse with date/reason if original lot is intact and no hold blocks it. A linked replacement draft flow is planned as E4.

**Cash:** Thu chi → create/edit draft → owner/manager post to cash movements → owner may reverse with date/reason. Dedicated expense-category editing is planned as E3; dated management profit is E7.

The UI is a client of server rules; local demo is separate browser storage and does not attest to cloud migration application.
