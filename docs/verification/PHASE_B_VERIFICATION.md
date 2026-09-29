# Nghiệm thu Phase B — Commerce foundation

Ngày 17/09/2026. Phạm vi: 004 catalog, 005 customer/order foundation, 006 inventory reservations và giao diện React dùng các RPC mới. Không chạy migration lên Supabase thật. Fixture database là dữ liệu tổng hợp; không thay Excel, file import riêng, cấu hình Supabase hay dữ liệu shop.

## Kiểm thử chức năng liên quan

| Nhóm | Kết quả | Lệnh / bằng chứng |
|---|---|---|
| SKU/variants/aliases | 40/40 PASS | `npm run test:catalog`; `test-results/catalog-database.json` |
| Khách/identity/address/snapshot/payment plans | 36/36 PASS | `npm run test:customers`; `test-results/customer-foundation.json` |
| Inventory compatibility/reservations | 24/24 PASS | `npm run test:inventory`; `test-results/inventory-foundation.json` |
| UI Phase B | 12/12 PASS với API giả | `tests/cloud/foundation.spec.js`, `foundation-snapshot.spec.js` |

Các bộ liên quan được chạy trước, sau đó chạy lại đúng một vòng hồi quy tổng thể. Các lần chạy lại không được cộng lặp vào tổng kiểm tra dưới đây.

## Bằng chứng chính

- Cài 001→006 trên DB rỗng; nâng cấp từ schema V2 đã cài 003 và có dữ liệu. So ID/rows chứng từ, ledger, allocations, requests/audit trước-sau migration; không đoán lịch sử hoặc thêm movement/cash.
- B1 đối chiếu backfill SKU 1:1; variant ID ổn định, uncertainty rõ, new-SKU trigger, Unicode chuẩn hóa, uniqueness server, alias trùng cùng SKU bị chặn và trùng khác SKU trả ambiguous. Vai trò, workspace FK, RLS, private helper và anonymous đều có kiểm tra.
- 005 xác minh identity thủ công, không tự merge, một địa chỉ mặc định, FK đúng khách/workspace, snapshot bất biến; đơn cũ chưa biết địa chỉ giữ NULL. Kế hoạch tiền sửa/hủy theo quyền, không thay ledger/cash/doanh thu; void lặp không tạo phát sinh mới.
- 006 giữ thủ công cùng allocations cũ; không oversell trong luồng tuần tự; tạo/release/transfer có replay/payload conflict, rollback toàn bộ khi chuyển không khớp, chặn đảo phiếu nhập đang giữ, tương thích snapshot 005, giới hạn dữ liệu rõ ràng.
- FIFO: 5 × 80.000 + 5 × 90.000; chuyển giữ/xuất 7 chưa bị giữ khác → giá vốn 580.000. Khi 3 sản phẩm đầu đã được giữ cho mục đích khác, xuất 7 còn lại → 610.000. Hoàn hàng lấy giá vốn từ allocations gốc.
- Script SQL bàn giao `verify_phase_b.sql` được chạy thật trên fixture: 8 bảng RLS/read-only, 15 RPC có quyền đúng, policy và ba chỉ số đối chiếu bằng 0. Đây là aggregate/metadata verification, không thay thế kiểm quyền phiên Supabase thật.
- UI: original SKU ID/payload nullable, alias mơ hồ không tạo đơn, identity và địa chỉ đúng khách, giữ request UUID khi retry, integer VND không post cash, viewer/staff, mobile 390px, thiếu migration không fallback demo, response cũ không ghi đè workspace mới, snapshot lịch sử trên chi tiết bán.

## Hồi quy cuối

**PASS local: 223 kiểm tra**, build production thành công. Kết quả lệnh đã hoàn tất ngày 17/09/2026:

| Lệnh | Kết quả |
|---|---|
| `npm run check` | 176 kiểm tra PASS = 10 domain + 25 core DB + 41 operations + 40 catalog + 36 customers + 24 inventory; Vite build PASS |
| `node scripts/test-v2-metadata.mjs` | 7/7 PASS (test công cụ so metadata, không phải so dữ liệu cloud thật) |
| `npm run test:e2e` | 5/5 PASS, demo Edge, port 5199 |
| `npm run test:cloud-ui` | 18/18 PASS = 6 Auth/workspace cũ + 12 Phase B mới, API mô phỏng port 5201 |
| `python scripts/test-export.py` | 5/5 PASS, fixture Excel tạm; không sửa nguồn |
| `npm run test:builds` | 5/5 PASS: build cloud/demo, chặn secret/service role, khôi phục build cấu hình hiện tại |
| `node scripts/test-foundation-concurrency.mjs` (`npm run test:concurrency`) | 7/7 PASS trên PostgreSQL 14.3 native, hai client độc lập |

Native concurrency dùng binaries đã cài tại `C:\Program Files\PostgreSQL\14\bin`, tạo cluster tổng hợp riêng dưới `.tools/foundation-concurrency`, chỉ bind `127.0.0.1` và chọn cổng riêng. Không dùng `.env.local`, credentials/cloud hoặc service PostgreSQL đang có. Sáu cặp phiên `psql` độc lập được quan sát cùng chờ `wait_event_type=Lock` trước khi mở khóa barrier, không dùng chạy tuần tự/PGlite làm bằng chứng đồng thời. Kiểm thử gồm:

1. Hai yêu cầu giữ tranh sản phẩm cuối: một thành công.
2. Giữ thủ công cạnh tranh với `transition_sales_order(confirm)` cũ: không giữ vượt tồn.
3. Hai request giống nhau đồng thời: một hold/allocation/audit.
4. Cùng UUID khác payload: từ chối yêu cầu xung đột.
5. Hai đơn dùng cùng lượt giữ: một confirmed/snapshot/allocation.
6. Alias chuẩn hóa trùng cho cùng SKU: chỉ một bản ghi.
7. Toàn bộ kết quả không âm tồn khả dụng, không tạo cash hoặc doanh thu.

