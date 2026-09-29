# Lịch sử thay đổi ChiDi Online ERP

## 24/09/2026 — sửa TikTok ID và kết thúc LIVE tự động

- Chẩn đoán lỗi thực tế `TIKTOK_CHANNEL_USED`: không phải regex chặn số, mà 010 khóa đổi username sau mọi yêu cầu CONNECT. 011 cho sửa khi chưa có phiên, hủy yêu cầu/lease cũ trong cùng transaction. Kênh đã có lịch sử giữ nguyên và có nút lưu ID mới.
- Chưa có LIVE: **Vui lòng bật live**. CONNECT tự chạy listener và nhận bình luận, không có bước người khác phê duyệt.
- STREAM_END được tách khỏi lỗi mạng: gửi các bình luận đã nhận còn chờ, giữ queue nếu lỗi, rồi kết thúc phiên và ngắt kết nối bằng RPC idempotent. Callback cũ không được kết thúc phiên mới.
- Lần kết nối mới tách khỏi phiên đã kết thúc, tránh lỗi nguồn ghi đè trạng thái lịch sử. Không thay số STT đã cấp, ticket, giữ tồn, tiền hoặc doanh thu.
- [Migration 011](../supabase/migrations/011_tiktok_live_end.sql), [hướng dẫn](TIKTOK_CHANNEL_SETUP.md), [verification](verification/TIKTOK_CHANNEL_VERIFICATION.md). Không áp dụng SQL lên Supabase thật trong phiên phát triển.

## 23/09/2026 — TikTok ID và kết nối LIVE đơn giản

- Dùng lại hồ sơ kênh theo workspace, chuẩn hóa username, một kênh mặc định; người bán không tạo campaign/session hoặc nhập thông tin listener.
- 010 thêm yêu cầu kết nối có chống trùng, outbox và lease; listener kiểm tra LIVE trước, rồi RPC tạo/reuse campaign theo kênh/ngày Việt Nam và phiên theo room thực tế.
- Ngắt/kết nối lại giữ lịch sử/STT; kết quả và bình luận từ worker cũ bị chặn theo revision/token. Sửa cả đường đổi username qua RPC cũ trong migration mới.
- Giao diện theo hai ảnh mới: TikTok ID + LƯU/SỬA, nhiều kênh, KẾT NỐI LIVE, trạng thái/thống kê và NGẮT; manual/simulator nằm trong chế độ riêng.
- [Hướng dẫn](TIKTOK_CHANNEL_SETUP.md), [kiểm thử](verification/TIKTOK_CHANNEL_VERIFICATION.md). Không có OAuth TikTok, DDL cloud hoặc nghiệm thu kênh/máy in thật trong phiên phát triển.

Tài liệu ghi thay đổi theo phiên bản và phân biệt kết quả kiểm tra trên máy với kiểm tra trên Supabase thật. Ngày ghi theo múi giờ vận hành Việt Nam.

## V2 Phase C — 18–21/09/2026

- 007 thêm account TikTok công khai, campaign/session, normalized comments, ingestion dedupe, claim và publication loại token.
- 008 thêm ticket/cart/STT, CHỐT & IN nguyên tử, live hold dùng tồn chung, VOID, print jobs/attempts và outbox. Không tạo doanh thu hoặc Final Order.
- Màn hình Live · Chốt & In: parser gợi ý, nhận xử lý, giỏ, hàng đợi in, thiết lập TikTok/máy in, realtime/polling, mobile và phân quyền.
- Worker local NDJSON/TikTok, đăng nhập ERP có che mật khẩu; USB qua driver và LAN bridge có token/Origin, spool chống gửi trùng attempt, raster tiếng Việt.
- Hồi quy, native concurrency và metadata/reconciliation; xem [verification](verification/PHASE_C_VERIFICATION.md) và [hướng dẫn](PHASE_C_LIVE_COMMERCE.md).
- 001–006 không sửa. Không chạy DDL Supabase thật hoặc nghiệm thu TikTok/ZYWELL thật trong phiên này; không triển khai Phase D trở đi.

## V2 Phase B — 17/09/2026

- Migration 004: styles, variant tương thích 1:1 với SKU cũ và alias có phát hiện mơ hồ; giữ nguyên IDs và chứng từ.
- Migration 005: định danh/địa chỉ khách thủ công, snapshot bất biến khi xác nhận đơn; kế hoạch tiền planned/void không ghi ledger.
- Migration 006: giữ hàng thủ công cùng lots/FIFO V2, giải phóng/chuyển đủ sang đơn, replay và audit; thay availability của hai RPC trong migration mới.
- React: Nền tảng thương mại gồm năm tab, quyền theo workspace, Sales Detail hiển thị bản chụp/thiếu lịch sử rõ ràng.
- Thêm suite database/UI, script metadata chỉ đọc, hướng dẫn nâng cấp và rollback. Xem [kết quả](verification/PHASE_B_VERIFICATION.md) và [hướng dẫn](PHASE_B_COMMERCE_FOUNDATION.md).
- Không sửa 001/002/003, không chạy DDL cloud, không triển khai phase C trở đi. A1 upgrade 003/55006 và nghiệm thu cloud vẫn được ghi riêng.

## V1.1 — 11/09/2026 — code và kiểm tra trên máy hoàn tất

Người dùng cho biết đã hoàn tất bước 1–6 của thiết lập Supabase; `.env.local` đã có trong project. Kiểm tra chỉ đọc đã kết nối được dịch vụ và thấy các bảng nền. Chưa có bằng chứng hoàn tất đăng nhập/tạo workspace ở bước 7; chưa coi toàn bộ luồng cloud đã nghiệm thu.

### Phạm vi thay đổi lần này

