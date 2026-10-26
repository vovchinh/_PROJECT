# ChiDi ERP — Smart QR Attendance: Phase 1 audit

**Phạm vi:** kiểm tra kiến trúc hiện tại và đề xuất triển khai. Chưa thêm giao diện, RPC, bảng hay migration. Nguồn đối chiếu là mã trong `src/features/hr/`, `src/lib/hr-api.js`, migrations `001`, `017`–`020` và các bài thử HR hiện có. Trạng thái migration trên Supabase thật chưa được xác minh (`docs/verification/CURRENT.md`).

## CURRENT ATTENDANCE ARCHITECTURE

- Ứng dụng React điều hướng đến `#/hr/<section>` qua `src/App.jsx`. `HRWorkspace.jsx` chỉ mở toàn bộ phân hệ HR cho owner/manager của workspace online; staff, viewer và bản demo không có màn hình tự chấm công.
- Hồ sơ nhân viên tách khỏi Auth. `hr_employees.auth_user_id` là liên kết **tùy chọn** tới thành viên cùng workspace, duy nhất trong workspace; tạo hồ sơ không tạo tài khoản Auth. Giao diện hiện yêu cầu quản lý nhập Auth user ID thủ công. Xóa membership sẽ bỏ liên kết và ghi audit (`017_hr_core.sql`).
- `HrAttendance.jsx` là bàn làm việc của quản lý: tạo ca, nhập giờ vào/ra, lưu chấm công nháp, xác nhận, hoặc điều chỉnh bản đã xác nhận với lý do. `hr-api.js` gọi RPC theo workspace; thời gian nhập tay được đổi từ `datetime-local` theo múi giờ thiết bị sang ISO. Đây không phải timestamp tin cậy cho quét QR.
- Database là nguồn tính phút công: trigger `app_private.hr_attendance_facts()` tính `work_minutes`, `late_minutes`, `early_leave_minutes`, `overtime_minutes`. Chưa có sự kiện quét nguyên thủy, kiosk hay QR challenge.

## EXISTING TABLES

| Bảng hiện có | Vai trò / giới hạn liên quan QR |
| --- | --- |
| `workspaces`, `workspace_members` (`001`) | Auth membership với vai trò owner/manager/staff/viewer; kiểm tra quyền qua `app_private.member_role`. |
| `hr_employees` (`017`) | Hồ sơ, trạng thái, `auth_user_id` tùy chọn; `work_location` là văn bản tự do, không phải FK cửa hàng hay quyền chấm công tại địa điểm. |
| `hr_departments`, `hr_positions` (`017`) | Danh mục tổ chức, không thay thế cửa hàng. |
| `hr_work_schedules` (`018`) | Một ca cho mỗi nhân viên/ngày công; giờ bắt đầu/kết thúc là `timestamptz`, ca qua đêm tối đa 24 giờ; có phút nghỉ, dung sai đi muộn/về sớm. Không có site/store FK hay trạng thái duyệt ca. Ca đã có chấm công không sửa trực tiếp. |
| `hr_attendance` (`018`) | Một tóm tắt cho mỗi nhân viên/ngày công, FK tới ca; loại `work/absent/leave`, trạng thái `draft/confirmed`; giờ vào/ra và phút tính từ trigger. Chưa ghi nguồn/phương thức sự kiện. |
| `hr_attendance_adjustments` (`018`) | Lịch sử điều chỉnh đã xác nhận: lý do, ảnh trước/sau, actor, request ID; bản ghi lịch sử bất biến. |
| `hr_leave_requests`, `hr_leave_transitions` (`018`) | Nghỉ phép được duyệt có thể làm căn cứ cho chấm công loại `leave`. |
| `hr_payroll_contracts`, `hr_payroll_periods`, `hr_payroll_lines` (`019`), `hr_payroll_components` (`020`) | Hợp đồng/kỳ quy định cách trả lương; bảng lương lấy chấm công **đã xác nhận** và lưu snapshot khi tính/duyệt. |

`warehouses` thuộc nghiệp vụ tồn kho (`001_core.sql`), hiện không được định nghĩa là cửa hàng chấm công. Không nên dùng `work_location` hoặc warehouse làm bằng chứng được phép quét ở một cửa hàng.

## CURRENT WORKFLOWS

