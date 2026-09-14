# Hợp đồng database V1

> Cập nhật V1.1 ngày 11/09/2026: schema nền bên dưới giữ nguyên. Chạy thêm [002_operations.sql](../supabase/migrations/002_operations.sql), không chạy lại 001. V1.1 bổ sung RPC và index, không sửa chứng từ/số dư hiện có. UI đã có bộ chọn workspace và quản lý thành viên.

## RPC bổ sung V1.1

| Hàm | Tham số | Quyền và kết quả |
|---|---|---|
| `list_workspace_members` | `p_workspace_id uuid` | Owner; trả user_id, role, email_hint đã che một phần, is_self |
| `add_workspace_member` | `p_workspace_id`, `p_email`, `p_role` mặc định viewer | Owner; email chính xác đã xác nhận, không gửi thư; không tự đổi role thành viên đã có |
| `set_workspace_member_role` | `p_workspace_id`, `p_user_id`, `p_role` | Owner; chặn mất owner cuối cùng, audit role cũ/mới |
| `remove_workspace_member` | `p_workspace_id`, `p_user_id` | Owner; chặn tự xóa, chặn mất owner cuối cùng, audit |
| `get_workspace_report` | `p_workspace_id`, `p_from date`, `p_to date` | Mọi thành viên; cùng snapshot cho overview, cash_accounts, cash_categories, stock_by_sku, warnings |

Các lệnh thành viên khóa workspace và kiểm lại quyền. Helper đặc quyền không cấp execute trực tiếp cho client. Report là hàm STABLE với search_path rỗng; số tiền và tổng số lượng trả chuỗi nguyên chính xác, frontend dùng BigInt để trình bày. Số dư chưa xác nhận/ngày mở sau kỳ trả null, không biến thành 0 đã đối chiếu. Đầu kỳ + số dư mở trong kỳ + phát sinh ròng = cuối kỳ; không lọc mất phát sinh gốc chỉ vì chứng từ đã đảo ở kỳ sau.

V1.1 chưa thêm quyền riêng theo phân hệ hoặc sổ cái kép. Kết quả 41 kiểm thử PostgreSQL V1.1 xem [VERIFICATION](VERIFICATION.md).

Nguồn có thẩm quyền: [001_core.sql](../supabase/migrations/001_core.sql). Chạy một lần trong project Supabase mới. Mọi bảng nghiệp vụ có UUID, workspace và thời điểm tạo; membership dùng khóa ghép. Schema `app_private` giữ helper và request chống trùng.

## Bảng thực tế

| Bảng `public` | Nội dung và khóa quan trọng |
|---|---|
| `workspaces` | id, name, created_by, created_at |
| `workspace_members` | workspace_id + user_id duy nhất, role owner/manager/staff/viewer |
| `suppliers` | code duy nhất trong workspace, name, note |
| `products` | code, name, supplier_id, unit_cost, provisional, note |
| `warehouses` | code, name, note |
| `cash_accounts` | code, name, opening_balance, opening_date, opening_confirmed |
| `purchase_receipts` | Một SKU/dòng: supplier_id, product_id, warehouse_id, received_date, date_estimated, qty, unit_cost, additional_cost, total_amount generated, status |
| `cash_transactions` | account_id, direction in/out, transaction_date, date_estimated, category, amount, description, status |
| `stock_movements` | purchase_id, product_id, warehouse_id, received_date, movement_kind post/reversal, qty và amount có dấu |
| `cash_movements` | cash_id, account_id, transaction_date, movement_kind, direction, amount dương, signed_amount generated, category |
| `audit_events` | actor_id, action, entity_id, details JSONB, created_at |
| `import_batches` | source_id SHA-256 duy nhất/workspace, source_name, stats JSONB, created_by |

Hai bảng chứng từ có thêm `legacy_id`, `source_id`, `import_row_hash`, `provenance`, `notes`, người tạo và thời điểm cập nhật. Legacy ID duy nhất trong từng loại chứng từ/workspace. Khoá ngoại của các tham chiếu nghiệp vụ ghép với workspace ID để chặn tham chiếu chéo.

