# ChiDi ERP — kế hoạch phân ca lặp theo tuần

> **Phạm vi:** audit và thiết kế, 13/10/2026. Tài liệu này không triển khai lịch lặp, không tạo migration và không xác nhận trạng thái Supabase thật. Các đường dẫn và dòng bên dưới trỏ tới mã hiện có; phần bắt đầu bằng **Đề xuất** chưa tồn tại trong hệ thống. Quy tắc tại [AGENTS.md](../AGENTS.md), migrations và tests của repository được ưu tiên hơn ví dụ nghiệp vụ.

> **Cập nhật triển khai cục bộ, 14/10/2026:** kế hoạch bên dưới là ảnh chụp kiến trúc **trước** khi triển khai, nên các câu “chưa có” trong phần audit không còn mô tả mã mới. Repository hiện có migration additive [`024_hr_recurring_schedules.sql`](../../supabase/migrations/024_hr_recurring_schedules.sql) và [`025_hr_overtime_approval.sql`](../../supabase/migrations/025_hr_overtime_approval.sql), màn hình Ca làm việc/Duyệt tăng ca, ca ngày lặp hữu hạn và kiểm tra tăng ca khi tính/duyệt lương. Xem [hướng dẫn vận hành hiện tại](../HR_RECURRING_SCHEDULES.md) và [kiểm thử cục bộ](../verification/CURRENT.md). Chưa có bằng chứng áp dụng hoặc xác nhận trên Supabase thật; các đề xuất chưa được triển khai vẫn chỉ là đề xuất.

## 1. Executive Summary

ChiDi hiện lưu **một ca theo nhân viên/ngày** trong `hr_work_schedules`. Chấm công thủ công, QR và lương đều cần ca đã lưu; chưa có mẫu ca, quy tắc lặp hoặc phân ca hàng loạt. Đề xuất giữ nguyên ca ngày là đầu vào chính thức của QR/chấm công/lương, bổ sung quy tắc tuần gọn và phân công nhân viên, xem trước theo yêu cầu, rồi đồng bộ **chỉ một chân trời hữu hạn** vào ca ngày bằng RPC idempotent. Không tạo ca cho cả năm, không sửa ca có chấm công hoặc kỳ lương đã duyệt. Cần hoàn tất chính sách nghỉ giữa ca, duyệt tăng ca và giới hạn điều chỉnh lịch trước khi dùng lịch lặp làm nguồn lương chính thức.

## 2. Repository Audit Findings

**Đã xác minh trong repository:** React JS/JSX + Supabase; `package.json` có `test:hr`, `test:hr-qr`, `test:e2e`, `check`, `build`; trang HR dùng hash route và chỉ owner/manager mở workspace HR, còn trang tự chấm công mở cho tài khoản được phép ([`src/App.jsx:48-60,492-506,578-581`](../../src/App.jsx), [`src/features/hr/HRWorkspace.jsx:25-33,69-85`](../../src/features/hr/HRWorkspace.jsx)). Các migration HR là `017`–`020`; `023` bổ sung QR tại repository. [`docs/verification/CURRENT.md:36-47`](../verification/CURRENT.md) ghi rõ `023` mới được thử bằng PGlite và UI fixture, **chưa xác minh trên Supabase thật, tài khoản đăng nhập thật hoặc camera thật**.

| Tính năng | Mức độ trong repository | Tệp/bảng/RPC thực tế | Có thể tái sử dụng | Khoảng trống cho lịch lặp |
|---|---|---|---|---|
| Nhân viên, phòng ban, chức vụ | IMPLEMENTED | [`017_hr_core.sql:13-84,176-248`](../../supabase/migrations/017_hr_core.sql), `hr_employees`, `hr_departments`, `hr_positions`; `HrEmployees.jsx`, `HrCatalogs.jsx` | Có | Phòng ban hiện tại không lưu lịch sử thành viên theo ngày; chưa có nhóm ca riêng. |
| Hợp đồng lương | IMPLEMENTED | [`019_hr_payroll.sql:4-25,312-403`](../../supabase/migrations/019_hr_payroll.sql), `hr_payroll_contracts`, `save_payroll_contract` | Có | Hợp đồng quy định lương/phút chuẩn, không chứa quy tắc lặp. |
| Mẫu ca | NOT FOUND | Không thấy trong migrations `017`–`023`, `src/features/hr/` | Không | Cần mẫu giờ, nghỉ, dung sai có phiên bản. |
| Phân ca theo ngày | IMPLEMENTED | [`018_hr_attendance_leave.sql:15-40,217-275`](../../supabase/migrations/018_hr_attendance_leave.sql), `hr_work_schedules`, `save_hr_work_schedule`, `list_hr_work_schedules`; [`HrAttendance.jsx:430-499`](../../src/features/hr/HrAttendance.jsx) | Có | Mỗi nhân viên/ngày cần nhập riêng; chưa có nguồn quy tắc hoặc idempotent bulk assignment. |
| Quy tắc tuần / lịch xoay / ngoại lệ được duyệt | NOT FOUND | Không thấy bảng/RPC resolver tương ứng | Chỉ có ca ngày để làm kết quả | Thiếu hiệu lực, ưu tiên, duyệt, xung đột và snapshot. |
| Chấm công và điều chỉnh | IMPLEMENTED | [`018_hr_attendance_leave.sql:75-150,278-466`](../../supabase/migrations/018_hr_attendance_leave.sql), `hr_attendance`, `hr_attendance_adjustments`, `save/confirm/adjust_hr_attendance` | Có | Chỉ xử lý ca đã tồn tại; điều chỉnh công khác điều chỉnh lịch dự kiến. |
| QR, cửa hàng, gán nhân viên | IMPLEMENTED trong mã; cloud chưa xác minh | [`023_hr_qr_attendance.sql:15-55,80-118,158-218,458-638`](../../supabase/migrations/023_hr_qr_attendance.sql), `hr_attendance_sites`, `hr_site_assignments`, kiosk/challenge/event; `HrQrSetup.jsx`, `MyAttendancePage.jsx` | Có, sau kiểm thử triển khai thật | QR tra duy nhất ca **đã lưu**, không tra quy tắc lặp; gán site không phải gán lịch. |
| Nghỉ phép | IMPLEMENTED | [`018_hr_attendance_leave.sql:42-73,490-610`](../../supabase/migrations/018_hr_attendance_leave.sql), `hr_leave_requests`, `hr_leave_transitions` | Có | Chưa có chính sách diễn giải phép/ngày nghỉ trên lịch lặp hoặc số phút được trả. |
| Ngày lễ, duyệt OT riêng, đổi ca | NOT FOUND | Không thấy bảng/RPC chính sách hoặc workflow tương ứng trong HR migrations và source | Không | Phải để trạng thái chưa giải quyết hoặc hoãn theo chính sách; không suy diễn. |
| Bảng lương/duyệt/khóa | IMPLEMENTED | [`019_hr_payroll.sql:29-113,456-682`](../../supabase/migrations/019_hr_payroll.sql), `calculate_payroll`, `approve_payroll`, `pay_payroll`; [`020_hr_payroll_components.sql:205-255`](../../supabase/migrations/020_hr_payroll_components.sql) | Có | Chưa kiểm tra *đủ mọi ngày từ quy tắc lặp*; snapshot chưa gắn revision lịch. |
| Quyền/RLS/audit HR | IMPLEMENTED | [`017_hr_core.sql:105-114`](../../supabase/migrations/017_hr_core.sql), [`018_hr_attendance_leave.sql:152-173`](../../supabase/migrations/018_hr_attendance_leave.sql), [`023_hr_qr_attendance.sql:207-218`](../../supabase/migrations/023_hr_qr_attendance.sql); `app_private.audit`, lịch sử điều chỉnh | Có | Bảng/RPC mới cần cùng phạm vi quyền, kiểm soát đồng thời và audit riêng. |