1. Owner/manager gán ca bằng `save_hr_work_schedule`; một nhân viên có tối đa một ca theo `work_date` trong mô hình hiện tại.
2. Owner/manager ghi `save_hr_attendance` thành nháp. Thiếu giờ ra giữ `work_minutes = null`; không tự coi là vắng. `confirm_hr_attendance` từ chối bản ghi làm việc thiếu giờ vào/ra và cho phép retry cùng request ID.
3. Bản xác nhận chỉ được sửa qua `adjust_hr_attendance` với lý do 10–4.000 ký tự, request ID và ảnh trước/sau bất biến. Chưa có màn hình nhân viên tự gửi yêu cầu điều chỉnh để quản lý duyệt.
4. RLS chỉ cho owner/manager đọc các bảng HR, client không được ghi trực tiếp. Các RPC đọc/ghi chấm công cũng yêu cầu owner/manager; không mở rộng RPC nhập tay này cho staff.
5. Không tìm thấy luồng kiosk, scanner, QR, ghi nhận check-in/check-out tự động hoặc kiểm soát người quét theo địa điểm trong mã/migrations được kiểm tra.

## SECURITY RISKS

- QR tĩnh, QR chứa employee ID hoặc dùng đồng hồ/`employee_id` do browser gửi sẽ cho phép giả mạo hoặc dùng lại. QR chỉ nên mang challenge ngẫu nhiên ngắn hạn, không mang PII hay credential; server lấy nhân viên từ `auth.uid()`.
- QR được chụp/chia sẻ vẫn có thể dùng trong thời gian hiệu lực. QR và GPS không chứng minh chắc chắn hiện diện; cần ghi rõ giới hạn và có cơ chế rà soát bất thường. Kiosk phải được cấp quyền, hết hạn và thu hồi được.
- Liên kết Auth với nhân viên hiện là thao tác thủ công; phải kiểm tra tài khoản đã liên kết duy nhất, nhân viên đang hoạt động, membership và cửa hàng được phép tại thời điểm quét. Nhân viên không có Auth hiện chưa thể dùng scanner.
- RLS owner/manager hiện bảo vệ PII/lương; mở rộng toàn bộ bảng HR cho staff để làm scanner sẽ lộ dữ liệu. Cần API tự phục vụ giới hạn theo `auth.uid()`, không cho staff đọc lương hay hồ sơ nhân viên khác.
- Không có challenge, chống replay/rate limit, event provenance hoặc khóa chuyển trạng thái check-in/out cho QR. Double click, retry và hai lần quét đồng thời phải được xử lý nguyên tử.
- `work_location` tự do và ca không gắn cửa hàng: chưa thể kiểm tra “đúng cửa hàng”. Không được suy luận từ tên văn bản hay từ kho tồn.
- Trigger hiện tính overtime khi giờ ra sau giờ kết thúc ca; payroll dùng số phút này. Chưa có duyệt tăng ca riêng. Không nên mặc định mọi overtime QR là được trả lương nếu chính sách cần phê duyệt.
- Các cờ đi muộn/về sớm hiện là thông tin chấm công; payroll không áp dụng một khoản phạt riêng từ `late_minutes` hay `early_leave_minutes`. Không tự thêm quy tắc trừ lương trong luồng QR.
- `adjust_hr_attendance` có thể điều chỉnh dữ liệu sau kỳ lương `APPROVED/PAID`; trigger `hr_reset_unapproved_periods` chỉ mở lại kỳ `CALCULATED/REVIEWED`. Phiếu lương đã duyệt được giữ nguyên, nhưng **chưa có quy trình điều chỉnh lương kỳ sau** cho chênh lệch này.

## PROPOSED ARCHITECTURE (initial audit; implementation update below)

```text
Kiosk được quản lý tại cửa hàng
  → RPC phát challenge ngẫu nhiên, hết hạn sau khoảng 30 giây
  → QR chỉ chứa challenge/phiên công khai tối thiểu
Nhân viên đăng nhập và quét QR
  → RPC tra nhân viên bằng auth.uid(), kiểm tra workspace/site/ca/challenge
  → ghi event CHECK_IN/CHECK_OUT bằng giờ server trong một transaction
  → cập nhật bản nháp hr_attendance hiện hữu
Owner/manager rà soát và xác nhận hr_attendance
  → payroll hiện hữu lấy bản xác nhận; không lấy event thô để tính lương
```

