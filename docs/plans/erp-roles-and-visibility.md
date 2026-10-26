# Vai trò và phạm vi dữ liệu ChiDi ERP — rà soát 26/10/2026

Tài liệu phân biệt **quyền cũ trong repository** và **mô hình khuyến nghị**. Migration `026_employee_self_access.sql` đã thêm vai trò `employee` tự phục vụ cùng giao diện và bài kiểm tra cục bộ; quyền `staff`/`viewer` cũ vẫn rộng như bảng dưới. Trạng thái migration trên Supabase thật chưa được kiểm chứng. Xem [hướng dẫn cấp quyền](../ERP_ROLES_AND_SELF_SERVICE.md).

## Quyền hiện tại đã xác minh

Trước `026`, workspace chỉ có `owner`, `manager`, `staff`, `viewer` (`001_core.sql`, `002_operations.sql`). Form thành viên gọi `staff` là **Nhân viên lập phiếu** (`src/features/Operations.jsx`). `026` bổ sung `employee` chỉ dùng dữ liệu tự phục vụ; `staff` vẫn là vai trò ERP toàn workspace, không phải vai trò chấm công cá nhân.

| Việc/dữ liệu | `staff` hiện tại | Nguồn |
| --- | --- | --- |
| Tạo/sửa phiếu Thu Chi nháp | Có. Có thể sửa nháp của người khác cùng workspace; không kiểm `created_by` ở `create_cash`. | `001_core.sql`, `create_cash`; `src/App.jsx`, `canDraft` |
| Xóa phiếu Thu Chi nháp | Có, kể cả nháp khác người tạo nếu cùng workspace/trạng thái. | `015_document_corrections.sql`, `delete_draft_document` |
| Ghi sổ Thu Chi | Không; owner/manager mới ghi sổ. | `014_expense_categories.sql`, `post_cash`; `src/App.jsx`, `canPost` |
| Tạo/sửa phiếu nhập nháp | Có; tương tự không giới hạn bản nháp theo người tạo. | `001_core.sql`, `create_purchase` |
| Xem Thu Chi, tài khoản, mua hàng, biến động kho, audit thông thường | Có ở phạm vi workspace do RLS `member_read`; một số chứng từ nhân sự/PDF được che ở migration sau. | `001_core.sql:121-135`, `019_hr_payroll.sql`, `021_pdf_bank_statement_guard.sql` |
| Xem trang Bán hàng | Có cả **doanh số thuần, giá vốn FIFO, lãi gộp** lũy kế và danh sách đơn. | `src/App.jsx`, `src/features/Sales.jsx:121-135`, `006_inventory_reservations.sql`, `get_sales_state` |
| Xem báo cáo tiền | Có thể xem thu, chi, dòng tiền, số dư theo tài khoản và báo cáo kho; wrapper che số tiền khi có chứng từ lương/ứng lương/PDF nhập phù hợp điều kiện. Đây là **dòng tiền**, không đồng nghĩa doanh thu. | `002_operations.sql`, `019_hr_payroll.sql`, `021_pdf_bank_statement_guard.sql`, `src/features/Operations.jsx` |
| Xem lương người khác | Không qua RLS/RPC HR hiện tại. | `019_hr_payroll.sql`, chính sách `hr_manager_read` |

`viewer` cũng đọc nhiều dữ liệu ERP của cả workspace, không phải vai trò nhân viên tự phục vụ. Mọi vai trò trừ HR đều thấy menu chung (`src/App.jsx:665-670`). `cloudRepository.load` còn truy vấn nhiều bảng cốt lõi cho toàn bộ thành viên (`src/lib/repository.js`); vì vậy ẩn menu hoặc KPI không đủ bảo vệ dữ liệu. `manager` có quyền HR/payroll và tài chính rộng toàn workspace, chưa có giới hạn theo cửa hàng/đội và chưa tách người lập–duyệt–trả lương.

## Đối chiếu hệ thống lớn

