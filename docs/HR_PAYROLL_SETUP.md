# Nhân sự & Tiền lương — thiết lập vận hành

Module HR dùng dữ liệu Supabase của workspace. Bản demo trên máy chỉ hiển thị thông báo thiết lập, không lưu hồ sơ hoặc bảng lương giả. Ảnh tham chiếu ở `docs/design/references/chidi-hr-payroll.png`; giao diện giữ khung ChiDi ERP hiện tại và dùng màu xanh/chàm riêng cho HR.

Chấm công QR, lịch làm việc lặp và duyệt tăng ca riêng mở rộng các migration HR `017`–`020`: xem [hướng dẫn QR](HR_QR_ATTENDANCE.md) và [hướng dẫn lịch lặp/tăng ca](HR_RECURRING_SCHEDULES.md). Các migration mới chưa được xác minh trên Supabase thật; không dùng dữ liệu quét làm công chính thức trước khi kiểm tra triển khai.

## Triển khai database

Trước khi mở cho người dùng, sao lưu và rà soát project Supabase đang dùng. Trong SQL Editor, áp dụng **một lần, theo thứ tự** các file mới:

1. `supabase/migrations/017_hr_core.sql` — phòng ban, chức vụ, hồ sơ nhân viên.
2. `supabase/migrations/018_hr_attendance_leave.sql` — ca làm, chấm công, nghỉ phép.
3. `supabase/migrations/019_hr_payroll.sql` — hợp đồng, kỳ lương, tính/duyệt/trả lương, ứng lương và bảo vệ Thu Chi.
4. `supabase/migrations/020_hr_payroll_components.sql` — phụ cấp, thưởng, hoa hồng xác nhận, khấu trừ khác.
5. Sau các migration trung gian theo thứ tự của repository, `supabase/migrations/023_hr_qr_attendance.sql` — cửa hàng chấm công, gán nhân viên, kiosk QR và sự kiện quét.
6. `supabase/migrations/024_hr_recurring_schedules.sql` — mẫu ca, lịch tuần, phân công nhiều nhân viên, đồng bộ ca ngày và điều chỉnh một ngày.
7. `supabase/migrations/025_hr_overtime_approval.sql` — quyết định tăng ca riêng, kiểm tra lịch lặp đủ kỳ và chặn duyệt lương khi quyết định tăng ca lỗi thời.

Các migration `017`–`020` giả định `001`–`016` đã được áp dụng; `023`–`025` cần toàn bộ migration trước nó theo thứ tự hiện có của repository. Không chạy lại `001`–`003`, không tự chạy migration trên production bằng ứng dụng. Sau mỗi file, nếu SQL Editor báo lỗi thì dừng và giữ nguyên thứ tự; không chạy file tiếp theo. Không đưa service-role key vào frontend.

## Thiết lập nghiệp vụ

