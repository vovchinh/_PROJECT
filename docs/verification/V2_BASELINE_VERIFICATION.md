# V2 baseline verification — A1

Ngày kiểm tra: **15/09/2026**, giờ Việt Nam. **Status: BLOCKED.**

Phạm vi phiên: A1 trong [migration plan](../architecture/V2_MIGRATION_PLAN.md). Các phụ thuộc để bắt đầu kiểm tra A1 đã PASS; chưa sửa ứng dụng, schema hoặc triển khai action A2–A11. Bốn file persistent trước đó chưa có trên đĩa, được tạo trong phiên này từ bằng chứng thực tế.

## Kết quả kiểm tra

| Lệnh / phép kiểm tra | Kết quả | Phạm vi và giới hạn |
|---|---|---|
| `node scripts/audit-v2-baseline.mjs` | **7 PASS, 1 FAIL; exit 1** | Diagnostic A1; hai database PGlite tạm, SQL lịch sử nguyên byte |
| `node scripts/test-v2-metadata.mjs` | 7/7 PASS; exit 0 | Parser JSON/comparator; thiếu/thêm objects, đổi policy, grant, RPC hoặc FK bị phát hiện |
| `npm run check` | PASS; exit 0 | Vitest 10/10, SQL 001 25/25, operations 41/41, build |
| `npm run test:e2e` | 5/5 PASS; exit 0 | Browser demo cổng 5199; các flow nền hiện có |
| `npm run test:cloud-ui` | 6/6 PASS; exit 0 | Auth/API fixture cổng 5201; không gọi Supabase thật |
| `npm run test:builds` | 5/5 PASS; exit 0 | Demo/cloud, chặn secret/service-role, khôi phục build cloud cấu hình thật |
| Python local `scripts/test-export.py` | 5/5 PASS; exit 0 | Workbook test tổng hợp; không ghi workbook ChiDi |
| `npm run format:check` | FAIL có sẵn | 5 file V2 chưa đúng Prettier; diagnostic mới được format riêng |
| `npm run check:cloud` | 7 mục PASS giới hạn | Auth, bảng nền, RPC 002; chỉ anonymous/GET |
| Probe GET V2, 15/09 09:24 giờ Việt Nam | 7/7 đối tượng trả 401/42501 | 6 bảng + get_sales_state tồn tại trong API; chưa xác minh Auth/RLS theo phiên thực |
| `git diff --exit-code -- supabase/migrations/001_core.sql supabase/migrations/002_operations.sql supabase/migrations/003_sales_inventory.sql` | PASS; exit 0 | Không sửa migration lịch sử |

**97 kiểm tra trong regression hiện có PASS**, chạy một lượt baseline ngày 15/09. Lượt tiếp tục A1 sau đó chỉ thay công cụ metadata và tài liệu, chạy các test liên quan; không chạy lại toàn bộ app khi code ứng dụng không đổi. Diagnostic A1 là bộ riêng, không cộng lỗi đã biết thành PASS. Bộ regression cũ chưa kiểm vòng đời bán, trả/FIFO của V2; không dùng tổng 97 để gọi V2 đã hoàn chỉnh.

Môi trường: Node `24.21.0`, npm `11.19.0`, React `19.3.0`, Vite `8.2.2`, PGlite `0.5.8`, Playwright `1.63.0`. Dependency tree đã kiểm trong lượt baseline 14/09, không thay package/lockfile. Không có npm script lint; `format:check` kiểm style, không thay lint.

Build cloud hiện tạo chunk chính **545,89 kB**, gzip **156,21 kB**, chunk Sales **22,45 kB**. Cảnh báo main chunk >500 kB còn nguyên; build vẫn PASS. Các file style chưa đạt: `src/App.jsx`, `src/features/Sales.jsx`, `src/lib/repository.js`, `src/lib/sales-demo.js`, `src/styles.css`. Đây là vấn đề trước thay đổi A1; chưa format/refactor code nghiệp vụ trong action này.

## Diagnostic A1 mới