## 3. Existing HR Architecture

`hr_employees.auth_user_id` là **tùy chọn** và chỉ liên kết thành viên cùng workspace; tạo hồ sơ không tạo Auth user ([`017_hr_core.sql:50-84,176-248`](../../supabase/migrations/017_hr_core.sql)). Nhân viên không có login vẫn được quản lý phân ca và công thủ công; tự quét QR hiện cần login liên kết hồ sơ. `work_location` là văn bản tự do, không dùng làm quyền cửa hàng. `hr_site_assignments` của `023` cấp quyền theo nhân viên, site và khoảng ngày; một người có thể thuộc nhiều site khác nhau trong cùng kỳ, nhưng một ca QR gắn đúng một site ([`023_hr_qr_attendance.sql:36-55,88-118`](../../supabase/migrations/023_hr_qr_attendance.sql)).

Một `hr_work_schedules` có `work_date`, thời điểm bắt đầu/kết thúc tuyệt đối, `break_minutes`, dung sai và `planned_minutes` sinh tại DB. Ràng buộc `unique(workspace_id,employee_id,work_date)` cho **tối đa một ca/ngày**, ca qua đêm tối đa 24 giờ ([`018_hr_attendance_leave.sql:15-40`](../../supabase/migrations/018_hr_attendance_leave.sql)). Đây là giới hạn V2 cần giữ ở release đầu, không hứa hai ca/ngày. `hr_attendance` tham chiếu đúng ca qua FK và có trạng thái draft/confirmed; trigger tính phút làm, muộn, về sớm, OT ([`018_hr_attendance_leave.sql:75-105,175-215`](../../supabase/migrations/018_hr_attendance_leave.sql)). QR chỉ ghi draft, quản lý xác nhận rồi payroll mới đọc.

## 4. Existing Database Tables and RPCs

| Miền | Bảng/RPC nguồn | Quy tắc quan trọng |
|---|---|---|
| HR danh mục | `hr_departments`, `hr_positions`, `hr_employees`; `save_hr_employee`, `list_hr_employees`, `get_hr_catalogs` (`017:13-84,176-248,356-425`) | FK cùng workspace, Auth tùy chọn, owner/manager đọc/mutate. |
| Ca/ngày | `hr_work_schedules`; `save_hr_work_schedule`, `list_hr_work_schedules` (`018:15-40,217-275`) | Một ca/nhân viên/ngày; sửa bị chặn sau khi có attendance; `save` hiện không có request ID, nghỉ mặc định **0 phút**. |
| Chấm công | `hr_attendance`, `hr_attendance_adjustments`; `save_hr_attendance`, `confirm_hr_attendance`, `adjust_hr_attendance`, `get_hr_attendance_summary` (`018:75-124,278-466`) | Attendance cần ca; `unrecorded_count` khác vắng mặt; sửa đã xác nhận lưu before/after và lý do. |
| Nghỉ phép | `hr_leave_requests`, `hr_leave_transitions`; `save_hr_leave_request`, `transition_hr_leave_request` (`018:42-73,490-585`) | Draft → pending → approved/rejected/cancelled, kiểm tra trùng, `kind='leave'` cần đơn approved. |
| Cửa hàng/QR | `hr_attendance_sites`, `hr_site_assignments`, `hr_qr_kiosks`, `hr_qr_challenges`, `hr_qr_attendance_events`, `hr_qr_scan_limits`; `save_hr_attendance_site`, `save_hr_site_assignment`, `scan_hr_qr`, `get_my_hr_attendance` (`023:15-218,220-638`) | Site gắn vào ca bằng FK nullable; QR xác thực server rồi tìm đúng **một** ca đã lưu trong cửa sổ `-2h/+4h`. |
| Lương | `hr_payroll_contracts`, `hr_payroll_periods`, `hr_payroll_lines`, `hr_payroll_expenses`, `hr_salary_advances`, `hr_payroll_audit`, `hr_payroll_components`; `calculate_payroll`, `review_payroll`, `approve_payroll`, `pay_payroll` (`019:4-151,456-682`; `020:12-59,205-255`) | Hợp đồng tháng/giờ, định mức/hệ số rõ; lương duyệt snapshot và chi phí, trả lương ghi tiền qua Thu Chi riêng. |

RLS hiện chỉ cho owner/manager đọc trực tiếp bảng HR; authenticated không có table-write grant. Staff được gọi RPC tự quét/tự xem của mình, không được đọc bảng HR toàn workspace ([`018:152-173`](../../supabase/migrations/018_hr_attendance_leave.sql), [`023:207-218,610-638`](../../supabase/migrations/023_hr_qr_attendance.sql)).

