# Vai trò và quyền tự phục vụ trong ChiDi ERP

## Đã triển khai trong repository

Migration `026_employee_self_access.sql` thêm vai trò workspace `employee`. Vai trò này chỉ dùng các RPC tự phục vụ dựa trên `auth.uid()`: quét QR, xem lịch/giờ công của **chính mình** và xem tối đa 12 phiếu lương kỳ `APPROVED`/`PAID` của **chính mình**. Phiếu lương trả về số liệu đã chốt, không trả `source_snapshot` hay dữ liệu của nhân viên khác. Trên web, tài khoản `employee` đi thẳng đến trang **Chấm công của tôi**; ứng dụng không tải toàn bộ bảng ERP bằng `cloudRepository.load`.

RLS/RPC cũ dùng `app_private.member_role` sẽ nhận `NULL` đối với `employee`, nên không cho vai trò này đọc Thu Chi, nhập hàng, kho, đơn bán, audit hoặc báo cáo công ty. Workspace name và membership của chính tài khoản vẫn đọc được để chọn workspace. Đây là ranh giới database; ẩn menu chỉ là UX. PGlite đã kiểm tra migration và một số trường hợp allow/deny; **chưa kiểm tra trên Supabase production**.

| Vai trò hiện có | Sử dụng phù hợp | Giới hạn thực tế trong phiên bản này |
| --- | --- | --- |
| `owner` | Chủ workspace, quản lý thành viên, dữ liệu vận hành và HR | Quyền rộng; chỉ cấp cho người sở hữu thực sự. |
| `manager` | Quản lý toàn workspace, xác nhận nghiệp vụ và HR | Vẫn có quyền tài chính, nhân sự và dữ liệu công ty rộng; chưa giới hạn theo cửa hàng. |
| `staff` | Người vận hành ERP trước đây | **Vẫn** có quyền lập nháp Thu Chi/nhập hàng và đọc nhiều bảng, KPI công ty. Không cấp cho nhân viên chỉ cần chấm công. |
| `viewer` | Người đọc dữ liệu ERP trước đây | **Vẫn** đọc nhiều bảng toàn workspace. Không dùng làm vai trò tự phục vụ. |
| `employee` | Nhân viên tự chấm công, xem giờ công/phiếu lương đã duyệt của mình | Không có quyền ERP chung; chưa có form tự gửi đơn nghỉ hoặc yêu cầu sửa công trong trang này. |

`full_time`/`part_time` là loại **hợp đồng/nhân viên**, không phải quyền hệ thống. Nhân viên part-time dùng `employee` như full-time; mức lương, mẫu ca, phút nghỉ và giờ được duyệt được cấu hình riêng trong HR.

## Cấp tài khoản chấm công an toàn

1. Thử các migration đến `026` trên môi trường staging theo thứ tự. Không chạy lại migration lịch sử và không áp dụng SQL bằng trang web của nhân viên.
2. Nhân viên đăng ký tài khoản ChiDi và xác nhận email. Owner mở **Thiết lập → Thành viên và quyền**, chọn đúng workspace, thêm email với vai trò **Nhân viên · chỉ dữ liệu cá nhân**. Sao chép UUID của thành viên vừa thêm.
3. Owner/manager mở **Nhân sự & Tiền lương → Nhân viên → Sửa → Tài khoản**, dán UUID vào **Auth user ID** rồi lưu. Hồ sơ phải đang hoạt động; một Auth user ID chỉ liên kết một hồ sơ trong mỗi workspace.
4. Gán nhân viên vào **cửa hàng chấm công** và lịch/ca có hiệu lực. Mở kiosk QR bằng tài khoản owner/manager trên thiết bị được quản lý.
5. Nhân viên đăng nhập trên điện thoại, quét giờ vào/ra ở **Chấm công của tôi**. Giờ quét là giờ server; quản lý xác nhận công và duyệt tăng ca riêng. Sau khi kỳ lương được duyệt, nhân viên mới thấy phiếu lương của mình.

Nếu hiển thị `HR_QR_EMPLOYEE`, kiểm tra membership đúng workspace, UUID liên kết và hồ sơ đang hoạt động. Không giải quyết lỗi bằng cách nâng người đó lên `staff`.

## Ma trận quyền mục tiêu cho doanh nghiệp lớn

Ma trận sau là **thiết kế tiếp theo, chưa được migration 026 thực thi**. Cần kiểm tra RLS, SECURITY DEFINER RPC và mọi truy vấn REST trước khi bật một capability; không được dùng việc ẩn nút/menu làm kiểm soát duy nhất.

| Nhiệm vụ | Phạm vi nên cấp | Không tự động đi kèm |
| --- | --- | --- |
| Bán hàng | Đơn được giao hoặc cửa hàng; thao tác hoàn tất đơn theo ca | Giá vốn, lãi gộp, doanh thu toàn công ty, số dư ngân hàng |
| Thu ngân | Thanh toán gắn đơn/quầy được giao | Phiếu chi tự do, tất cả tài khoản tiền, đảo chứng từ |
| Kho/mua hàng | Kho/cửa hàng được giao; lập nháp và xem chứng từ cần xử lý | Ghi sổ tiền, HR/payroll, báo cáo lợi nhuận |
| Kế toán lập phiếu | Tạo/phân loại Thu Chi và nhập sao kê của tài khoản được giao | Duyệt/đảo giao dịch của chính mình không qua kiểm soát |
| Kế toán duyệt | Ghi sổ/đảo theo giới hạn và audit | Sửa trực tiếp ledger đã ghi |
| HR | Hồ sơ, lịch, nghỉ, công của nhóm được giao | Thu Chi, ngân hàng, giá vốn |
| Payroll | Lập/rà soát/dành quyền duyệt trả lương tách biệt | Truy cập mặc định cho mọi manager cửa hàng |
| Kiểm toán/ban điều hành | Báo cáo, audit chỉ đọc theo phạm vi | Quyền sửa hoặc tạo chứng từ |

ChiDi hiện chưa có đủ phạm vi `self/team/site/workspace`, capability theo nhiệm vụ hay tách người lập–người duyệt trên toàn bộ nghiệp vụ. Trước khi đổi `staff`/`viewer` đang dùng, owner cần kiểm kê tài khoản và việc họ thực hiện; thay đổi hàng loạt mà không kiểm tra sẽ làm gián đoạn công việc. Bước tiếp theo là thêm capability/RLS/RPC cho **từng miền** (bắt đầu Thu Chi và KPI bán hàng), có migration chuyển tiếp và bài kiểm tra allow/deny cho từng vai trò. Xem phân tích chi tiết tại [kế hoạch phân quyền](plans/erp-roles-and-visibility.md).

## Kiểm thử và triển khai

- `npm run test:erp-access`: áp dụng 001–026 trong PGlite, kiểm tra `employee` chỉ thấy workspace của mình, lịch công và phiếu lương đã duyệt của mình, không đọc trực tiếp bảng ERP, không truy cập workspace khác, và có thể qua bước kiểm tra quyền quét QR.
- `npm run build`: kiểm tra giao diện React build được.
- Trên staging Supabase, thử tài khoản owner, manager, staff, viewer, employee và outsider riêng; kiểm tra REST/RPC bằng DevTools hoặc client thử nghiệm. Đặc biệt kiểm tra tài khoản employee không xem được dữ liệu công ty qua URL/RPC trực tiếp.
- Chưa coi PGlite là bằng chứng production RLS hoặc camera/kiosk thực tế. Không áp dụng migration lên production trong quá trình viết tài liệu này.