- Giữ `hr_attendance` làm **tóm tắt nghiệp vụ** duy nhất cho ca/ngày, không lập hệ thống lương/chấm công song song. Bổ sung event bất biến cho bằng chứng quét; các sự kiện ghi workspace, employee, site, schedule, loại CHECK_IN/CHECK_OUT, `clock_timestamp()` từ server, phương thức, kiosk/challenge, kết quả xác thực, request ID và audit. Dữ liệu manual correction tiếp tục qua RPC điều chỉnh hiện có và phải phân biệt với quét thật.
- Phương thức triển khai trước là `DYNAMIC_QR`; `KIOSK` hoặc `MANUAL_CORRECTION` phải có nguồn và quyền riêng. `RFID/NFC` chỉ là khả năng mở rộng sau này, không thuộc phạm vi bản QR đầu tiên.
- Định nghĩa cửa hàng HR có FK workspace và gán nhân viên/ca tới site bằng quy tắc hiệu lực rõ ràng. Chỉ khi doanh nghiệp xác nhận warehouse cũng chính là cửa hàng vật lý mới cân nhắc tái sử dụng; audit hiện chưa chứng minh điều đó.
- Kiosk do owner/manager kích hoạt qua phiên giới hạn thời gian và có thể thu hồi; máy hiển thị không giữ service-role key. Challenge do server phát, ràng buộc workspace/site/kiosk, TTL khoảng 30 giây, lưu token hash hoặc định danh không tiết lộ bí mật quản trị. Một challenge có thể được nhiều nhân viên dùng trong 30 giây; chống replay theo **nhân viên + challenge + hành động**, không vô hiệu hóa challenge toàn cục sau người quét đầu tiên.
- RPC quét dùng server time và timezone `Asia/Ho_Chi_Minh` để tìm ca đúng, kể cả ca qua đêm; khóa theo nhân viên/ca, xác nhận state transition, rate limit, ghi event và cập nhật nháp nguyên tử. Retry với cùng request ID trả kết quả cũ; quét lặp khác request ID không tạo thêm giờ/công.
- Scanner là route tự phục vụ riêng cho nhân viên có Auth liên kết; chỉ đọc trạng thái/lịch sử **của chính họ**. Manager dashboard/kiosk vẫn tận dụng shell, components và tab HR hiện có. Nhân viên chưa có đăng nhập tiếp tục quy trình quản lý nhập tay; kiosk/PIN không được tự mở mà thiếu chính sách riêng.
- Không tự xác nhận chấm công hoặc trả lương chỉ vì một QR được quét. Bản thiếu giờ ra vẫn là nháp; nghỉ, break và overtime chịu quy tắc server/duyệt hiện hành hoặc chính sách mới được chốt rõ trước khi ảnh hưởng lương.

## PAYROLL INTEGRATION

- `calculate_payroll` (`019`, được `020` mở rộng) đòi mỗi ca có `hr_attendance` đã xác nhận, kiểm tra phút hợp lệ, lấy giờ thường/OT, phép được duyệt, hợp đồng tháng/giờ, hệ số OT và thành phần lương. Check-in/out QR chỉ cập nhật **nháp** rồi đi qua cửa xác nhận hiện tại.
- Bản tính `CALCULATED/REVIEWED` được mở lại khi nguồn chấm công thay đổi; `APPROVED/PAID` và snapshot phiếu lương không được tính lại tại chỗ. Nếu phát hiện sửa sau duyệt, cần ghi chênh lệch và thiết kế quy trình điều chỉnh kỳ sau trước khi cho phép quy trình này vận hành trọn vẹn.
- Giữ đúng hợp đồng/kỳ đã cấu hình; không suy đoán mẫu số ngày công, chính sách nghỉ, nghỉ giữa ca, hệ số OT hay lương của ca thiếu checkout. QR không ghi cash ledger và không tạo thêm chi phí lương.

## SCHEMA GAPS IDENTIFIED DURING AUDIT

