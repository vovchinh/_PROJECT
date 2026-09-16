# V2 — trạng thái thực tế

Cập nhật 15/09/2026, action A1. Nguồn: repository tại commit `2b50410`, SQL đang có và kiểm tra trong [baseline verification](../verification/V2_BASELINE_VERIFICATION.md). **V2 có mã nguồn; baseline chưa PASS.**

Bốn tài liệu persistent được yêu cầu chưa tồn tại khi bắt đầu phiên này. Hồ sơ được tạo từ kiểm tra hiện tại, không được xem là bản kế hoạch cũ đã nghiệm thu. File chỉ dẫn thực tế là [AGENTS_CHIDI_V2.md](../AGENTS_CHIDI_V2.md); không có file `.md.md`. Thứ tự A1–A11 lấy từ [Phase A](../CODEX_PHASE_A_STABILIZE_VERIFY_V2.md).

## Phạm vi đang có

| Phần | Bằng chứng hiện tại | Giới hạn |
|---|---|---|
| React JavaScript / Vite | `src/App.jsx`, `src/main.jsx`, `vite.config.js` | App hiển thị V2.0, package vẫn 1.1.0; ghi nhận cho A7 |
| Dữ liệu demo/cloud | `src/lib/repository.js`, `sales-demo.js` | Demo localStorage riêng; cloud qua RLS/RPC; không đồng bộ ngầm |
| Auth / workspace | `src/lib/useErpSession.js`, migrations 001/002 | Guard phiên và response muộn; owner/manager/staff/viewer |
| Thành viên | `src/features/Operations.jsx`, migration 002 | Owner quản lý tài khoản đã đăng ký/xác nhận email |
| Danh mục / nhập / thu chi | `src/pages.jsx`, `src/forms.jsx`, migration 001 | Phiếu nháp → ghi → đảo; provenance, legacy ID, mở sổ tiền |
| Khách hàng | `customers`, `save_customer`, `Sales.jsx` | Liên hệ cơ bản, chưa có identity đa kênh/địa chỉ lịch sử |
| Đơn bán | `sales_orders`, `sales_order_lines`, `save_sales_order` | Nhiều dòng, lưu giá/giảm giá; chỉ sửa nháp |
| Luồng bán | `transition_sales_order` | Giữ → xuất cả đơn → giao; hủy trước xuất; hoàn bán lại được |
| Tồn/FIFO | `inventory_lots`, `sales_allocations`, `sales_events` | Hàng giữ tách hàng xuất; một vận đơn/đơn; chưa kiểm cạnh tranh hai kết nối |
| Nhật ký | `audit_events`, `sales_events` | Cloud có audit; demo sales chưa đồng nhất với nhật ký chung |
| Báo cáo | `get_workspace_report`, `get_sales_state` | 002 là sổ nhập/tiền; V2 là tồn và số bán quản trị lũy kế; không thay thế nhau |
| Triển khai local | `START_CHIDI.cmd`, `scripts/start.ps1` | `localhost:2000`; build `dist/`, preview `127.0.0.1:4173` |
| Kiểm thử | Vitest, PGlite, Playwright, Python export, build guards | Bộ cũ chưa bao phủ vòng đời bán V2; A1 có diagnostic migration riêng |

Chưa thấy `supabase/functions`, worker/queue/cron, CI/CD hoặc cấu hình nhà cung cấp hosting. Chưa có TikTok, Zalo, CHỐT & IN, ticket/cart, in bill, shipping API hoặc COD settlement. Những phần đó thuộc target, không thuộc action A1.

## Database V2 được khai báo trong 003

- Sáu bảng public: `customers`, `sales_orders`, `sales_order_lines`, `sales_events`, `inventory_lots`, `sales_allocations`.
- Hai bảng private: `app_private.inventory_timeline`, `app_private.sales_requests`.
- Bốn RPC mới: `save_customer(uuid,jsonb)`, `save_sales_order(uuid,jsonb)`, `transition_sales_order(uuid,uuid,text,jsonb,uuid)`, `get_sales_state(uuid)`.
- Giữ chữ ký `post_purchase(uuid,uuid)` và `reverse_document(text,uuid,uuid,date,text)` bằng wrapper; thân V1 chuyển vào `app_private`.
- Các bảng public V2 bật RLS, có `member_read`, authenticated chỉ SELECT trực tiếp. RPC kiểm role; các thao tác kho khóa workspace. Actor lấy từ `auth.uid()`.
- Nguồn nhập cũ backfill thành lot; không thêm lại phiếu thu hoặc doanh thu. Phiếu đã dùng giữ/xuất không được đảo như hàng chưa sử dụng.

Các đặc điểm trên đã đọc trong SQL local. Diagnostic A1 kiểm được clean install, quyền bảng, khách hàng chéo workspace và actor trên PGlite; chưa chứng minh mọi RPC bán trên Supabase thật.

## Trạng thái môi trường và phát hiện A1

1. Người dùng đã xác nhận hoàn thành 002/Auth/workspace. Không yêu cầu làm lại bước đó.
2. Probe cloud GET ngày 15/09 trả `401 / 42501` cho sáu bảng V2 và `get_sales_state`: các đối tượng có trong API và anonymous bị từ chối. Không xác nhận được checksum, toàn bộ schema, policy hoặc hành vi có đăng nhập bằng probe này.
3. Cài 001→002→003 trên database business rỗng PASS. Nâng cấp 003 sau hai phiếu nhập đã ghi FAIL `55006`: không ALTER TABLE `inventory_lots` khi còn pending trigger events. Rollback test giữ nguyên ledger V1.
4. Demo history trả `date`/`payload.reason`, UI đọc `event_date`/`reason`. Quy tắc chặn ngày tương lai đã được viết trong docs nhưng chưa có đủ enforcement. Chỉ ghi nhận; chưa sửa A2/A3.
5. Chưa có snapshot tên/địa chỉ đơn lịch sử; giá/giảm giá dòng đơn đã được lưu. Không backfill thông tin hiện tại rồi gọi đó là sự thật lịch sử.
6. Người dùng xác nhận đã chạy SQL kiểm metadata, chưa có kết quả để đối chiếu. A1 hiện có script xuất một ô JSON và comparator offline; tests comparator 7/7, diagnostic 7 PASS/1 FAIL. Không nâng bằng chứng cloud lên PASS từ xác nhận thao tác.

## Quyết định tiếp tục

Action đang mở: **A1 — BLOCKED**. Dùng [migration plan](V2_MIGRATION_PLAN.md) để tiếp tục đúng điểm dừng. Không sửa 001/002/003, không chuyển sang A2 hoặc phân hệ target khi A1 chưa đủ bằng chứng.
