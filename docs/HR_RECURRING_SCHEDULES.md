# Vận hành lịch làm việc lặp và duyệt tăng ca

Tính năng này tiếp nối module nhân sự hiện có. Migration `024_hr_recurring_schedules.sql` tạo mẫu ca, lịch tuần và phân công; `025_hr_overtime_approval.sql` nối lịch với QR, yêu cầu duyệt tăng ca riêng và bảo vệ bảng lương. Chạy sau `017`–`020` và `023`, theo đúng thứ tự migration của dự án. Các file đã qua kiểm thử PGlite cục bộ; **chưa được áp dụng hoặc xác minh trên Supabase production**.

## Thiết lập cho nhiều nhân viên

1. Trong **Nhân sự → Cửa hàng & QR** (`#/hr/qr`), tạo địa điểm chấm công và gán nhân viên với ngày hiệu lực. Hồ sơ nhân viên có thể thuộc một trong bốn loại hiện có: toàn thời gian, bán thời gian, cộng tác viên hoặc thời vụ. Hồ sơ không cần tài khoản đăng nhập để được phân ca; chỉ người tự quét QR mới cần tài khoản liên kết.
2. Mở **Nhân sự → Ca làm việc** (`#/hr/schedule`) và tạo **Mẫu ca**. Nhập giờ bắt đầu/kết thúc, số phút nghỉ **không tính công**, dung sai đi muộn/về sớm. Nhập rõ `0` nếu ca thật sự không có thời gian nghỉ; hệ thống không mặc định nghỉ 60 phút. Với ca có thời gian nghỉ được trả lương, hiện chưa có mô hình tách riêng; cần chốt chính sách trước khi dùng mẫu đó làm căn cứ trả lương.
3. Tạo **Lịch tuần**, chọn mẫu ca, các thứ làm việc và ngày hiệu lực. Ví dụ chọn T2–T7 thì Chủ nhật là ngày nghỉ của quy tắc. Lịch không tự gán cho cả công ty.
4. Trong **Phân ca**, chọn lịch, cửa hàng, ngày bắt đầu/kết thúc; tìm nhân viên theo tên/mã, lọc phòng ban và loại nhân viên, rồi chọn từng người hoặc từng trang. Tối đa **200 nhân viên cho một lần xác nhận**. Dùng **Xem trước 7 ngày** để phát hiện xung đột, sau đó xác nhận. Server kiểm lại toàn bộ phạm vi; thao tác lỗi không ghi dở dang. Một nhân viên chỉ có một phân công lịch tuần trong cùng khoảng ngày.
5. Khi xác nhận, hệ thống lưu quy tắc và tạo ca ngày cho **45 ngày đầu**. Dùng nút **Đồng bộ ca** theo khoảng tối đa 60 ngày để chuẩn bị các kỳ sau. Khi nhân viên quét QR hợp lệ, server cũng tự tạo ca còn thiếu trong phạm vi hôm qua/hôm nay/ngày mai theo giờ Việt Nam. Việc đồng bộ lặp lại không tạo ca trùng và không ghi đè ca thủ công hay ca đã có chấm công.

Thay đổi quy tắc/mẫu ca đã dùng: kết thúc phân công cũ với lý do rồi tạo phiên bản mới. Chỉ được kết thúc từ ngày hiện tại theo giờ Việt Nam trở đi; việc lùi ngày kết thúc về quá khứ sẽ bị từ chối để không xóa dấu vết ngày công dự kiến. Với một ngày khác lịch, mở **Chấm công → Lịch làm việc → Điều chỉnh ngày**, nhập giờ/phút nghỉ mới và lý do; hệ thống giữ ảnh chụp trước/sau trong audit. Giờ trên form luôn được hiểu theo `Asia/Ho_Chi_Minh`, kể cả khi máy quản lý ở múi giờ khác. Ca đã có chấm công, sự kiện QR hoặc thuộc kỳ lương đã tính/duyệt bị khóa. Không xóa lịch sử để sửa lương đã chốt.

## Duyệt tăng ca và tính lương

