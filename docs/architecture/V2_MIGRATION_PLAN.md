# V2 — kế hoạch tiếp tục theo action

Cập nhật 15/09/2026. **Action đầu tiên chưa hoàn tất: A1 — Establish real V2 baseline (BLOCKED).**

File kế hoạch này chưa tồn tại lúc bắt đầu phiên. Thứ tự dưới đây được khôi phục từ [CODEX_PHASE_A_STABILIZE_VERIFY_V2.md](../CODEX_PHASE_A_STABILIZE_VERIFY_V2.md); không suy đoán rằng các action đã chạy xong. Mã V2 hiện có được giữ nguyên.

## Phụ thuộc trước khi thực hiện A1

| Phụ thuộc cho kiểm tra A1 | Trạng thái | Bằng chứng |
|---|---|---|
| Có repository hiện tại và chỉ dẫn Phase A | PASS | App/repository/sales code, AGENTS_CHIDI_V2.md, Phase A prompt |
| Có migration 001/002/003 nguyên trạng để kiểm tra | PASS | SHA-256 được ghi trong baseline; git diff lịch sử trống |
| Có runtime kiểm tra cô lập | PASS | Node 24.21.0, npm 11.19.0, PGlite/Playwright đã cài |
| Có quyền làm kiểm tra đọc và ghi tài liệu local | PASS | Yêu cầu hiện tại; không cần DDL cloud |

Những phụ thuộc này cho phép kiểm tra A1. **Không đồng nghĩa A1 đã PASS.** Xác minh cloud/schema là kết quả cần thu thập của A1, không được điền PASS từ lời mô tả trong target.

## A1 — phạm vi duy nhất đang thực hiện

| Việc A1 | Trạng thái | Kết quả / còn thiếu |
|---|---|---|
| Khôi phục bốn tài liệu persistent từ mã và kiểm tra | PASS | current state, gap, plan, baseline verification |
| Xác định app/package/schema local | PASS | App V2.0, package 1.1.0, có 003 |
| Clean install 001→002→003 | PASS local | PGlite, không có dữ liệu business trước 003 |
| Upgrade 003 từ hai phiếu nhập đã ghi | FAIL | SQLSTATE 55006; pending trigger events khi bật RLS inventory_lots |
| RLS/khách hàng/actor/đọc chéo workspace local | PASS giới hạn | Diagnostic A1; chưa bao phủ toàn bộ bán hàng |
| Chạy regression hiện có một lượt | Xem baseline | Không dùng regression V1.1 làm chứng nhận đầy đủ V2 |
| Xác nhận V2 objects có trên API cloud | PASS giới hạn | 6 bảng + get_sales_state trả 401/42501 với anonymous |
| Công cụ nhận và so metadata SQL Editor | PASS local | Một ô JSON; comparator 7/7; phát hiện grant theo cột và RPC search_path sai |
| Đối chiếu schema/RPC/grants/policy cloud với local | BLOCKED | Chưa có metadata SQL Editor của project thực |
| Xác minh đọc/phân quyền bằng phiên đăng nhập thực | BLOCKED | Chưa có bằng chứng hai workspace bằng phiên người dùng |

### Bước tiếp theo trong A1

Người dùng đã xác nhận chạy [verify_v2_baseline.sql](../../supabase/verification/verify_v2_baseline.sql), nhưng chưa cung cấp kết quả. Bản hiện tại trả **một ô JSON `v2_baseline`**, gồm tables/routines/policies/columns/constraints, để tránh mất result set trong SQL Editor. Đây là script `READ ONLY`, không phải migration và không đọc dòng bán hàng. Không chạy lại 001/002/003 để kiểm tra chúng có tồn tại hay không.

Sau khi có JSON thực, lưu tại `.tools/a1/cloud-v2-baseline.json` rồi chạy `node scripts/compare-v2-baseline.mjs .tools/a1/cloud-v2-baseline.json`. Baseline local do `node scripts/audit-v2-baseline.mjs` tạo tại `.tools/a1/v2-baseline.json`, không bị E2E xóa. Công cụ chỉ đọc file; không cần database URL hoặc token.

Kết quả mong đợi: đủ 8 bảng; 6 bảng public RLS bật; anonymous không có quyền; authenticated chỉ SELECT public tables và không có grant ghi theo cột; đủ 6 RPC public và 4 hàm private; RPC public có SECURITY DEFINER/search_path rỗng; private không cho client EXECUTE. So cả tên/thứ tự argument, kiểu trả về, volatility, policy, columns, constraints và function body hash. Metadata dùng `search_path=pg_catalog`; hash thân hàm chuẩn hóa CRLF→LF, không sửa chữ/SQL literal. Tên constraint tự sinh và thứ tự result row không quyết định khác biệt; nội dung, cờ và số lượng constraint vẫn được so.