- [Microsoft Dynamics 365 Finance & Operations](https://learn.microsoft.com/en-us/dynamics365/fin-ops-core/dev-itpro/sysadmin/role-based-security) tổ chức quyền theo **role → duty → privilege → permission**, và tách nhiệm vụ ngân hàng khỏi nhiệm vụ khác; phạm vi dữ liệu có thể giới hạn theo tổ chức.
- [Microsoft Dynamics 365 Commerce](https://learn.microsoft.com/en-us/dynamics365/commerce/copilot-pos-report-insights) nêu ví dụ thu ngân chỉ xem báo cáo POS của **chính mình**, quản lý cửa hàng xem hoạt động POS của **cửa hàng**.
- [Oracle NetSuite Employee Center](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N898173.html) cho nhân viên xem công/phiếu lương, gửi đơn nghỉ, báo cáo chi phí hay đề nghị mua của **chính mình** theo luồng duyệt; đó không phải quyền xem mọi phiếu Thu Chi hoặc doanh thu công ty.
- [OWASP Authorization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html) khuyến nghị quyền tối thiểu, từ chối mặc định và kiểm quyền ở mọi yêu cầu.

Đây là mô hình tham khảo để thiết kế ChiDi, không phải danh sách vai trò bắt buộc phải sao chép nguyên từ sản phẩm khác.

## Chính sách khuyến nghị cho ChiDi

**Nhân viên nào cũng có quyền tự phục vụ cho bản thân; quyền công việc được cấp thêm.** `full_time`/`part_time` là thuộc tính HR, không quyết định quyền ERP. Quyền cần đồng thời xác định **hành động + loại dữ liệu + phạm vi** (`self`, `team`, `site`, `workspace`).

| Vai trò nghiệp vụ | Được làm/xem mặc định | Không cấp mặc định |
| --- | --- | --- |
| Nhân viên tự phục vụ | Quét/chấm công, lịch và giờ của mình, gửi đơn nghỉ/yêu cầu sửa công, phiếu lương **đã duyệt của mình** | Thu Chi, mua hàng, kho, lương người khác, doanh thu toàn công ty |
| Nhân viên bán hàng | Đơn/khách được giao; số lượng và giá bán của ca/đơn mình xử lý; tùy chính sách có doanh số cá nhân | Giá vốn, lãi gộp, doanh thu toàn công ty, ngân hàng, phiếu chi tổng quát |
| Thu ngân | Thu tiền gắn đơn/quầy và đối chiếu quỹ của **ca/quầy mình** nếu có quy trình kiểm soát | Tạo phiếu chi tự do, duyệt/đảo tiền, xem mọi tài khoản ngân hàng |
| Quản lý cửa hàng | Đơn, tồn, ca làm, doanh số của cửa hàng và đội được giao; duyệt theo ngưỡng | Lương toàn công ty, sổ tiền toàn workspace, thay đổi quyền hệ thống |
| Mua hàng/kho | Lập đề nghị/phiếu nhập hoặc tiếp nhận/điều chỉnh đúng kho và nhiệm vụ được giao | Ghi sổ tiền, duyệt chứng từ do mình lập nếu yêu cầu tách nhiệm vụ |
| Kế toán lập phiếu | Lập/phân loại phiếu Thu Chi, import sao kê, đối chiếu theo tài khoản được giao | Tự động ghi sổ/đảo mọi phiếu; xem lương không thuộc nhiệm vụ |
| Người duyệt/ghi sổ tài chính | Ghi sổ, đảo và duyệt trong phạm vi/ngưỡng được giao, có lý do và audit | Tự ý đổi chứng từ đã ghi sổ; nên tách với người lập khi công ty đủ quy mô |
| HR/chấm công | Hồ sơ, ca, nghỉ và duyệt công của đội được giao | Thu Chi và tài khoản ngân hàng nếu không kiêm nhiệm được cấp rõ |
| Payroll | Lập, rà soát, duyệt và chuyển danh sách trả lương theo các quyền tách biệt | Dùng một quyền `manager` chung để vừa đổi hợp đồng vừa duyệt và trả lương |
| Ban điều hành/kiểm toán | KPI doanh thu–chi phí–lợi nhuận, báo cáo/audit theo phạm vi; kiểm toán chỉ đọc | Sửa chứng từ khi chỉ có vai trò báo cáo/kiểm toán |

**Doanh số khác dòng tiền và lợi nhuận.** Nhân viên bán hàng cần thấy số tiền đơn mình xử lý để phục vụ khách; quản lý điểm bán có thể cần doanh số điểm bán. Giá vốn, biên lãi, tổng doanh thu/chi phí toàn công ty và số dư ngân hàng là các quyền báo cáo riêng. Thu ngân ghi nhận thanh toán gắn với đơn bán không đồng nghĩa có quyền lập phiếu Thu Chi bất kỳ. Nhân viên cần hoàn tiền công tác nên tạo **yêu cầu hoàn chi của mình**, qua quản lý/kế toán duyệt, chứ không tạo ngay giao dịch tiền công ty.

## Cách triển khai mà không phá hệ thống hiện có

1. Phê duyệt ma trận nghiệp vụ cho ChiDi: các vai trò thực tế, cửa hàng/đội, ngưỡng tiền, ai được xem doanh số cá nhân/cửa hàng/toàn công ty; kiểm kê tài khoản `staff` đang dùng trước khi thu hẹp quyền.
2. Thêm quyền tự phục vụ riêng và capability theo nghiệp vụ bằng migration **cộng thêm**; tách dữ liệu `self`/`site`/`workspace`. Bảo vệ bảng bằng grants + RLS, RPC kiểm cả hành động và phạm vi; thiết kế read model báo cáo được phân quyền ở server.
3. Chuyển `staff` hiện có sang vai trò phù hợp theo công việc. Quyền tạo nháp Thu Chi phải chỉ dành cho người được giao tài chính, ít nhất giới hạn bản nháp theo người lập/đội và tài khoản; quyền ghi sổ/đảo tách riêng.
4. Thu hẹp `get_sales_state`, báo cáo tiền và `cloudRepository.load` theo quyền; màn hình chỉ hiển thị dữ liệu server đã lọc. Không dựa vào ẩn nút hoặc ẩn menu để bảo mật.
5. Kiểm thử ma trận allow/deny theo tài khoản nhân viên, bán hàng, thu ngân, quản lý cửa hàng, kế toán, HR, payroll, owner và workspace khác; kiểm tra retry/audit, triển khai trên staging trước production.

**Quyết định mặc định đề xuất:** nhân viên `staff` chung **không** được lập Thu Chi tổng quát và **không** xem doanh thu/lãi gộp toàn doanh nghiệp; chỉ người có nhiệm vụ và phạm vi cụ thể mới nhận những quyền đó. Đây là chính sách mục tiêu, **chưa phải quyền thực tế của phiên bản hiện tại**.