## 5. Current Shift Scheduling Workflow

Owner/manager mở `#/hr/attendance`, chọn **một nhân viên + một ngày công**, nhập giờ bắt đầu/kết thúc, phút nghỉ, dung sai và tên ca. Giao diện gửi `save_hr_work_schedule`; nếu chọn cửa hàng QR, tiếp tục gọi **RPC thứ hai** `bind_hr_work_schedule_site` ([`HrAttendance.jsx:244-271,588-725`](../../src/features/hr/HrAttendance.jsx), [`src/lib/hr-api.js:95-102`](../../src/lib/hr-api.js)). RPC đầu có thể thành công còn bước gắn site thất bại; UI báo ca đã lưu nhưng chưa gắn cửa hàng. Đây là lý do luồng phân ca lặp cần tạo ca + site **nguyên tử phía server**.

Màn hình dùng `datetime-local` theo thiết bị và form ca mới mặc định `break_minutes=0` ([`HrAttendance.jsx:61-84,392,590-597`](../../src/features/hr/HrAttendance.jsx)). Lịch lặp phải chuyển giờ theo `Asia/Ho_Chi_Minh` trên server và yêu cầu phút nghỉ được chọn rõ. Việc tạo ca ngày hiện không phải quy trình phê duyệt lịch; QR và lương dùng bản ghi đó nếu hợp lệ.

## 6. Verified Problems and Gaps

| Requirement | Existing Implementation | Gap | Proposed Change | Risk | Priority |
|---|---|---|---|---|---|
| Lặp T2–T7 từ 19/10/2026 | Ca riêng mỗi ngày (`018:15-40`) | Không có mẫu/quy tắc/resolver | Mẫu ca + quy tắc ngày tuần + assignment hiệu lực | Ca thiếu khiến lương bỏ sót | P0 |
| Gán nhiều nhân viên | UI chọn một người; RPC lưu một ca (`HrAttendance.jsx:244-271`) | Không có preview/bulk/idempotency | RPC preview + commit theo request ID; kết quả từng nhân viên | Ca trùng, lỗi một phần | P0 |
| QR tự dùng lịch lặp | `scan_hr_qr` tìm ca persisted (`023:500-518`) | Quy tắc ảo không đủ | Đồng bộ ca hữu hạn trước quét, later ensure trong RPC scan | QR từ chối khi thiếu đồng bộ | P0 |
| Nghỉ đúng chính sách | Ca có `break_minutes default 0` (`018:22,232-245`) | Không có company break policy | Mẫu ca yêu cầu phút nghỉ rõ hoặc chính sách đã phê duyệt | 08–17 bị hiểu 540 phút công | P0 |
| Ngày lễ/OT | Chưa có chính sách lễ/duyệt OT; trigger tự tính OT (`018:175-215`) | Phép tính lương đang dùng OT xác nhận công | Quyết định chính sách riêng trước mở rộng lương | Trả OT không theo mong muốn | P0 trước payroll rollout |
| Nghỉ phép/ngoại lệ | Đơn phép riêng; ca thủ công; audit điều chỉnh công (`018`) | Không có ngoại lệ lịch được duyệt | Override theo ngày, leave là lớp phủ riêng | Ghi đè ca có công | P1 |
| Kỳ lương đầy đủ | `calculate_payroll` chỉ kiểm các ca **đã có** (`019:493-497`) | Không phát hiện ngày phải có ca nhưng chưa sinh | Verify coverage của rule/assignment trước tính và duyệt | Thiếu lương không báo lỗi | P0 |
| Lịch sử đã khóa | Payslip snapshot, APPROVED/PAID khóa (`019:535-557,606-682`) | Snapshot không ghi nguồn/revision lịch; insert ca cũ chưa chặn kỳ khóa | Gắn nguồn ca, khóa materialization quá khứ và snapshot rule revision | Lịch hiển thị khác lương đã chốt | P0 |
| Multi-store | Site assignment hiệu lực và nullable `site_id` (`023:36-55,80-118`) | Gán site khác với gán lịch; chưa có store manager scope | Mỗi assignment lịch chỉ định site và xác thực assignment site | Sai cửa hàng / mở rộng quyền | P1 |
| Nhóm/phòng ban mặc định | Có phòng ban hiện tại (`017:13-84`) | Không có membership lịch sử hoặc group schedule | Release đầu chọn nhiều nhân viên tường minh; group policy sau | Tự đổi lịch khi nhân viên đổi phòng ban | P2 |

## 7. Recurring Weekly Schedule Requirements

Ví dụ `Lịch hành chính T2–T7`: ngày hiệu lực **thứ Hai 19/10/2026**, weekday ISO `1..6`, Chủ nhật `7` nghỉ, giờ local 08:00–17:00, timezone `Asia/Ho_Chi_Minh`. Quy tắc release đầu phải có `coverage_mode=COMPLETE_WEEK`: các ngày không chọn trong cùng tuần là `OFF` rõ ràng; người không được gán quy tắc vẫn là `UNRESOLVED`. `effective_until=null` nghĩa là quy tắc mở, **không** tạo vô hạn dòng ngày. Mẫu ca phải ghi rõ phút nghỉ hoặc tham chiếu đến chính sách nghỉ có thật; hiện không thấy bảng chính sách đó, vì vậy release đầu phải nhập phút nghỉ minh thị (kể cả `0` nếu đó là quyết định được xác nhận). Ví dụ 08:00–17:00 là 9 giờ hiện diện; số phút trả lương chỉ được quyết định sau khi biết nghỉ và quy tắc hợp đồng. Không gán mặc định toàn workspace; chọn nhân viên và site hợp lệ một cách tường minh. Hợp đồng/kỳ lương hiện có tiếp tục quyết định mẫu số trả lương, không tự thay bằng 26 ngày.

## 8. Recommended Architecture