- Bổ sung migration `002_operations.sql` sau `001_core.sql` cho quản lý workspace/thành viên và báo cáo tổng hợp máy chủ. Giữ dữ liệu V1, không chạy lại migration nền.
- Thêm bộ chọn workspace để tài khoản có nhiều membership làm việc trong đúng bộ dữ liệu.
- Thêm quản lý vai trò cho thành viên đã đăng ký bằng email trong cùng Supabase project. Không tự gửi email mời hoặc tạo mật khẩu cho người khác.
- Dùng số liệu tổng hợp phía database cho báo cáo cloud, có kiểm tra workspace và kỳ.
- Đồng bộ địa chỉ chạy ứng dụng với `http://localhost:2000`; giữ máy chủ E2E riêng ở chế độ demo.
- Thêm [hướng dẫn vận hành V1.1](THIET_LAP_VAN_HANH_V11.md), gồm chạy nâng cấp, hoàn tất Auth, làm việc nhóm, đối chiếu dữ liệu và kiểm tra cloud.
- Bảo vệ phản hồi bất đồng bộ khi đổi người dùng/workspace hoặc đăng xuất; demo lỗi không chặn màn hình cloud.
- Chặn bỏ qua dòng Excel thiếu ID nhưng có tiền/số lượng, thống nhất cờ ngày ước tính, thêm căn cứ ngày/nguồn vào CSV và chặn kết quả đọc file cũ thay file vừa chọn.
- Chuyển lại snapshot 11/09, giữ nguyên SHA-256 và tổng nguồn; không ghi workbook.

### Kiểm tra

| Phần | Trạng thái ở thời điểm soạn |
|---|---|
| Mã nguồn và migration V1.1 | Đã hoàn thành đợt nâng cấp; migration 002 đã chạy trên PostgreSQL cục bộ |
| Unit test nghiệp vụ và repository | 10/10 đạt |
| SQL/RLS/RPC và quyền thành viên | V1 25/25; V1.1 41/41 đạt |
| E2E demo | 5/5 đạt |
| E2E bộ chọn workspace, nhóm và báo cáo | 6/6 đạt với Auth/API mô phỏng, không gửi cloud thật |
| Script xuất Excel | 5/5 test dữ liệu tổng hợp đạt |
| Build và kiểm cấu hình frontend | 5/5 đạt; dist cuối dùng cấu hình cloud thật; npm audit báo 0 lỗ hổng |
| Kiểm kết nối cloud chỉ đọc | Cấu hình publishable hợp lệ; dịch vụ Auth trả HTTP 200; đăng ký email bật và yêu cầu xác nhận; có bảng `workspaces`, `purchase_receipts`, `cash_transactions` |
| Chặn truy cập cloud khi chưa đăng nhập | Truy vấn SELECT của anonymous bị từ chối với mã `42501` trong kiểm tra chỉ đọc |
| Chạy migration 002 trên project cloud | Chờ chủ project chạy một lần theo hướng dẫn |
| Supabase Auth, email/redirect, phiên thật | Chưa nghiệm thu |
| Cloud API hai tài khoản/hai workspace | Chưa nghiệm thu |
| Cloud nhiều kết nối và backup/restore | Chưa nghiệm thu |

### Giới hạn giữ nguyên

Đây là nền ERP cho danh mục, nhập hàng, thu chi, dữ liệu chờ đối chiếu, sổ phát sinh và nhật ký. Chưa công bố hoàn thiện hệ thống bán hàng/COD, công nợ hóa đơn, FIFO bán, kế toán kép, khóa kỳ hoặc P&L đầy đủ. Dữ liệu nguồn nhập vào vẫn thành nháp; ước tính ngày và khoản chi chưa biết tài khoản không tự trở thành dữ liệu đã xác minh.

## V1 — 10/09/2026 — nền React JavaScript + Supabase

### Đã bàn giao

- React JavaScript/JSX + Vite; chế độ demo lưu trên trình duyệt và adapter Supabase tách biệt.
- Danh mục sản phẩm, nhà cung cấp, kho, tài khoản tiền; phiếu nhập hàng và thu chi nháp.
- Ghi sổ qua RPC, chống ghi lặp, khóa sửa chứng từ đã ghi và nghiệp vụ đảo giữ bản gốc.
- Migration `001_core.sql`: workspace, membership, RLS, kiểm tra tham chiếu cùng workspace, sổ phát sinh và nhật ký.
- Chuyển dữ liệu Excel sang JSON có dấu vết nguồn; nhập lại không tạo trùng, thay đổi cùng mã nguồn báo xung đột.
- Tài liệu kiến trúc, prompt phát triển đầy đủ, sơ đồ, hướng dẫn và nguồn nghiên cứu.

### Kết quả ghi nhận ở mốc V1

Ở nền V1 đã chạy 10/10 kiểm thử nghiệp vụ JavaScript, 25/25 kiểm thử database PGlite và 5/5 hành trình trình duyệt. Các kiểm tra build/cấu hình được bổ sung/chạy đầy đủ ở đợt V1.1; kết quả hiện hành xem [VERIFICATION.md](VERIFICATION.md).

Kiểm thử database V1 dùng PostgreSQL PGlite với lớp Auth mô phỏng; E2E dùng demo. Supabase Auth/REST online, email, nhiều kết nối đồng thời và khôi phục cloud chưa được nghiệm thu tại mốc V1.

### Dữ liệu nguồn tại mốc V1

File JSON ngày 10/09/2026 chứa 3 nhà cung cấp, 17 SKU, 17 dòng nhập hàng với 1.566 sản phẩm và 79.043.000 đ tiền hàng, cùng 12 dòng thu chi. Đây là tổng đầu vào từ workbook đang có; không phải kết luận tồn thực tế, lợi nhuận hoặc công nợ đã xác nhận.