| Kiểm tra | Kết quả |
|---|---|
| 001→002→003 trên database business rỗng | PASS |
| Sáu bảng V2 bật RLS, cấm ghi trực tiếp | PASS |
| Đọc state, khách hàng chéo workspace, actor auth.uid và audit | PASS trên PGlite |
| Script SQL metadata chạy được trong READ ONLY transaction | PASS |
| Export/comparator nhận ra grant UPDATE riêng theo cột và RPC search_path sai | PASS trên database tạm; khôi phục trạng thái ban đầu và đối chiếu khớp |
| Nâng cấp 003 sau hai phiếu nhập đã ghi | **FAIL — 55006** |
| Rollback lỗi nâng cấp giữ nguyên schema V1/ledger nguồn | PASS |
| Bytes 001/002/003 sau kiểm tra giống trước | PASS |

Tình huống lỗi: tạo hai phiếu thật trong database **thử**, mỗi phiếu 5 sản phẩm giá 80.000 và 90.000, ghi sổ bằng RPC V1, rồi chạy nguyên file 003. PostgreSQL báo:

```text
55006: cannot ALTER TABLE "inventory_lots" because it has pending trigger events
```

003 backfill lot trước đoạn ALTER TABLE bật RLS; bảng lot có FK deferred. Lỗi này đã có trước thay đổi A1. Clean install không có dòng backfill nên không phát hiện được. Diagnostic không chèn `SET CONSTRAINTS`, không sửa SQL, không vô hiệu FK/RLS để che lỗi. Sau rollback, hai dòng stock ledger giữ nguyên và public.post_purchase V1 còn tồn tại.

Giới hạn: PGlite dùng PostgreSQL engine nhưng Auth/role được dựng cho test; không phải Supabase thật, không có hai kết nối tranh tồn. Kiểm actor/customer không chứng minh toàn bộ RPC bán an toàn. Coverage bán đầy đủ thuộc A4, concurrency thuộc A5.

## Dấu vết migration nguyên trạng

SHA-256 của **bytes file local**, không phải hash schema cloud:

| File | SHA-256 |
|---|---|
| 001_core.sql | `6755f58cb4022be6c681221b35fdfdc0fa1cfc64026882a757800b5c79e0a9cb` |
| 002_operations.sql | `ebecdb235ff9125b40108e52eb903ebb317ad8fe1155484036e5238119103633` |
| 003_sales_inventory.sql | `b3c93e7ba0194a59fc7cc8256d04c20eecc64959863e67a725bf07b731c32aa3` |

Không tạo migration mới. Không sửa 001/002/003, app, env, dữ liệu cloud hoặc Excel.

## Bằng chứng cloud và phần chưa xác minh

- Người dùng xác nhận đã hoàn tất 002, đăng ký/xác nhận email, đăng nhập và tạo workspace; giữ kết quả đó.
- Lần GET 15/09/2026: `customers`, `sales_orders`, `sales_order_lines`, `sales_events`, `inventory_lots`, `sales_allocations` đều `401 / 42501`; truy vấn dùng `select=id&limit=0`, không lấy dòng dữ liệu.
- GET `get_sales_state` với workspace UUID zero cũng `401 / 42501`; RPC tồn tại trong API và anonymous bị từ chối. Không gọi các RPC ghi để dò sự tồn tại.
- Không xuất URL/key, không dùng secret/service-role, không lấy token phiên trình duyệt và không gửi email.
- **Chưa có**: catalog đầy đủ của database cloud, chữ ký/thân hàm/grants của các RPC ghi, schema drift so với local, kết quả V2 bằng phiên đăng nhập và phân quyền chéo workspace trên cloud.

Vì vậy ghi nhận **V2 objects tồn tại**, không khẳng định “003 bản checksum này đã triển khai nguyên vẹn”. Lỗi upgrade local và việc cloud hiện có V2 objects có thể đồng thời đúng.

## Cách chạy lại kiểm tra A1

PowerShell, không cần mật khẩu hoặc kết nối database:

```powershell
Set-Location -LiteralPath 'D:\ChiDi Manager\ChiDi\_ERP\ChiDi\_Online\_ERP\_Project'
$env:Path = (Join-Path (Get-Location) '.tools\node-v24.21.0-win-x64') + ';' + $env:Path
node scripts/audit-v2-baseline.mjs
```