1. Đăng nhập bằng **owner/manager**, chọn workspace rồi mở **Nhân sự & Tiền lương**.
2. Tạo phòng ban và chức vụ, sau đó tạo hồ sơ nhân viên. Hồ sơ không tự tạo tài khoản đăng nhập. Lưu trữ giữ nguyên lịch sử.
3. Tạo hợp đồng lương theo **tháng hoặc giờ** cho từng nhân viên. Nhập mức lương, phút công chuẩn/ngày, phút chuẩn/kỳ đối với lương tháng, hệ số tăng ca và các loại nghỉ được trả lương. Không có mẫu số 26 ngày mặc định. Có thể ghi đè định mức/hệ số ở một kỳ chưa duyệt.
4. Tạo ca một ngày hoặc dùng **Ca làm việc** để tạo mẫu ca có phút nghỉ không tính công riêng, quy tắc tuần và phân công nhiều nhân viên. Đồng bộ ngày dự kiến trước khi tính kỳ; quét QR hợp lệ cũng tạo ca còn thiếu cho vùng ngày gần hiện tại. Nhập giờ vào/ra, xác nhận chấm công; ca qua đêm dùng ngày giờ đầy đủ. Bản thiếu giờ được giữ ở nháp. Tạo và duyệt đơn nghỉ riêng. Một ngày chưa chấm không được tự coi là vắng.
5. Mở **Duyệt tăng ca**, duyệt số phút trong giới hạn ngoài giờ đã xác nhận hoặc từ chối bằng `0`, luôn nhập lý do. Tăng ca ghi nhận qua QR không tự trở thành tiền lương. Nếu đổi quyết định khi kỳ còn mở, tính lại trước khi duyệt; kỳ `APPROVED`/`PAID` vẫn bất biến.
6. Tạo kỳ lương; khi lập phiếu **Ứng lương**, chọn nhân viên, kỳ và tài khoản chi. Hệ thống ghi sổ Thu Chi ngay và gắn khoản ứng vào đúng kỳ; chỉ chọn được nhân viên có hợp đồng bao trùm kỳ. Phiếu ứng không phải chi phí lương lần hai.
7. Nếu có phụ cấp/thưởng/hoa hồng/khấu trừ khác, thêm khoản vào kỳ trước duyệt, nhập lý do. Hoa hồng cần mã nguồn đã đối chiếu; hệ thống không tự suy đoán hoa hồng từ doanh số. Khoản sai có thể sửa hoặc hủy trước duyệt, có audit và yêu cầu tính lại.
8. Chọn **Tính lương → Kiểm tra → Duyệt**. Phép tính chính thức chạy trên database và chặn thiếu ca lặp hoặc quyết định tăng ca; phiếu lương giữ snapshot ca và phút tăng ca được duyệt. Khi duyệt, chi phí lương gộp được ghi nhận một lần trong `hr_payroll_expenses`. Không sửa trực tiếp kỳ đã duyệt.
9. Chọn tài khoản, ngày và **Ghi sổ trả lương**. Owner/manager ghi phiếu Thu Chi đã post cho từng nhân viên, có request ID chống lặp. Đây là xác nhận nội bộ, **không** gửi lệnh chuyển khoản ngân hàng. Thanh toán và ứng lương không cộng chi phí vận hành thêm lần nữa.

## Quyền, đối soát và giới hạn

- Chỉ owner/manager đọc được hồ sơ, bảng lương và các bảng audit HR. Staff/viewer không đọc trực tiếp dòng Thu Chi liên kết lương; báo cáo cũ che số tiền khi kỳ có dòng HR nhưng vẫn trả dữ liệu kho.
- Dashboard HR và báo cáo HR lấy dữ liệu thật từ RPC. Biểu đồ sáu tháng dùng chi phí lương **đã duyệt**. Báo cáo Thu Chi hiện hữu là **dòng tiền**, không phải P&L pháp định; lương đã duyệt chưa được gộp vào một báo cáo lợi nhuận quản trị toàn công ty vì repository chưa có báo cáo đó.
- Không tự tính thuế TNCN/BHXH, nghỉ không lương, hoa hồng theo doanh số hoặc chuyển khoản thật khi chưa có chính sách và nguồn xác thực. Không đánh dấu phép chưa cấu hình là khoản khấu trừ mặc định.
- `get_hr_payroll_state` giới hạn 24 kỳ gần nhất và 500 hợp đồng để tránh tải lịch sử vô hạn. Phiếu được duyệt giữ nguyên snapshot; tên/phòng ban hiện tại có thể đổi nhưng lịch sử phiếu vẫn dùng ảnh chụp tại thời điểm tính.
- Mẫu ca `024` yêu cầu nhập phút nghỉ **không tính công** riêng; `0` chỉ đúng khi ca thực sự không có phần nghỉ bị trừ. Nghỉ có lương và quy tắc ngày lễ chưa có chính sách/engine tương ứng, nên cần quyết định nghiệp vụ riêng trước khi dùng chúng để trả lương.
- Kiểm thử cục bộ: `npm run test:hr`, `npm run test:e2e -- --grep "HR desktop and mobile"`, `npm run build`; kiểm thử hồi quy rộng `npm run check`. Chúng không chứng minh Supabase production đã cài migration. Cần đăng nhập vào project thật và chạy smoke test với **dữ liệu thử riêng** sau khi triển khai.

Không có migration đảo phá hủy: nếu cần rollback, ngừng thao tác HR, xuất dữ liệu mới tạo, rồi dùng migration bù được review; không xóa bảng lương/chứng từ đã ghi sổ.