| Khoảng trống đã xác minh | Hướng bổ sung cần thẩm định ở A2/A3 |
| --- | --- |
| Chưa có cửa hàng HR và quyền nhân viên theo site | Bảng site workspace-scoped, FK ca/site hoặc assignment hiệu lực; không dùng chuỗi `work_location` để cấp quyền. |
| Chưa có event check-in/out nguyên thủy | Bảng event bất biến, index theo workspace/employee/schedule/time, request ID duy nhất theo workspace, FK và audit. |
| Chưa có kiosk/challenge/lifecycle | Phiên kiosk có thể thu hồi; challenge TTL ~30 giây, index expiry, chống replay theo nhân viên/action và rate limit. |
| RLS/RPC chỉ phục vụ quản lý HR | RPC tự phục vụ tra `auth.uid()`; chỉ công khai trạng thái của chính nhân viên, giữ bảng lương/PII manager-only. |
| Chưa có provenance QR trong `hr_attendance` | Liên kết summary với event hoặc source marker và đảm bảo sửa nháp không che mất lịch sử quét. |
| Chưa có duyệt OT / điều chỉnh lương sau APPROVED | Cần quyết định nghiệp vụ và migration riêng khi triển khai; không tự thay đổi phép tính lương. |

Mọi bảng mới (nếu A2 xác nhận cần thiết) phải có `workspace_id`, FK cùng workspace, RLS, index, audit, quyền tối thiểu và migration **mới**. Không sửa `001`–`020` hoặc chạy migration trên production trong Phase 1.

## DECISION A1.5 — CỬA HÀNG VÀ GÁN CA (12/10/2026)

**Đã chốt mô hình kiến trúc; chưa tạo schema hoặc dữ liệu.** Một *attendance site* là một địa điểm làm việc vật lý trong một workspace. Địa điểm này có danh mục HR riêng (`hr_attendance_sites`) với ID ổn định, mã duy nhất chuẩn hóa trong workspace, tên và trạng thái hoạt động/lưu trữ. Không đồng nhất site với `warehouses` của tồn kho; không dùng `hr_employees.work_location` (văn bản tự do) để cấp quyền quét. Nếu ChiDi chỉ có một cửa hàng, vẫn tạo một site rõ ràng thay vì dùng site ngầm định. Tên/mã cửa hàng thực tế phải do owner/manager nhập, không suy ra từ dữ liệu cũ.

| Quan hệ được chọn | Quy tắc nghiệp vụ |
| --- | --- |
| Nhân viên ↔ site | Bảng gán có `workspace_id`, `employee_id`, `site_id`, ngày hiệu lực từ/đến và người gán. Một nhân viên **có thể được phân công nhiều site** cùng kỳ; không cho khoảng hiệu lực trùng lặp của cùng một cặp nhân viên–site. Lịch sử gán được giữ khi kết thúc phân công. |
| Ca → site | Thêm `site_id` **nullable** vào `hr_work_schedules` bằng migration mới. Quản lý chọn site khi lập ca dùng QR. Ca QR phải có site; ca thủ công lịch sử không có site vẫn hợp lệ. Không đổi site sau khi đã có chấm công hoặc sự kiện quét. |
| Kiosk/challenge → site | Phiên kiosk thuộc đúng một site đang hoạt động. Challenge chỉ hợp lệ với site đó; scanner không được tự chọn site khác qua payload. |
| Sự kiện quét → ca và site | Event phải tham chiếu ca cùng workspace, nhân viên, site và `work_date`. Server đối chiếu site của kiosk/challenge = site trên ca = site được gán cho nhân viên theo ngày công của ca. |

**Quy tắc chọn ca:** server dùng khoảng `planned_start_at`/`planned_end_at` và trạng thái check-in/out của ca, không dựa vào ngày hoặc đồng hồ trên điện thoại. Ca qua đêm vẫn giữ `work_date` của ca bắt đầu; quyền site được xét theo `work_date` đó, kể cả checkout sau nửa đêm. Nếu nhiều ca có cửa sổ quét chồng lấn khiến không xác định được ca, từ chối và yêu cầu quản lý sửa lịch; không tự chọn một ca. Mô hình hiện tại chỉ cho một ca/nhân viên/ngày nên không mở thêm split shift ở bước này.

**Quyền và vòng đời:** owner/manager quản lý site, phân công và ca qua RPC theo workspace. Staff có Auth liên kết nhân viên chỉ được dùng RPC quét và xem tối thiểu dữ liệu của chính mình; không mở quyền SELECT trên toàn bảng HR. Nhân viên không có Auth hoặc chưa được gán site/ca thì không đủ điều kiện QR, nhưng quy trình chấm công thủ công hiện hành vẫn dùng được. Lưu trữ site chặn ca/gán/QR mới, không xóa hay thay đổi lịch sử; nếu còn ca tương lai, phải xử lý ca trước khi lưu trữ.