```text
Mẫu ca có phiên bản + quy tắc tuần (gọn)
  → phân công nhân viên/site có hiệu lực
  → resolver DB tại ngày/khung ngày được hỏi
      ├─ preview lịch, conflict, ngày chưa giải quyết
      └─ đồng bộ ca ngày trong chân trời hữu hạn, idempotent
            → hr_work_schedules hiện có
            → QR → hr_attendance nháp → quản lý xác nhận
            → calculate_payroll hiện có, sau kiểm tra coverage mới
```

**So sánh:**

| Tiêu chí | A. Chỉ tính theo yêu cầu | B. Quy tắc gọn + đồng bộ ca hữu hạn |
|---|---|---|
| Số dòng tương lai | Ít nhất | Chỉ 30–60 ngày đã đồng bộ; không tạo cả năm |
| Độ phức tạp | Resolver phải được cắm vào QR, attendance FK, dashboard và payroll cùng lúc | Giữ `hr_work_schedules` là hợp đồng hiện có; thêm resolver và lệnh đồng bộ |
| QR/lương hiện tại | Không chạy với ca ảo (`018:96-100`; `023:500-518`; `019:493-497`) | Chạy với ca đã lưu, nhưng phải bảo đảm đồng bộ đủ |
| Audit/lịch sử | Phải snapshot mỗi lần truy vấn và dựng lại quá khứ | Ca ngày là snapshot gần hạn; lưu rule revision và origin |
| Xung đột/multi-store | Quyết định ngay khi gọi, có thể biến động giữa xem và quét | Kiểm tra trước commit, giữ site trên ca, chặn hai nguồn cùng ngày |
| Supabase Free | Ít lưu trữ hơn nhưng nhiều resolver trong mọi RPC và rủi ro timeout/N+1 | Dùng query theo range, batch và chân trời hạn chế; không giả định quota Free cụ thể |

**Khuyến nghị B:** preview on-demand; materialization 45 ngày (tham số vận hành có giới hạn, ví dụ tối đa 60), duy trì bằng tác vụ trusted sau khi xác minh khả năng runtime; trước QR cần bảo đảm ca của hôm nay, trước payroll cần đồng bộ và kiểm tra **toàn kỳ**. Không phụ thuộc trình duyệt của manager mở trang để tạo ca. Release đầu có thể giữ QR cũ với ca đã đồng bộ; Phase E mới nối cơ chế ensure/cảnh báo nếu job chậm, có khóa và giới hạn để nhân viên không thể sinh lịch cho người khác.

## 9. Schedule Resolution Algorithm

1. RPC nhận workspace, khoảng ngày **hữu hạn**, danh sách nhân viên được phép; kiểm tra vai trò, ngày hợp lệ, timezone server `Asia/Ho_Chi_Minh`, kích thước batch. Lấy assignments, rules, templates, site assignments, ca đã lưu, leave theo **một số truy vấn theo range**, không N+1.
2. Với từng nhân viên/ngày, áp dụng ngày bắt đầu/kết thúc hiệu lực, weekday ISO và revision có hiệu lực. Với quy tắc `COMPLETE_WEEK` release đầu, ngày ngoài weekday làm việc trả `OFF`; người chưa được gán rule trả `UNRESOLVED`, không tự đánh vắng. Nếu sau này hỗ trợ quy tắc `PARTIAL_WEEK`, ngày ngoài mask vẫn chưa được giải quyết cho đến khi xét hết các rule khác.
3. Áp dụng thứ tự ưu tiên ở §10, kiểm tra cùng workspace/site, site assignment theo `work_date`, người đang hoạt động, một ca/ngày. Chuyển local date+time thành `timestamptz` tại server; ca qua nửa đêm tăng ngày kết thúc, giữ `work_date` là ngày bắt đầu ở Việt Nam.
4. Tính `planned_minutes = elapsed - break_minutes` như DB hiện có; nếu thiếu break/policy, site hoặc nguồn mâu thuẫn thì trả `NEEDS_POLICY`/`CONFLICT`, không tạo ca. Kiểm tra giao nhau bằng khoảng thời gian thực với ca ngày trước/sau, kể cả ca qua đêm; `unique(employee,work_date)` riêng nó không chặn chồng giờ.
5. Preview trả nguồn chọn, phút dự kiến, site, leave/holiday overlay, ca đã lưu và lý do xung đột. Commit kiểm tra lại dưới khóa theo nhân viên/ngày, ghi cùng kết quả hoặc từ chối nếu trạng thái đã đổi. Retry cùng request ID/payload trả cùng kết quả, không nhân đôi ca.
6. Đồng bộ chỉ tạo/sửa ca có nguồn `generated` trong chân trời, chưa có attendance/QR event/chốt lương. Ca legacy/manual, override và lịch đã khóa không bị xóa hoặc ghi đè. Chốt kỳ cần kiểm tra ngày dự kiến đã được biểu diễn bởi ca phù hợp hoặc nghỉ/ngoại lệ hợp lệ, không chỉ đếm ca đã lưu.

## 10. Schedule Priority and Conflict Rules

**Bảo vệ lịch sử đứng ngoài thứ tự ưu tiên:** ca đã có chấm công, QR event hoặc thuộc kỳ APPROVED/PAID không bị tái sinh/sửa. Với ngày còn mở: (1) override một ngày đã duyệt hoặc ca legacy thủ công có nguồn rõ; (2) phân công tạm đã duyệt nếu sau này có; (3) assignment quy tắc lặp trực tiếp cho nhân viên; (4) chính sách nhóm/site mặc định **chỉ khi triển khai và có membership theo ngày**; (5) `UNRESOLVED`. Hai quy tắc cùng mức cùng áp dụng một ngày là **conflict**, không chọn bằng `created_at` hay UUID. Không để quy tắc tự xóa một ca thủ công.

Nghỉ phép được duyệt là **lớp phủ trạng thái vắng/phép trên ngày có lịch**, không phải ca thay thế; đơn pending không làm biến mất ca. Ngày lễ chưa có mô hình/chính sách: hiển thị `HOLIDAY_POLICY_UNRESOLVED` khi một lịch ngày lễ được khai báo về sau, không tự cộng/trừ lương. Overtime hiện được trigger tính khi ra muộn nhưng **chưa có duyệt riêng**; không tự coi một đổi ca hoặc check-out muộn là OT đã được phê duyệt theo chính sách mới. Ca qua đêm và ca ngày kế tiếp phải kiểm tra khoảng thời gian thực, không chỉ `work_date`.

