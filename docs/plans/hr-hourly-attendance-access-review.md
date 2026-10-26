# Rà soát công theo giờ và quyền nhân viên (25/10/2026)

Tài liệu này đối chiếu mã nguồn/migration hiện có; **không xác nhận các migration HR đã chạy trên Supabase production**. Không thay đổi công thức trả lương hoặc quyền truy cập chỉ từ hướng dẫn này.

## Hiện trạng đã kiểm chứng

| Chủ đề | Nguồn hiện tại | Ý nghĩa |
| --- | --- | --- |
| Loại nhân viên | `hr_employees.employee_type` trong `017_hr_core.sql`; form `HrEmployees.jsx` | `full_time` / `part_time` là phân loại hồ sơ, không tự chọn cách trả lương. |
| Hợp đồng | `hr_payroll_contracts` và `save_payroll_contract` trong `019_hr_payroll.sql` | `pay_basis=hourly` dùng đơn giá VND/giờ; `monthly` dùng lương tháng với phút chuẩn kỳ được nhập riêng. |
| Ca, công | `hr_work_schedules`, `hr_attendance_facts` trong `018_hr_attendance_leave.sql` | Phút công hiện bằng giờ ra trừ giờ vào trừ số phút nghỉ cố định của ca. Bản nháp chưa vào lương; quản lý xác nhận. |
| Lịch lặp, QR | `023_hr_qr_attendance.sql`, `024_hr_recurring_schedules.sql` | Nhân viên được gán địa điểm và lịch tuần; quét QR dùng giờ server và cần tài khoản Auth liên kết. |
| Tăng ca | `025_hr_overtime_approval.sql` | Phút sau giờ kết thúc ca là ngoài giờ ghi nhận; chỉ số phút được duyệt riêng mới tạo tiền tăng ca. |
| Tính lương | `calculate_payroll` trong `019` và wrapper `025` | Lương giờ cơ bản = làm tròn `đơn giá/giờ × (phút công thường + phút nghỉ được trả lương) / 60`; lương tháng chia theo phút chuẩn kỳ; lương đã duyệt giữ snapshot. |

**Chưa tối ưu đủ để trả lương giờ tự động không cần đối chiếu.** `work_minutes` đang tính cả phút quét vào trước giờ ca, trong khi `overtime_minutes` chỉ tính sau giờ kết thúc. Ví dụ ca 13:00–17:00, nghỉ 0, quét 12:50–17:00 hiện cho **250 phút công thường**, dù ca dự kiến 240 phút. Ngược lại, nếu quét ra trước khi đủ số phút nghỉ cố định, hệ thống từ chối giờ ra. Chưa có lượt quét bắt đầu/kết thúc nghỉ, chính sách nghỉ có lương hoặc ngày lễ. Một nhân viên chỉ có một ca và một bản công cho mỗi ngày công. Quyết định giờ vào sớm nào được trả lương phải được phê duyệt thành chính sách nghiệp vụ trước khi đổi engine bằng migration mới.

`scan_hr_qr` trong `023_hr_qr_attendance.sql` cho tìm ca trong cửa sổ từ 2 giờ trước bắt đầu đến 4 giờ sau kết thúc nhưng không giới hạn riêng hành động **check-in** trước giờ kết thúc. Ca vào quá muộn có thể sinh `overtime_minutes > work_minutes`, rồi bị `calculate_payroll` từ chối. Cần thêm quy tắc từ chối/điều chỉnh quét bất thường tại server trước khi coi đây là luồng lương ổn định.

`calculate_payroll` hiện chặn hợp đồng bắt đầu/kết thúc giữa kỳ (`HR_CONTRACT_SPLIT_PERIOD`); công ty tuyển nhân viên liên tục cần quy trình chia kỳ hoặc cải tiến tính theo hiệu lực hợp đồng. `get_hr_payroll_state` giới hạn 500 hợp đồng mỗi workspace. Các giới hạn này cần xử lý trước khi mở rộng quy mô lớn.

## Cấu hình ví dụ: nhân viên bán thời gian ca chiều

1. Owner/manager mở **Nhân sự → Nhân viên**, tạo hoặc sửa hồ sơ: **Loại nhân viên = Bán thời gian**, **Trạng thái = Đang làm việc**. Trường này chưa quyết định lương theo giờ.
2. Mở **Cửa hàng & QR**, tạo địa điểm thực và gán nhân viên với ngày hiệu lực. Trường chữ “Cửa hàng / nơi làm” trên hồ sơ không thay thế phân công địa điểm.
3. Mở **Ca làm việc**, tạo mẫu ca ví dụ **13:00–17:00**; nhập **phút nghỉ không tính công** theo đúng chính sách của loại ca. Nhập `0` chỉ khi ca thực sự không có giờ nghỉ bị trừ. Tạo lịch tuần với các thứ làm việc và ngày hiệu lực, phân công người này vào địa điểm, xem trước rồi xác nhận. Đồng bộ đủ ca dự kiến cho kỳ lương.
4. Mở **Tiền lương → Hợp đồng**: chọn **Theo giờ**, nhập đơn giá VND/giờ, **phút công chuẩn/ngày** tương ứng chính sách ca (ví dụ 240 cho ca bốn giờ không nghỉ không lương), hệ số tăng ca và loại nghỉ được trả lương đã duyệt. Hợp đồng lương giờ không cần phút chuẩn/tháng. Nếu hiệu lực bắt đầu giữa kỳ đã tạo, phải xử lý giới hạn `HR_CONTRACT_SPLIT_PERIOD` trước khi tính.
5. Quét QR vào/ra theo hướng dẫn hiện có **chỉ cho nhân viên vốn đã được phép dùng ERP như `staff`**. Tài khoản nhân viên chỉ cần chấm công hiện **chưa có vai trò an toàn**; với họ, quản lý dùng chấm công thủ công có đối chiếu đến khi quyền self-service được triển khai. Quản lý kiểm tra giờ vào sớm, thiếu giờ ra và phút nghỉ, xác nhận công, duyệt tăng ca riêng, rồi mới tính và duyệt lương.