**PASS comparator chỉ áp dụng cho phạm vi đã lấy metadata**, không xác nhận mọi hàm helper/overload, phiên đăng nhập hoặc toàn bộ deployment. Khác major PostgreSQL có cảnh báo riêng; khác metadata vẫn BLOCKED, không tự bỏ qua. A1 tiếp tục BLOCKED dù metadata sau này khớp nếu lỗi upgrade hoặc bằng chứng runtime chưa được xử lý.

Sau đối chiếu metadata, xác minh `get_sales_state` bằng phiên đã đăng nhập trong hai workspace thử sẵn có: thành viên đọc workspace của mình; người ngoài bị từ chối; không đọc/sửa dữ liệu shop khác. Không gửi mật khẩu, JWT hoặc Authorization header vào tài liệu. Chỉ lưu kết quả, thời điểm và nhãn môi trường đã che thông tin riêng.

### Xử lý blocker nâng cấp

Lỗi được tạo lại bằng [audit-v2-baseline.mjs](../../scripts/audit-v2-baseline.mjs), không chỉnh 003. Backfill ở 003 có thể tạo deferred trigger events trước câu ALTER TABLE bật RLS. Database rỗng không chạy nhánh dữ liệu này nên PASS clean install chưa đủ.

Một file 004 chỉ chạy sau 003 **không tự chữa được 003 đang thất bại trước đó**. Cần đối chiếu trạng thái cloud trước để thiết kế đường nâng cấp tương thích mới cho từng trạng thái; nếu cần bootstrap runner riêng phải trình bày và kiểm chứng, không sửa ngầm SQL lịch sử. Chưa tạo/chạy bản sửa ở A1. Cloud đang có objects không chứng minh lỗi upgrade local không tồn tại.

### Điều kiện đóng A1

- Có kết quả schema cloud, phạm vi Auth và quyền được ghi đúng mức bằng chứng.
- Lỗi upgrade đã được giải quyết qua action sửa phù hợp và đường nâng cấp được kiểm chứng; không đổi 001/002/003.
- Kiểm tra baseline liên quan PASS; các giới hạn còn lại được gắn đúng action, không bị đánh dấu hoàn tất.
- Cập nhật [baseline verification](../verification/V2_BASELINE_VERIFICATION.md), rồi mới chọn action kế tiếp.

### Tác động và rollback của thay đổi A1

- Thay đổi: tài liệu, diagnostic Node chạy DB tạm, SQL xuất metadata JSON, comparator/test chỉ đọc file.
- Migration/schema/backfill/RLS/RPC/UI/integration thay đổi: **không có**.
- Không ghi Supabase, không thay nguồn Excel, cấu hình hoặc dữ liệu localStorage.
- Rollback: bỏ các artifact A1 nếu cần; không có database rollback. Trong diagnostic, transaction 003 thất bại đã rollback và ledger gốc được so sánh giữ nguyên.

## Các action sau — chưa thực hiện

| Thứ tự | Action trong Phase A | Trạng thái | Schema dự kiến |
|---|---|---|---|
| A2 | Đồng nhất event history demo/UI | NOT STARTED | Không dự kiến schema |
| A3 | Chặn ngày tương lai đúng giờ Việt Nam | NOT STARTED | Migration mới; không sửa 001/002/003 |
| A4 | Coverage bán hàng SQL/domain/UI | NOT STARTED | Chỉ thêm schema fix mới nếu test chứng minh cần |
| A5 | Test tồn kho bằng hai kết nối PostgreSQL | NOT STARTED | Không đổi mô hình để thay test |
| A6 | Mở rộng cloud probe dùng lâu dài | NOT STARTED | Không DDL cloud từ probe |
| A7 | Version/docs/portal thống nhất | NOT STARTED | Không schema |
| A8 | Làm rõ sổ nhập và tồn V2 | NOT STARTED | Giữ nguyên nghĩa báo cáo 002 |
| A9 | Audit parity demo/cloud | NOT STARTED | Không giả lập quyền cloud là đã kiểm chứng |
| A10 | Ghi rủi ro snapshot lịch sử | NOT STARTED | Chưa xây identity; không backfill thành sự thật lịch sử |
| A11 | Backup/restore có bằng chứng | NOT STARTED | Restore vào đích thử riêng |

Không triển khai Phase B/C/D/E/F/G trong kế hoạch đang chạy. Đọc [gap analysis](V2_TARGET_GAP_ANALYSIS.md) khi cần bối cảnh; không lặp lại hoặc tự động mở rộng phạm vi action.