## 11. Employee Bulk Assignment Design

Release đầu: chọn **một hoặc nhiều nhân viên cụ thể**, lọc phòng ban chỉ để tiện chọn; ghi snapshot danh sách tại lúc xác nhận. Không có bảng nhóm nhân viên có hiệu lực theo thời gian; không bật “mọi người trong phòng ban/cửa hàng tự động nhận lịch” ở release đầu. Mỗi assignment tham chiếu rule, employee, site, `valid_from`, `valid_to` tùy chọn và người tạo. Chỉ **một assignment `COMPLETE_WEEK` có hiệu lực cho mỗi nhân viên/ngày** trong release đầu; ngoại lệ theo ngày là lớp riêng. Site phải đang hoạt động và `hr_site_assignments` bao phủ mọi ngày **có ca** trong khoảng hiệu lực; RPC từ chối assignment lịch mở vô hạn nếu phân công site có ngày kết thúc, trừ khi lịch được giới hạn không vượt ngày đó. Không lấy `hr_employees.work_location` làm site. Nếu chuyển site, kết thúc assignment cũ từ ngày thực tế và tạo assignment mới; không sửa lịch sử.

RPC preview trả mỗi người: số ngày/ca sẽ tạo hoặc giữ, trùng ngày, trùng thời gian/site, thiếu site assignment, leave, kỳ lương khóa, attendance có sẵn. Commit với request ID + hash payload, khóa theo workspace/nhân viên, xác thực lại mọi dòng. **Đề xuất mặc định atomic cả batch** khi có bất kỳ conflict; preview cung cấp lý do từng người để sửa rồi thử lại. Nếu sau này cho phép partial success phải có kết quả từng người và cùng idempotency key; không làm lặng lẽ. Mỗi thay đổi hiệu lực/revision có audit và lý do khi thay/lưu trữ.

## 12. Exception and Leave Integration

Một ngoại lệ lịch theo ngày chỉ có `OFF` hoặc `REPLACE` trong release đầu; quản lý owner/manager nhập lý do, xem trước ảnh hưởng và duyệt trước khi áp dụng. Override được giữ riêng khỏi quy tắc tuần, có người duyệt, thời điểm và revision; không chỉnh trực tiếp bản chấm công. Có thể tái sử dụng ca ngày thủ công hiện có làm kết quả override, nhưng cần metadata nguồn và guard để không tự đồng bộ đè lên. Nghỉ phép giữ nguyên trong `hr_leave_requests` + transitions, và `hr_attendance.kind='leave'` chỉ khi đơn được duyệt ([`018:299-301,543-585`](../../supabase/migrations/018_hr_attendance_leave.sql)). Không tạo bảng leave thứ hai.

Đổi ca hai chiều, lịch xoay và phân công tạm là **mở rộng sau** vì chưa có workflow đồng ý/duyệt. Overtime cần chính sách và duyệt riêng nếu ChiDi muốn trả theo OT đã phê duyệt; giờ ra muộn hiện chỉ là dữ kiện. Ngày lễ chưa có nguồn tin cậy; cần quyết định loại ngày, phạm vi site, trả lương trước khi tự áp dụng. Sau attendance hoặc payroll khóa, ngoại lệ chỉ qua quy trình điều chỉnh có audit và không đổi phiếu lương đã duyệt; cần thiết kế điều chỉnh kỳ sau riêng.

## 13. QR Attendance Integration

`scan_hr_qr` hiện giải Auth user thành nhân viên trong cùng workspace, xác thực challenge/kiosk, rồi đếm ca đã lưu trong cửa sổ `planned_start_at - 2h` đến `planned_end_at + 4h`; phải đúng **một** ca và site trên ca phải khớp QR site cùng phân công nhân viên ([`023:458-519`](../../supabase/migrations/023_hr_qr_attendance.sql)). Vì vậy resolver phải tạo ca ngày có `site_id` trước ca hoặc được gọi bằng đường trusted với cùng giao dịch khi thiếu ca. Không để scanner gửi `employee_id`, `site_id` hay timestamp làm căn cứ. Kiosk/QR/event của `023` giữ nguyên; **không thiết kế kiosk mới** trong kế hoạch này.

Resolver phải biểu thị rõ đến sớm/muộn, về sớm/muộn, thiếu checkout, nhiều event, ca qua đêm, sai site, chưa được phân ca, phép được duyệt. Các trạng thái này không đồng nghĩa phút được trả. `hr_qr_attendance_events` tiếp tục là bằng chứng bất biến; `hr_attendance` đã xác nhận mới là đầu vào lương. Trước triển khai tích hợp cần smoke test `023` trên staging Supabase và thiết bị thật; mã có trong repo không chứng minh đã chạy thật.

## 14. Payroll Integration

`calculate_payroll` (`019`, mở rộng bởi `020`) chỉ kiểm mọi **ca đã tồn tại** có `hr_attendance.status='confirmed'`, rồi lấy phút làm/OT, phép đã duyệt và hợp đồng/kỳ. Nó **không biết ngày nào thiếu ca do quy tắc chưa đồng bộ** ([`019:456-557`](../../supabase/migrations/019_hr_payroll.sql)). Do đó phải thêm cổng kiểm tra coverage trên toàn bộ ngày hiệu lực theo rule + exceptions trước tính và kiểm tra lại trước review/approval; không được coi thiếu ca là ngày nghỉ/vắng. Chu kỳ tính phải dùng lịch/snapshot có hiệu lực tại ngày công, không tính từ template hiện tại nếu template đã đổi.

