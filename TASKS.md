# Các bước đã thực hiện và bước tiếp theo

Cập nhật **11/09/2026**. Đây là nhật ký trạng thái thực tế của project; không coi kiểm thử mô phỏng là đã nghiệm thu Supabase thật.

## Đã thực hiện

- [x] Tạo project JavaScript/React tại đúng thư mục yêu cầu; có Node LTS riêng, launcher, build và lockfile.
- [x] Xây danh mục, nhập hàng, thu chi, ghi sổ, đảo, import đối chiếu, sổ phát sinh và nhật ký.
- [x] Thiết kế kiến trúc ERP đầy đủ, sơ đồ, hướng dẫn sử dụng và prompt phát triển.
- [x] Người dùng đã thực hiện Supabase setup bước 1–6.
- [x] Đọc cấu hình trên máy; giữ nguyên URL/publishable key, chuyển `VITE_DEMO_MODE=false`.
- [x] Kiểm tra cloud chỉ đọc: Auth phản hồi, ba bảng nền tồn tại, anonymous bị chặn đọc.
- [x] Đồng bộ địa chỉ ứng dụng với `http://localhost:2000` theo cấu hình người dùng chọn.
- [x] Thêm selector nhiều workspace; xử lý dữ liệu trả về muộn sau đổi workspace/đăng xuất.
- [x] Thêm UI và RPC quản lý thành viên đã đăng ký/xác nhận email; kiểm owner và bảo vệ chủ shop cuối cùng.
- [x] Thêm báo cáo cloud trong cùng snapshot PostgreSQL, tiền lớn chính xác bằng chuỗi/BigInt, đối chiếu số dư và đảo theo kỳ.
- [x] Thêm migration `002_operations.sql`, chạy và kiểm thử trên PostgreSQL cục bộ, bảo toàn dữ liệu V1.
- [x] Kiểm tra browser với cloud API mô phỏng, tách khỏi Supabase thật và máy chủ người dùng.
- [x] Chặn mất dòng Excel thiếu mã; chặn công thức ở input; giữ cờ ngày ước tính và dấu vết trong CSV.
- [x] Xuất lại dữ liệu 11/09: 17 nhập hàng, 1.566 sản phẩm, 79.043.000 đ tiền hàng, 12 thu chi; SHA-256 nguồn vẫn khớp bản 10/09.

## Việc cần làm trong tài khoản Supabase của bạn

1. **Chạy [002_operations.sql](supabase/migrations/002_operations.sql)** trong SQL Editor của project hiện có. Không chạy lại `001_core.sql`. Kiểm tra chỉ đọc hiện chưa tìm thấy RPC của bản nâng cấp.
2. Mở **START_CHIDI.cmd**, vào **http://localhost:2000**, đăng ký/xác nhận email rồi đăng nhập. Nếu đã có tài khoản thì dùng tài khoản đó. Không gửi mật khẩu qua chat.
3. Tạo/chọn workspace ChiDi; nhập file **`data/chidi-import-2026-09-11-validated.json`** qua màn hình Đối chiếu dữ liệu. Mọi dòng vẫn nháp.
4. Xác nhận SKU, ngày và số dư đầu bằng chứng từ thật; thử ghi/đảo bằng dữ liệu kiểm thử trước khi chọn dữ liệu chính.
5. Làm kiểm tra cloud hai tài khoản và khôi phục backup theo [hướng dẫn V1.1](docs/THIET_LAP_VAN_HANH_V11.md).

Tôi chỉ có publishable key của frontend, không có phiên quản trị database. Vì vậy không thể chạy migration DDL thay bạn bằng key này. File nâng cấp đã được làm thành kết quả cụ thể, có kiểm thử và hướng dẫn để bạn chạy trong SQL Editor; không cần cung cấp secret key.

## Những phân hệ ERP còn trong lộ trình

| Phần | Tình trạng |
|---|---|
| Vận hành nhóm, báo cáo server | Mã V1.1 đã có; migration cloud và nghiệm thu phiên thật còn chờ |
| Bán hàng / giữ tồn / xuất / hoàn | Chưa triển khai |
| FIFO giá vốn bán | Chưa triển khai |
| Đối soát COD theo vận đơn / tích hợp vận chuyển | Chưa triển khai |
| Hóa đơn, AP/AR, sổ cái kép, khóa kỳ | Chưa triển khai |
| Backup tự động, khôi phục diễn tập, public hosting | Chưa thực hiện |
| CRM/livestream, lương, tài sản | Có kiến trúc và prompt, chưa có phân hệ chạy |

Chi tiết kết quả: [VERIFICATION.md](docs/VERIFICATION.md). Nhật ký phiên bản: [CHANGELOG.md](docs/CHANGELOG.md). Không dùng V1.1 như một hệ thống kế toán/ERP doanh nghiệp đã hoàn chỉnh mọi phân hệ.