1. Nhân viên quét vào/ra hoặc quản lý nhập chấm công, rồi quản lý **xác nhận chấm công**. Số phút ra sau giờ kết thúc ca chỉ là **ngoài giờ ghi nhận**.
2. Mở **Nhân sự → Duyệt tăng ca** (`#/hr/overtime`). Lọc tháng/trạng thái; chọn số phút được tính lương từ `0` đến số phút ghi nhận và nhập lý do ít nhất 10 ký tự. `0` nghĩa là không duyệt. Mỗi quyết định mới giữ lịch sử; nếu kỳ đang CALCULATED/REVIEWED, hệ thống đưa kỳ về DRAFT để tính lại.
3. Trước **Tính lương**, đồng bộ đủ ngày lịch lặp và xác nhận công/ nghỉ theo quy trình hiện có. Server chặn nếu thiếu ca lặp hoặc thiếu quyết định tăng ca. Bảng lương vẫn dùng mức lương, mẫu số và hệ số của **hợp đồng/kỳ từng nhân viên**; không lấy 26 ngày làm mặc định. Phiếu lương giữ snapshot ca và quyết định tăng ca. Kỳ đã APPROVED/PAID không tự thay đổi; thay đổi muộn cần quy trình điều chỉnh kỳ sau.

Số phút nghỉ trong mẫu ca hiện được khấu trừ khỏi `planned_minutes`, và chấm công dùng số phút nghỉ của ca. Tăng ca chỉ được trả theo số phút quản lý duyệt. Phép được duyệt cần đối chiếu với chấm công của ca làm theo hướng dẫn [Nhân sự & Tiền lương](HR_PAYROLL_SETUP.md). Không tự suy diễn ngày lễ, nghỉ có lương, đổi ca hoặc hệ số khác khi chưa có chính sách.

**Giới hạn hiện tại khi mở rộng quy mô:** `get_hr_payroll_state` trong migration `019` từ chối workspace có trên 500 hợp đồng và màn hình bảng lương hiện tải tối đa 500 hồ sơ nhân viên cho tra cứu. Phân ca hàng loạt được giới hạn 200 người/lần; có thể chia nhiều lượt trong cùng workspace. Trước khi dùng cho công ty vượt các ngưỡng này, cần phân trang read model bảng lương và kiểm thử tải trên Supabase staging.

## Lỗi cần xử lý

| Thông báo | Cách xử lý |
| --- | --- |
| `HR_RECURRING_SITE` / `SITE_ASSIGNMENT_MISSING` | Kiểm tra cửa hàng và khoảng hiệu lực gán nhân viên vào cửa hàng. |
| `HR_RECURRING_CONFLICT` | Xem trước ca trùng, ca thủ công hoặc kỳ lương đã khóa; không phân công chồng ngày. |
| `HR_RECURRING_COVERAGE` | Đồng bộ ca của kỳ và kiểm tra ngày thiếu trước khi tính lương. |
| `HR_OT_REVIEW_REQUIRED` | Duyệt riêng mọi tăng ca đã xác nhận trong kỳ. |
| `HR_OT_PAYROLL_STALE` | Tính lại kỳ lương sau khi quyết định tăng ca đổi. |
| `HR_RECURRING_LOCKED` / `HR_OT_PAYROLL_LOCKED` | Không sửa nguồn đã có công hoặc lương đã duyệt; đối soát và xử lý ở kỳ sau. |

## Kiểm tra trước khi bật cho công ty

`npm run test:hr-recurring`, `npm run test:hr-overtime`, `npm run test:hr`, `npm run build` là các lệnh thật trong `package.json`. Kiểm thử PGlite dùng dữ liệu giả và không chứng minh trạng thái cloud. Trên **Supabase staging**, áp dụng `024` rồi `025`, đăng nhập owner/manager và staff riêng, thử phân ca 1/50/200 người, ca qua đêm, sai cửa hàng, QR retry, duyệt/từ chối tăng ca, tính–duyệt lương và đối soát chi phí lương/Thu Chi. Kiểm tra giao diện và camera trên thiết bị thật trước khi đưa vào hoạt động. Không tự chạy migration trên production từ ứng dụng.