Hợp đồng tháng/giờ định nghĩa `standard_day_minutes`, `standard_month_minutes`, `overtime_multiplier`, `paid_leave_types`; kỳ có override mẫu số/hệ số ([`019:4-52`](../../supabase/migrations/019_hr_payroll.sql)). Phút dự kiến từ lịch dùng để đối chiếu đầy đủ và muộn/về sớm; **không tự thay mẫu số lương hợp đồng bằng tổng lịch** hoặc mặc định 26 ngày. Phút nghỉ trong ca phải cấu hình minh thị. Phép trả lương theo chính sách hợp đồng hiện hành; nghỉ không lương/holiday chưa được tự động tính. OT hiện tính từ giờ ra so với kế hoạch, cần quyết định duyệt riêng trước khi đổi engine. `source_snapshot` của payslip hiện ghi hợp đồng, nhân viên, attendance, leave, advances nhưng chưa ghi rule/assignment/template revision hay ca dự kiến; đề xuất bổ sung snapshot nguồn đã dùng. Khi attendance/leave đổi, trigger mở lại CALCULATED/REVIEWED ([`019:257-311`](../../supabase/migrations/019_hr_payroll.sql)); lịch mới cần cơ chế tương tự, vì insert ca hiện chưa nằm trong trigger này. APPROVED/PAID và chi phí lương/chi tiền đã post phải bất biến ([`019:606-682`](../../supabase/migrations/019_hr_payroll.sql)); chênh lệch sau chốt cần quy trình điều chỉnh có lý do riêng.

## 15. Proposed Data Model Changes

**Chỉ là đề xuất migration mới, không có SQL được tạo trong giai đoạn audit.** Existing `hr_work_schedules` không thể biểu diễn một quy tắc tuần; `hr_site_assignments` chỉ cấp quan hệ nhân viên-site, không biểu diễn ngày trong tuần/giờ ca. Đề xuất tối thiểu:

| Thay đổi dự kiến | Vì sao cần / trường chính | Ràng buộc, index, lịch sử, migration risk |
|---|---|---|
| `hr_shift_templates` | Workspace, mã/tên, local `start_time`, `end_time`, `end_day_offset` 0/1, **break_minutes được nhập rõ**, grace, active, revision, actor/time | Check thời lượng >0 và ≤24h, nghỉ < thời lượng, unique mã theo workspace; chỉnh mẫu tạo revision mới, không sửa snapshot cũ. RLS manager-read/write RPC. Không chứa site để tái sử dụng tại nhiều cửa hàng. |
| `hr_weekly_schedule_rules` | Workspace, template revision FK, weekday mask/ISO days, `coverage_mode=COMPLETE_WEEK` ban đầu, timezone `Asia/Ho_Chi_Minh`, effective_from/until, status/revision, actor/time | Check 1–7, ít nhất một ngày làm, range hợp lệ, index workspace+date/status; ngày không chọn là `OFF` chỉ trong chế độ complete-week. Một rule không tự gán nhân viên. Không backfill từ ca cũ. `PARTIAL_WEEK` là mở rộng sau. |
| `hr_recurring_assignments` | Workspace, employee, rule, **site**, valid_from/to, request/source revision, actor/time | Composite FK cùng workspace đến employee/rule/site; index employee+date và site+date; release đầu khóa/chặn mọi khoảng hiệu lực chồng cho cùng nhân viên. Nếu hỗ trợ `PARTIAL_WEEK` về sau mới nới guard để chấp nhận mask ngày tách biệt sau kiểm tra xung đột thực. Site assignment phải bao phủ ca phát sinh. |
| Nguồn trên `hr_work_schedules` | `source_rule_id`, `source_assignment_id`, `source_revision` hoặc snapshot JSON nhỏ, `source_kind` cho generated/override | FK workspace; unique nguồn + employee + date; ca legacy không gán nguồn suy đoán. Guard không cho RPC sửa ca generated ngoài luồng override và không đổi ca đã có attendance/QR hoặc thuộc kỳ khóa. Migration phải tương thích nullable rows cũ. |
| `hr_schedule_overrides` (Phase D) | Workspace, employee, work_date, OFF/REPLACE, template/site/giờ và break nếu replace, reason, status/approver/revision | Unique một override approved/ngày, FK cùng workspace, audit before/after; không nhân bản leave. Cần chốt workflow trước khi thêm bảng. |

Không cần `resolved_shift` như bảng tương lai vô hạn: dùng `hr_work_schedules` hiện hữu làm ảnh chụp ca đã đồng bộ. Có thể cần bảng nhỏ giữ kết quả request/batch idempotency nếu hạ tầng `app_private.remember` không đủ cho payload hash và kết quả từng nhân viên; quyết định sau khi thiết kế RPC Phase B. Không đề xuất bảng holiday/OT/group ngay vì nghiệp vụ và nguồn dữ liệu chưa chốt. Không xóa ca lịch sử hoặc thay số liệu payroll cũ. Trước migration phải kiểm tra môi trường nâng cấp có `017`–`023` đúng thứ tự, giới hạn kiểu/constraint và dữ liệu ca/site thực tế; rollback dùng migration bù được review, không `DROP` lịch sử.

## 16. RLS, Permissions and Audit

Mọi bảng mới có `workspace_id`, composite FK, indexes theo workspace/range, RLS manager-read, không cấp ghi trực tiếp cho authenticated; mutation chỉ qua `SECURITY DEFINER` có `search_path=''`, kiểm tra `app_private.hr_require_management`/role tương đương, khóa workspace và nhân viên trước kiểm tra conflict. Giữ mô hình quyền hiện tại: **owner/manager** tạo/sửa/duyệt lịch cho workspace; **staff** chỉ xem lịch tối thiểu của chính Auth-linked employee bằng RPC riêng; hồ sơ không có Auth vẫn được manager phân ca. Chưa có per-site manager role, vì vậy không giả định manager chỉ quản lý một site; mọi việc cần đúng workspace/site FK và hiệu lực.

Mỗi commit mẫu/rule/assignment/override/materialization ghi actor `auth.uid()`, thời điểm server, reason khi thay lịch, request ID, hash nội dung, before/after hoặc revision ID vào audit HR có quyền quản lý; audit chung chỉ chứa ID/thông tin tối thiểu. Batch retry/tranh chấp phải trả cùng kết quả hoặc conflict, không nhân ca. Preview không cấp quyền ghi. Client không thể tự gửi employee thuộc workspace khác, site khác, timestamp, trạng thái phê duyệt hay revision tùy ý. Ca thuộc APPROVED/PAID phải từ chối sửa/sinh ngược; kiểm tra cả RPC và guard DB.

## 17. UI/UX Screen Design