## Phạm vi thông tin nhân viên và quyền hiện tại

Khuyến nghị cho cổng **Nhân viên của tôi**: lịch/địa điểm của chính mình; quét QR; giờ vào/ra, phút công dự kiến/thực tế/được duyệt và giải thích chênh lệch; đơn nghỉ của chính mình và trạng thái duyệt; tăng ca của chính mình và quyết định duyệt; phiếu lương **đã duyệt** của chính mình (thu nhập, khấu trừ, thực nhận, kỳ trả). Chỉ cho xem thông tin liên hệ cá nhân cần thiết và có đường yêu cầu sửa sai. Không cho xem hồ sơ/lương người khác.

| Nhóm quyền mục tiêu | Phạm vi hợp lý |
| --- | --- |
| Employee self-service | Dữ liệu HR của **chính mình**; tạo đơn nghỉ/yêu cầu điều chỉnh; không duyệt công/lương. |
| Quản lý cửa hàng/ca | Lịch, công, đơn nghỉ của đội/cửa hàng được giao; duyệt theo phân quyền; không mặc nhiên thấy lương toàn công ty. |
| HR hồ sơ | Hồ sơ/ hợp đồng đúng phạm vi được giao; không tự ghi sổ Thu Chi. |
| Người lập lương / người duyệt lương | Chuẩn bị / rà soát / duyệt theo phân công; ưu tiên tách người lập và người duyệt. |
| Tài chính trả lương | Xem số phải trả và ghi nhận thanh toán được phê duyệt; không sửa công/hợp đồng tùy ý. |
| Bán hàng / kho / kế toán | Chỉ nghiệp vụ và địa điểm được giao; báo cáo/chi phí theo quyền cụ thể. |
| Owner / kiểm toán | Cấu hình quyền, xem dấu vết và báo cáo theo nhiệm vụ; truy cập dữ liệu nhạy cảm được ghi audit. |

**Khoảng hở quyền hiện tại:** `staff` là vai trò vận hành ERP rộng, không phải employee self-service. `001_core.sql` cho mọi thành viên workspace đọc nhiều bảng mua hàng, tồn kho, tài khoản, Thu Chi và audit; `App.jsx` hiển thị nhiều module và cho `staff` lập phiếu nháp. `viewer` cũng đọc rộng và không quét QR. Chính sách HR trong `017`–`019` giới hạn hồ sơ, lương cho owner/manager, nhưng không làm các bảng ERP khác thành riêng tư. Ẩn menu không thay thế RLS/RPC. Hướng dẫn liên kết Auth trong `HR_QR_ATTENDANCE.md` hiện dùng `staff` vì QR RPC chỉ chấp nhận owner/manager/staff; đây là cách hoạt động kỹ thuật hiện tại, **không phù hợp để cấp rộng rãi cho người chỉ cần chấm công**.

`get_my_hr_attendance` đã trả về phút công của đúng `auth.uid()` nhưng `MyAttendancePage.jsx` chưa hiển thị số phút. Nhân viên chưa có màn hình/RPC tự xem phiếu lương hoặc tự nộp đơn nghỉ; chỉ owner/manager dùng quy trình nghỉ phép và bảng lương hiện tại. `owner`/`manager` cũng chưa phân tách người lập, duyệt và trả lương.

## Thứ tự triển khai an toàn

1. Chốt chính sách trả công giờ: phút vào sớm, nghỉ có/không lương, làm tròn, ca qua đêm, ngày lễ, ca thiếu quét, điều chỉnh sau duyệt; chốt ma trận quyền theo vai trò và cửa hàng/đội.
2. Tạo quyền nhân viên tự phục vụ tách khỏi `staff` bằng migration cộng thêm; siết đọc dữ liệu ERP tại RLS và mọi RPC, không chỉ điều hướng React. Thử tài khoản nhân viên chỉ có quyền này và tài khoản ERP `staff` riêng.
3. Thêm RPC chỉ trả lịch/công, đơn nghỉ và phiếu lương đã duyệt của nhân viên gắn với `auth.uid()`; thêm luồng tự tạo/yêu cầu sửa đơn và giao diện mobile. Không cấp SELECT toàn bảng lương cho nhân viên.
4. Sau khi chính sách giờ được phê duyệt, sửa công thức phút công bằng migration mới, thêm kiểm thử vào sớm/ra sớm trước giờ nghỉ, làm tròn và tăng ca. Đảm bảo bảng lương đã duyệt không tự thay đổi.
5. Phân quyền theo cửa hàng/đội và tách trách nhiệm lập–duyệt–trả lương; bổ sung phân trang và thử tải ở quy mô dự kiến trên Supabase staging.

Không có thay đổi dữ liệu, RLS hoặc công thức lương trong đợt rà soát này. Bài kiểm thử PGlite `npm run test:hr` chạy ngày 25/10/2026 dừng tại `test:hr-qr`: fixture ca 23:00 hôm trước đến 23:00 hôm sau phụ thuộc giờ chạy; sau 23:00 Việt Nam, giờ quét thực tế phát sinh ngoài ca và phép tính lương từ chối `HR_ATTENDANCE_MINUTES`. Đây là lỗi fixture cần sửa riêng; nó cũng cho thấy phải đối chiếu phút ngoài giờ trước khi xác nhận công.