**Chuyển đổi dữ liệu cũ:** giữ nguyên `work_location`, `hr_work_schedules`, `hr_attendance` và payroll đã có. Không backfill `site_id` bằng so khớp tên, không gán site mặc định hàng loạt. Owner/manager lập danh mục site và phân công có hiệu lực từ ngày thực tế; ca cũ `site_id = null` tiếp tục luồng thủ công. QR chỉ bắt đầu cho ca đã được gán site rõ ràng.

**Điều kiện nghiệm thu của mô hình:** sai workspace/site, site hết hiệu lực, thiếu phân công hoặc thiếu ca đều bị chặn phía server; nhân viên nhiều site chỉ quét được tại site của ca; checkout sau nửa đêm vẫn quy về ca gốc; site cũ lưu trữ không làm mất bản chấm công, payroll hay audit. Mỗi mutation của site/phân công phải có actor, thời điểm, lý do khi lưu trữ và kiểm thử RLS/FK.

## IMPLEMENTATION PLAN

| Bước | Gate cần đạt trước khi tiếp tục |
| --- | --- |
| A1 — Audit | Hoàn thành tài liệu này; kiểm tra test chấm công/lương cục bộ. Cloud HR vẫn chưa xác minh. |
| A2 — Event/site model | Áp dụng quyết định A1.5 vào migration mới và kiểm thử FK/RLS/legacy; thiết kế event bất biến, giữ `hr_attendance` làm summary. |
| A3 — QR challenge | Thiết kế kiosk auth, TTL, rotation, replay/rate-limit và kiểm thử đe dọa trước khi thêm scanner. |
| A4 — Kiosk UI | Chỉ hiển thị site/QR/trạng thái phiên; hết hạn và thu hồi được. |
| A5 — Scanner | Route mobile cho nhân viên Auth-linked; xử lý camera permission và fallback an toàn. |
| A6 — Scan RPC | Kiểm tra server-side, state transitions, giờ server, ca qua đêm, retry và đồng thời; ghi event + nháp atomically. |
| A7 — Tóm tắt chấm công | Đối chiếu event với `hr_attendance`, break/late/early/OT/missing checkout; manager xác nhận/điều chỉnh. |
| A8 — Payroll | Kiểm chứng đầu vào tính lương; quyết định riêng duyệt OT và điều chỉnh sau kỳ đã duyệt. |
| A9 — Báo cáo | Lịch sử, ca thiếu, quét bất thường, đối chiếu theo site/nhân viên có phân quyền. |
| A10 — Hardening | RLS, quyền, idempotency/concurrency/replay, UI mobile, regression và smoke test Supabase thật. |

**Bằng chứng kiểm tra Phase 1:** `npm run test:hr-attendance-leave` đạt 12/12 và `npm run test:hr-payroll` đạt 16/16 trên PGlite cục bộ. Chưa có kiểm thử QR hoặc xác minh HR trên Supabase thật; tài liệu hiện hành ghi rõ giới hạn này.

## IMPLEMENTATION UPDATE (13/10/2026)

The A1.5 site decision is implemented locally in additive migration `023_hr_qr_attendance.sql`. Existing `hr_attendance` remains the payroll input; the new immutable QR events are evidence for server-timed draft check-in/out. Site assignments are effective-dated, old site-null shifts remain manual, and kiosk challenges expire after 30 seconds. The manager UI supports site/assignment setup and a kiosk; the employee page supports camera scan and own history. Owner/manager confirmation is still required. `npm run test:hr-qr` passes 16/16 on PGlite, including the draft-to-confirmed-payroll boundary. The real Supabase migration, authenticated browser roles and device camera have **not** been checked.

The initial release does not add kiosk/PIN attendance for employees without Auth, physical-presence proof, separate overtime approval, automatic adjustment of approved/paid payroll, or a new payroll policy. These need their own business rules and verification before expansion.

## NEXT SAFE ACTION

Apply `023` to a staging Supabase project after `017`–`020`, then perform an authenticated owner/manager + staff smoke test on a real kiosk and phone, including wrong-site, expired QR, retry and payroll reconciliation. Use [the operator guide](../HR_QR_ATTENDANCE.md); do not infer cloud success from PGlite.

## ORIGINAL NEXT SAFE ACTION — COMPLETED BY MIGRATION 023

Thiết kế và kiểm thử migration A2 mới cho site, phân công nhân viên, liên kết ca và event bất biến theo quyết định A1.5; không triển khai kiosk/QR trước khi các ràng buộc này đạt kiểm thử.