Tận dụng `HRWorkspace.jsx` tabs, `HrAttendance.jsx`, `HrQrSetup.jsx`, `HrShared.jsx`, `components.jsx` (`Panel`, `Field`, `Modal`, `Table`) và CSS HR responsive. Đề xuất `Nhân sự → Ca làm` trong bố cục hiện tại, với bốn subview **Lịch tuần/tháng · Mẫu ca · Phân ca lặp · Ngoại lệ**; không nhân đôi module Chấm công.

```text
Ca làm  [Tuần/Tháng] [Cửa hàng] [Nhân viên/Phòng ban] [Hôm nay] [<] [>]
         T2          T3 ... CN
NV A     08–17       08–17   Nghỉ
         QR Site A   QR Site A
         nghỉ [đã chọn] phút · nguồn: quy tắc / ngoại lệ / thủ công
         [khóa công] hoặc [Cần xử lý xung đột]

Phân ca lặp: [1. Mẫu ca + nghỉ + site]
              → [2. Chọn T2..CN + ngày hiệu lực]
              → [3. Chọn nhiều nhân viên, tìm kiếm/lọc]
              → [4. Xem trước 4 tuần: tạo/giữ/xung đột]
              → [5. Xác nhận phân ca]
```

Mẫu ca lưu giờ và phút nghỉ explicit; quy tắc chọn thứ lặp; bước chọn người dùng multi-select phân trang mới (picker hiện tại chỉ chọn một). Calendar phân biệt `OFF`, `UNRESOLVED`, phép approved, ca đã có công và lịch đã khóa; không hiển thị `UNRESOLVED` như vắng mặt. Ngoại lệ ngày dùng dialog tác động có lý do, không nút xóa tùy tiện. Desktop có grid tuần/bảng; mobile dùng thẻ từng ngày, bộ lọc dạng sheet/drawer, nút xác nhận dễ chạm và không tràn ngang. Mỗi nút chỉ xuất hiện khi RPC tương ứng tồn tại; giữ form ca ngày hiện tại cho điều chỉnh thủ công hợp lệ.

## 18. Performance and Supabase Free Optimization

**Ước tính giả định**: tất cả nhân viên cùng mẫu T2–T7, 26 ngày làm trong 30 ngày, 52 ngày trong 60 ngày, khoảng 313 ngày/năm; một rule/mẫu chung, một assignment/người; chưa tính attendance/audit/ngoại lệ.

| Nhân viên | Nhập ca thủ công 30 ngày | Tạo cả năm thủ công | Mẫu+rule+assignments | Ca đồng bộ trong 60 ngày |
|---:|---:|---:|---:|---:|
| 10 | ~260 dòng/thao tác | ~3.130 | 12 dòng | ~520 |
| 50 | ~1.300 | ~15.650 | 52 dòng | ~2.600 |
| 200 | ~5.200 | ~62.600 | 202 dòng | ~10.400 |

Lịch sử ca/chấm công thật vẫn tăng theo thời gian; lợi ích chính là **không tạo tương lai vô hạn và không thao tác tay hằng ngày**. Batch calendar theo workspace, date range, employee/site; index theo `(workspace_id,employee_id,effective dates)` và `(workspace_id,work_date,employee_id)`, phân trang nhân viên, tránh N+1. Đồng bộ 45 ngày theo batch giới hạn, chỉ xử lý ngày mới hoặc revision cần cập nhật; ca có công/khóa giữ nguyên. Giới hạn preview (ví dụ tối đa 60 ngày, 200 nhân viên/lần sau đo hiệu năng), có khóa/timeout hợp lý và báo conflict theo từng dòng. Không gán dung lượng/quota cụ thể cho Supabase Free vì repository không chứng minh gói cloud thực tế; cần đo PGlite/staging và theo dõi DB size, latency, số ca đã sinh.

## 19. Test Plan

**Các ca phải viết khi triển khai, chưa được chạy trong audit này:** recurrence T2–T7 từ 19/10/2026, CN off, xuyên tháng/năm, timezone Việt Nam, biên ngày/ca qua đêm; một nhân viên, bulk nhiều người, người không Auth, hết hiệu lực, chuyển site, giao ngày và overlap thời gian; override một ngày, phép approved/pending, holiday chưa cấu hình trả unresolved, đổi ca/OT chỉ sau policy; QR đúng/sai site, sớm/muộn, checkout thiếu/lặp, nhiều event, retry; phút công với break explicit, phép trả/không trả, OT theo quyết định, payroll locked không đổi; RLS, role, cross-workspace, concurrent managers, double commit, lost response.

**Lệnh thật trong `package.json` khi đến từng gate:** `npm run test:hr-attendance-leave`, `npm run test:hr-qr`, `npm run test:hr-payroll`, `npm run test:hr-payroll-components`, `npm run test:hr`, `npm run test:e2e`, `npm run check`, `npm run build`. Bổ sung một script test recurrence vào `package.json` **chỉ ở phase triển khai** và đưa nó vào `test:hr`; hiện không có lệnh này, không được báo PASS. E2E fixture không chứng minh Supabase thật; cần thử owner/manager/staff, site, QR và payroll trên staging với dữ liệu thử, rồi đối chiếu snapshot/lương.

## 20. Implementation Phases

Mỗi phase là một gate riêng; không thực hiện trong tài liệu này. **Checkpoint** nghĩa là review kết quả và quyết định phạm vi tiếp theo; không tự triển khai production.