Bằng chứng: `test-results/foundation-concurrency.json`, `simultaneous_sessions_tested=true`, 6 cặp chờ khóa, `own_cluster_stopped=true`. Cluster của lần thành công đã dọn. Một thư mục tổng hợp của lần thử khởi chạy ban đầu `.tools/foundation-concurrency/run-jCVNGb` được giữ lại sau khi auto-review chặn lệnh xóa (`blocked by policy`); máy chủ thử đó đã dừng. Không thử xóa bằng cách khác.

Vite vẫn cảnh báo main chunk khoảng **549 kB** (>500 kB); module Phase B được lazy load khoảng 20 kB. Build không lỗi. Không tuyên bố mọi khoản technical debt A7 hoặc lint/format toàn repository đã giải quyết. Playwright demo đổi output directory thành `test-results/demo-ui` để không xóa các báo cáo SQL khi chạy E2E.

Kiểm tra bàn giao tài liệu riêng (không cộng vào 223): **96 liên kết nội bộ hợp lệ**, 13 trang trong portal mở được, không lỗi JavaScript hoặc tràn trang tại 390px. Bằng chứng `test-results/foundation-docs.json`. `check-delivery.mjs` cũng xác nhận bundle không chứa dữ liệu import riêng/secret hoặc placeholder build. Portal `OPEN_DOCUMENTATION.cmd` mở mặc định Phase B; sơ đồ V1 được gắn nhãn lịch sử. README đã bỏ byte NUL do phần đuôi mã hóa cũ, giữ nội dung văn bản.

## Migration và giới hạn nghiệm thu

Lịch sử 001/002/003 giữ nguyên. Mốc SHA-256:

| File | SHA-256 |
|---|---|
| 001_core.sql | `6755f58cb4022be6c681221b35fdfdc0fa1cfc64026882a757800b5c79e0a9cb` |
| 002_operations.sql | `ebecdb235ff9125b40108e52eb903ebb317ad8fe1155484036e5238119103633` |
| 003_sales_inventory.sql | `b3c93e7ba0194a59fc7cc8256d04c20eecc64959863e67a725bf07b731c32aa3` |

Blocker cũ A1 `55006` khi áp dụng 003 lên V1 đã có phiếu nhập **chưa được sửa**; đường Phase B yêu cầu 003 đã hoàn tất. Diagnostic A1 trước đó là 7 PASS/1 FAIL, không cộng FAIL đó thành PASS hoặc lặp chạy chỉ để tăng số test. Comparator baseline A1 vốn so thân hàm nguyên bản 003; sau 006, hai hàm inventory thay đổi có chủ đích nên không dùng comparator đó để kết luận deployment Phase B phải giống 003. Dùng metadata Phase B và hồ sơ migration đã áp dụng, giữ A1 là bằng chứng lịch sử.

Chưa nghiệm thu Auth/PostgREST đăng nhập thật trong hai workspace, backup/restore trên cloud, hosting production hoặc mọi quy tắc ngày thuộc Phase A. Kiểm thử PGlite không chứng minh nhiều phiên chạy đồng thời; bằng chứng native PostgreSQL ở trên chỉ áp dụng cho fixture local và các tình huống đã kiểm. Không phải load test hoặc bảo đảm mọi isolation level/cloud deployment. Các kiểm thử API trình duyệt là mock có chủ đích.

UI Phase B chỉ hỗ trợ cloud, không thêm mô hình demo tương đương. Không có payment posting, customer merge, reservation expiry hoặc partial transfer. Không có tích hợp bên ngoài; chưa có tuyên bố production-ready cho toàn bộ ERP.

## Bàn giao

Chạy theo [hướng dẫn Phase B](../PHASE_B_COMMERCE_FOUNDATION.md), cập nhật [migration plan](../architecture/V2_MIGRATION_PLAN.md) sau khi có bằng chứng cloud. Khôi phục sau phát sinh mới ưu tiên sửa tiến; không hạ RPC tồn xuống phiên bản bỏ qua active holds.

## Danh sách file Phase B

Các file dưới gồm phần triển khai đã nằm trong HEAD `4f4d369` và phần hoàn thiện sau đó; không tự tạo commit mới trong phiên bàn giao:

- `supabase/migrations/004_catalog_variants_aliases.sql`
- `supabase/migrations/005_customer_order_foundation.sql`
- `supabase/migrations/006_inventory_reservations.sql`
- `supabase/verification/verify_phase_b.sql`
- `src/App.jsx`, `src/features/CommerceFoundation.jsx`, `src/features/Sales.jsx`, `src/lib/repository.js`, `src/styles.css`
- `scripts/test-catalog-database.mjs`, `scripts/test-customer-foundation.mjs`, `scripts/test-inventory-foundation.mjs`, `scripts/test-foundation-concurrency.mjs`
- `tests/cloud/foundation.spec.js`, `tests/cloud/foundation-snapshot.spec.js`
- `package.json`, `playwright.config.js`
- `docs/PHASE_B_COMMERCE_FOUNDATION.md`, `docs/verification/PHASE_B_VERIFICATION.md`
- `docs/architecture/V2_CURRENT_STATE.md`, `docs/architecture/V2_TARGET_GAP_ANALYSIS.md`, `docs/architecture/V2_MIGRATION_PLAN.md`
- `README.md`, `TASKS.md`, `docs/CHANGELOG.md`, `docs/USER_GUIDE.md`, `docs/VERIFICATION.md`
- `scripts/build_docs.py`, `docs/index.html`, `docs/architecture.svg`