Tiền VND dùng bigint; giá trị đầu vào từ 0 hoặc 1 tùy trường, tối đa 9e12. Số dư đầu cho phép âm trong giới hạn; số lượng nhập 1–1.000.000. Ngày thiếu được giữ null ở draft, nhưng post bắt buộc hợp lệ và không ước tính. Số dư đầu mặc định 0 **kèm opening_confirmed=false**, nên không được hiển thị như đã đối chiếu.

## RPC frontend đang gọi

| Hàm | Tham số | Vai trò | Kết quả |
|---|---|---|---|
| `bootstrap_workspace` | `p_name text` | Người đã đăng nhập | `{id}`; reuse workspace owner khi gọi lại |
| `save_master` | `p_kind text`, `p_payload jsonb` | owner/manager; tài khoản tiền chỉ owner | Dòng danh mục |
| `create_purchase` | `p_payload jsonb` | owner/manager/staff | Dòng phiếu nháp; có id thì sửa draft |
| `create_cash` | `p_payload jsonb` | owner/manager/staff | Dòng thu chi nháp; có id thì sửa draft |
| `post_purchase` | `p_id uuid`, `p_request_id uuid` | owner/manager | Dòng phiếu sau ghi; replay không thêm ledger |
| `post_cash` | `p_id uuid`, `p_request_id uuid` | owner/manager | Dòng thu chi sau ghi |
| `reverse_document` | `p_kind`, `p_id`, `p_request_id`, `p_date date`, `p_reason text` | owner | Giữ nguồn, thêm phát sinh ngược |
| `import_legacy` | `p_payload jsonb` | owner | inserted_purchases, inserted_cash, skipped, conflicts, already_imported nếu replay |

`p_payload` cho save/create/import phải chứa `workspace_id`. Client gửi UUID workspace nhưng server luôn kiểm membership, không tin client. `p_kind` của master là `products`, `suppliers`, `warehouses`, `cash_accounts`; của post/reverse là `purchase` hoặc `cash`.

Ví dụ lưu phiếu (UUID dưới đây là placeholder, lấy từ chính workspace):

```javascript
await supabase.rpc('create_purchase', {
  p_payload: {
    workspace_id: workspaceId,
    supplier_id: supplierId,
    product_id: productId,
    warehouse_id: warehouseId,
    received_date: '2026-08-18',
    date_estimated: false,
    qty: 3,
    unit_cost: 85000,
    additional_cost: 5000,
    notes: 'Căn cứ phiếu nhận hàng đã đối chiếu'
  }
});
```

`total_amount`, `status`, `created_by` do server quyết định; không cho frontend ép posted. Khi sửa draft đã import, giữ dấu vết nguồn. Các RPC không phải nơi upload tệp hoặc tự gửi mail.

## Trạng thái và bảo vệ

`draft → posted → reversed`. Đảo không trở về draft; lập chứng từ mới để sửa nghiệp vụ. Đã reversed không được post lại. Ledger có unique `(workspace_id, source_document_id, movement_kind)` nên một gốc và một đảo tối đa trong V1. Chủ shop không sửa trực tiếp sổ bằng REST.

Post khóa dòng chứng từ trước khi thay đổi. `app_private.posting_requests` lưu workspace/request/action/entity; reuse một request cho entity/action khác bị từ chối. Idempotency của thao tác tạo nháp mới chưa có request key riêng: sau lỗi mạng, tải danh sách kiểm tra trước khi tạo lại; đây là việc cứng hóa tiếp theo trước vận hành tải cao.

Các bảng public chỉ được cấp SELECT cho authenticated với RLS. Anonymous không được đọc dữ liệu ERP; RPC không cấp execute cho anon. Helper membership được gọi bởi policy; helper ghi/kiểm tra còn lại không mở cho client gọi riêng. Database admin/service role là lớp đặc quyền hạ tầng, không đại diện cho vai trò owner trong ERP và không dùng ở browser.