| Phase | Scope và phụ thuộc | Tệp/migration có thể thay đổi | Acceptance và test commands thật | Rollback và checkpoint |
|---|---|---|---|---|
| A — mẫu ca + rule | Sau xác minh `017`–`023`; mẫu giờ, break explicit, weekday/effective dates, version, preview thuần server | Migration mới **đề xuất**, `src/lib/hr-api.js`, HR UI; chưa chạm QR/payroll | Rule T2–T7 đúng giờ Việt Nam, không sửa lịch sử; `npm run test:hr`, `npm run build` + test mới sau khi khai báo | Tắt UI/RPC mới; giữ rows, migration bù; review mô hình break/version. |
| B — assignments + conflict | Phụ thuộc A; chọn nhiều người/site, hiệu lực, preview+commit nguyên tử/idempotent | Migration mới **nếu cần**, `HrAttendance.jsx`/subview, `hr-api.js` | Trùng ngày/giờ và sai site bị chặn, retry không nhân dòng; `npm run test:hr`, `npm run check` | Dừng tạo assignment, giữ audit; review nguồn gán người/site. |
| C — resolver + calendar | Phụ thuộc B; range resolver, calendar, đồng bộ ca 45 ngày, bảo vệ ca legacy | Migration mới **để gắn origin/guard**, HR calendar/UI | QR hiện tại tìm ca đã đồng bộ; không sinh ca quá horizon, quá khứ khóa; `npm run test:hr-qr`, `npm run test:e2e`, `npm run build` + test mới | Ngừng job/RPC đồng bộ, ca đã dùng giữ nguyên; review độ trễ/staging. |
| D — ngoại lệ + leave | Phụ thuộc C và quyết định leave/holiday; override approved, leave overlay | Migration mới **nếu workflow xác nhận**, `HrLeave.jsx`, HR schedule UI | Override không đổi rule/công cũ; phép không thành ca thay thế; `npm run test:hr-attendance-leave`, `npm run test:hr-payroll` + test mới | Tắt tạo override mới, giữ lịch sử; review chính sách lễ/phép. |
| E — QR integration | Phụ thuộc C và staging xác minh `023`; ensure ca đủ trước scan, không cho staff sinh ca người khác | Migration mới **chỉ cho RPC cần thiết**, `MyAttendancePage.jsx` nếu hiển thị unresolved | Đúng site/ca, missing schedule rõ, retry/overnight; `npm run test:hr-qr`, `npm run test:e2e` + smoke thật | Giữ scan `023` với ca có sẵn nếu phù hợp; không xóa QR event; review kiosk/phone thật. |
| F — attendance/payroll | Phụ thuộc C/D và chính sách break/OT/leave; coverage toàn kỳ, snapshot revision, lock | Migration mới cho calculator/approval guard, HR payroll UI nếu cần | Thiếu ca chặn tính; 08–17 không tự quy thành 8h; APPROVED/PAID không đổi; `npm run test:hr-payroll`, `npm run test:hr-payroll-components`, `npm run test:hr` + đối soát staging | Không đảo payslip/ledger đã duyệt; migration bù và điều chỉnh kỳ sau; review tài chính. |
| G — hardening | Sau A–F; RLS, concurrency, pagination, performance, regression và vận hành | Tests/docs, migration bù nếu phát hiện lỗi | `npm run check`, `npm run test:e2e`, `npm run build`, test role/cloud thực; quan sát DB/latency | Feature flag/tắt luồng mới, bảo toàn lịch sử; release review trước production. |

## 21. Risks and Open Questions

- **Chính sách nghỉ:** không có bảng `EXISTING_COMPANY_POLICY` được xác minh. ChiDi cần chốt phút nghỉ/ca hoặc nguồn chính sách; mẫu ca không mặc định 60 phút và không sao chép im lặng mặc định 0 của form hiện tại.
- **OT và ngày lễ:** DB đang tính OT từ giờ ra nhưng chưa có phê duyệt riêng; chưa có bảng holiday. Phải chốt quyền/định nghĩa trả OT, lễ và phép theo kỳ trước Phase D/F.
- **Coverage payroll:** thiếu ca do job trễ có thể làm lương thấp nhưng `calculate_payroll` hiện vẫn pass nếu mọi ca *đã lưu* có công. Gate toàn kỳ là bắt buộc.
- **Cloud/runtime:** `023` chưa được chứng minh đã áp dụng; cần xác minh Supabase staging, quyền và job nền được hỗ trợ trước khi phụ thuộc QR tự động. Không hứa background job chỉ dựa trên mô tả Free.
- **Lịch sử và thay đổi quy tắc:** cập nhật template/rule giữa kỳ phải tạo revision hiệu lực, báo impact, giữ snapshot cũ; không cập nhật payroll approved/paid. Hiện chưa có workflow điều chỉnh lương kỳ sau.
- **Multi-store và nhóm:** nhân viên có thể được gán nhiều site; chưa có quyền quản lý riêng theo site hoặc group membership theo ngày. Release đầu gán người rõ ràng, không suy ra từ phòng ban/current `work_location`.
- **Ca chồng nhau:** một ca/ngày không loại trừ hai ca ở hai `work_date` có cửa sổ thời gian chồng qua nửa đêm; kiểm tra interval ở server và dưới khóa.
- **Thay đổi đồng thời:** manual form lưu ca và bind site bằng hai RPC; luồng mới phải ghi nguyên tử, nhưng cần bảo vệ người dùng đang mở form cũ khỏi ghi lên generated row.

## 22. Files Likely to Change

**Chỉ ở phase triển khai sau khi được duyệt:** một hoặc vài file migration **mới sau `023`**; `src/lib/hr-api.js`; `src/features/hr/HRWorkspace.jsx`, `HrAttendance.jsx`, `HrQrSetup.jsx`/`HrLeave.jsx`/`HrPayroll.jsx` tùy gate; các component lịch mới theo chuẩn JS/JSX; `src/features/hr/hr.css`/`hr-attendance.css`; `scripts/test-hr-*.mjs`, `tests/e2e/hr-visual.spec.js` hoặc test mới; `package.json` khi có lệnh test mới; docs HR, kiến trúc và verification. Không sửa `001`/`002`/`003`, không tạo ledger/chấm công/lương song song, không cài dependency nếu chưa có nhu cầu đo được.

## 23. Next Safe Action

**Tại thời điểm audit 13/10:** cần quyết định phút nghỉ và duyệt OT trước khi bắt đầu Phase A. Từ 14/10, người dùng đã chốt phút nghỉ theo **từng loại ca** và tăng ca **duyệt riêng**; mã cục bộ `024`/`025` thực hiện phần này bằng phút nghỉ không tính công bắt buộc trên mẫu ca và quyết định tăng ca có lý do. Quyết định trả lương cho **phút nghỉ có lương**, ngày lễ và điều chỉnh kỳ lương đã khóa vẫn chưa được mã hóa. Bước tiếp theo là smoke test migration, quyền và đối soát trên **Supabase staging** trước khi dùng cho dữ liệu thật.