Exit 1 hiện là báo blocker thật, không phải lỗi launcher. Kết quả chi tiết và metadata local ở `.tools/a1/v2-baseline.json`, có bản sao `test-results/v2-baseline.json`. Bản trong `.tools/a1` được giữ khi Playwright tạo lại thư mục test-results; cả hai thư mục không đưa vào Git.

Người dùng đã trả lời “rồi” khi được hỏi đã chạy SQL hay chưa; ghi nhận **đã chạy theo xác nhận**, chưa có result để đánh giá schema. Bản mới của [verify_v2_baseline.sql](../../supabase/verification/verify_v2_baseline.sql) trả một ô `v2_baseline` gồm đầy đủ năm nhóm metadata. Copy ô JSON hoặc dùng Download JSON của SQL Editor; cả object gốc và dạng `[ { "v2_baseline": ... } ]` đều được công cụ nhận. Script SELECT catalog trong transaction READ ONLY; `SET LOCAL search_path=pg_catalog` chỉ ổn định cách diễn giải metadata trong transaction đó.

Lưu kết quả thực trong `.tools/a1/cloud-v2-baseline.json`, rồi:

```powershell
node scripts/compare-v2-baseline.mjs .tools/a1/cloud-v2-baseline.json
```

Exit 0 = metadata khớp trong phạm vi; exit 1 = khác hoặc file không hợp lệ/chưa có baseline. Công cụ không gọi network, không chạy nội dung SQL, không in nội dung file/giá trị riêng vào log, giới hạn file 2 MB. Các nhóm khác nhau được liệt kê để rà soát. Không dùng bản metadata local làm bằng chứng cloud.

So sánh gồm quyền bảng/quyền theo cột, RLS, tên/thứ tự/default argument RPC, kiểu trả về, volatility/language/security/search_path, hash thân hàm, policy, column và FK/check/unique constraint. Tên constraint tự sinh và thứ tự row/roles/settings được bỏ qua có kiểm soát; thứ tự argument, SQL literal, nội dung/cờ/số lượng constraint được giữ. Khác major PostgreSQL được cảnh báo, không tự miễn các khác biệt metadata. Thân hàm chỉ chuẩn hóa CRLF→LF trước hash.

PASS chỉ giới hạn **8 bảng và 10 hàm được liệt kê**; không bao phủ mọi overload/helper/trigger/index ngoài phạm vi hoặc runtime Auth/RLS. Công cụ luôn trả `full_a1_complete: false`. Đối chiếu với mục A1 trong [kế hoạch](../architecture/V2_MIGRATION_PLAN.md). Không chạy lại 003 để lấy bằng chứng.

Script metadata không kiểm quyền bằng phiên người dùng: tài khoản SQL Editor có quyền quản trị. A1 còn cần phép đọc hợp lệ và phép đọc bị từ chối giữa hai workspace thử bằng phiên đăng nhập riêng, ghi kết quả đã che định danh; không chia sẻ JWT/mật khẩu.

## Điểm dừng và rollback

**A1 còn BLOCKED:** lỗi upgrade local `55006`; chưa đủ bằng chứng schema/quyền V2 cloud. Bước tiếp theo duy nhất được đề xuất: thu thập metadata cloud bằng script đọc, để chọn đúng đường xử lý tương thích. Không triển khai A2, 004 hoặc chức năng target trong phiên này.

Rollback A1 chỉ liên quan tài liệu, script diagnostic/metadata/comparator và bản kết quả local. Không có data migration cần đảo. Không dùng database reset, drop bảng hoặc restore đè dữ liệu mới để vượt lỗi 003.

Tài liệu PostgreSQL mô tả việc kiểm constraint deferred có thể được dời tới cuối transaction; đây là cơ sở kỹ thuật để nghiên cứu sửa lỗi, chưa phải bản sửa đã áp dụng. [PostgreSQL SET CONSTRAINTS](https://www.postgresql.org/docs/current/sql-set-constraints.html).