## Dữ liệu import

```javascript
{
  source_id: '64 ký tự hex SHA-256',
  source_name: 'Tên file nguồn',
  suppliers: [{ code: 'NCC-01', name: 'Tên NCC' }],
  products: [{ code: 'SKU-01', name: 'Tên sản phẩm', supplier_code: 'NCC-01', unit_cost: 85000 }],
  purchases: [{ legacy_id: 'POL-001', supplier_code: 'NCC-01', product_code: 'SKU-01',
    qty: 3, unit_cost: 85000, additional_cost: 0, received_date: '2026-08-18',
    date_estimated: true, source_status: 'Có', provenance: { sheet: 'PURCHASE_ORDERS', row: 10 } }],
  cash: [{ legacy_id: 'CASH-001', direction: 'out', amount: 125000, category: 'packaging',
    account_code: null, transaction_date: null, date_estimated: false, description: 'Bao bì' }]
}
```

Đây là mẫu cấu trúc, không phải file import có hash hợp lệ. Mỗi mảng tối đa 5.000 dòng, UI giới hạn file 10 MB. Product nguồn mới luôn provisional, chứng từ luôn draft. SHA-256 nhận diện file; row fingerprint nhận diện thay đổi nội dung, không phải chữ ký điện tử/bằng chứng chống sửa file. SQL dùng MD5 cho fingerprint nội bộ, không dùng làm cơ chế bảo mật. Bản demo dùng cách so sánh khác nên không chuyển bản backup demo thẳng vào cloud.

Đổi hash file không bỏ qua unique legacy ID. Changed row được trả conflict và giữ nguyên dữ liệu trước; V1 hiển thị mã/lý do, chưa có màn hình merge giá trị từng ô. Tham chiếu không rõ để null và chặn post. Code nguồn/master nên dùng thống nhất chữ hoa, script cung cấp đã chuẩn hóa.

## Cấp thành viên khi chưa có UI mời

Chỉ quản trị project thực hiện trong SQL Editor sau khi người dùng đã đăng ký Auth và đã được chủ shop đồng ý cấp quyền. Lấy đúng user UUID ở Authentication → Users và workspace UUID ở bảng `workspaces`. Kiểm tra read-only hai dòng này trước; không chọn nhầm project hay email trùng tài khoản cũ.

```sql
-- Thay hai UUID bên dưới bằng giá trị đã kiểm tra; mặc định quyền tối thiểu viewer.
insert into public.workspace_members (workspace_id, user_id, role)
values ('UUID_WORKSPACE_DA_KIEM_TRA', 'UUID_USER_DA_KIEM_TRA', 'viewer');
```

Các placeholder không chạy được cho tới khi thay bằng UUID thật. Đoạn SQL trực tiếp trên chỉ là phương án quản trị V1, không đi qua audit ứng dụng. Trong V1.1, ưu tiên màn hình **Thiết lập → Thành viên và quyền** cùng RPC có audit, và chọn đúng workspace bằng bộ chọn đã bổ sung. Dùng owner/manager/staff chỉ khi phạm vi công việc cần.

## Giới hạn và kiểm tra

V1 không có bảng đơn bán, invoice/AP/AR, kế toán kép, kỳ đóng, kho xuất, outbox hay storage bucket. [Sơ đồ V1](data-model-v1.mmd) khớp migration; [mô hình đích](data-model.mmd) dành cho lộ trình.

`npm run test:db` và `npm run test:operations` chạy SQL thực trên PostgreSQL PGlite với auth.users/auth.uid mô phỏng. Kiểm vai trò, RLS, FK, replay, import conflict, ledger đảo, team và report. Trước dùng cloud thật phải kiểm lại Supabase Auth/JWT, REST grants và RPC cùng phiên đăng nhập thực, email và nhiều kết nối. Các danh sách/dashboard vẫn đọc phân trang; trang Báo cáo cloud V1.1 đã aggregate trên server theo một snapshot.
