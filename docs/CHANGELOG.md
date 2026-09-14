# Lịch sử thay đổi ChiDi Online ERP

Tài liệu ghi thay đổi theo phiên bản và phân biệt kết quả kiểm tra trên máy với kiểm tra trên Supabase thật. Ngày ghi theo múi giờ vận hành Việt Nam.

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
