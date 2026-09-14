# Thiết lập và vận hành ChiDi ERP V1.1

Ngày cập nhật: **11/09/2026**. Tài liệu này tiếp nối [hướng dẫn Supabase V1](SUPABASE_SETUP.md), dành cho project đã chạy `001_core.sql` và đã điền `.env.local`.

Bạn đã cho biết hoàn tất bước 1–6. Kiểm tra chỉ đọc ngày 11/09/2026 đã kết nối được dịch vụ Auth, xác nhận có các bảng nền và thấy API từ chối người chưa đăng nhập đọc dữ liệu ERP. Việc tiếp theo là chạy migration V1.1, đăng nhập bằng tài khoản thật, chọn workspace và thử nghiệp vụ. Những kiểm tra chỉ đọc này chưa xác nhận luồng đăng nhập hoặc dữ liệu đã được ghi đúng trên cloud.

**Trạng thái tài liệu:** code V1.1 đã hoàn thành đợt nâng cấp và qua 97 kiểm tra tự động; kết nối cloud đã kiểm tra chỉ đọc. Migration 002 và nghiệm thu đăng nhập thật còn chờ. Kết quả chi tiết ở [CHANGELOG](CHANGELOG.md) và [VERIFICATION](VERIFICATION.md), không dùng kiểm thử mô phỏng thay nghiệm thu tài khoản của bạn.

## 1. Hiểu bốn khái niệm trước khi tiếp tục

| Khái niệm | Cách hiểu và thao tác |
|---|---|
| Supabase project | Nơi chứa database và tài khoản đăng nhập của ứng dụng. Chọn đúng project đã chạy SQL V1. |
| Tài khoản ChiDi | Email/mật khẩu đăng nhập ERP; khác phiên đăng nhập Supabase Dashboard. |
| Workspace | Bộ dữ liệu của một shop/đơn vị trong ERP. Mỗi phiếu, sản phẩm, tài khoản tiền thuộc một workspace. |
| Vai trò | Quyền thao tác trong workspace: chủ shop, quản lý, nhân viên hoặc chỉ xem. Không phải quyền quản trị hạ tầng Supabase. |

Một người có thể tham gia nhiều workspace. Trước khi nhập dữ liệu, tạo phiếu hoặc cấp thành viên, luôn nhìn tên workspace đang mở. Chuyển workspace chỉ thay bộ dữ liệu đang xem; không chuyển chứng từ từ shop này sang shop khác.

## 2. Chạy migration bổ sung một lần

1. Mở **Supabase Dashboard**, chọn đúng project đã chạy `001_core.sql`.
2. Mở **SQL Editor → New query**. Không sửa query V1 đã lưu trước đó.
3. Mở [002_operations.sql](../supabase/migrations/002_operations.sql) trong project ChiDi, sao chép toàn bộ nội dung.
4. Dán vào query mới. Kiểm tra lại tên project rồi nhấn **Run** một lần.
5. Nếu chạy thành công, lưu query với tên gợi ý `ChiDi 002 operations 2026-09-11` để biết lần nâng cấp đã thực hiện.
6. Nếu có lỗi, giữ nguyên lỗi và dừng bước nâng cấp để xác định nguyên nhân. Không xóa bảng hoặc tạo project mới chỉ để làm mất thông báo lỗi.

**Không chạy lại `001_core.sql`, không dùng `DROP TABLE`, không xóa dữ liệu đang có.** `002_operations.sql` là phần bổ sung sau V1. Project chưa từng có V1 phải làm hướng dẫn cài đặt ban đầu trước; project đã có V1 chỉ chạy phần bổ sung này.

Không tắt RLS hoặc cấp quyền ghi bảng công khai để chữa lỗi. Chức năng trên ứng dụng đi qua RPC, là các hàm database kiểm tra quyền và thực hiện nghiệp vụ.

## 3. Khởi động đúng chế độ online

1. Giữ `.env.local` tại thư mục gốc project. Không chia sẻ ảnh hoặc nội dung file có giá trị cấu hình.
2. Nếu ứng dụng đang chạy, dừng đúng cửa sổ lệnh bằng **Ctrl+C**.
3. Mở lại [START_CHIDI.cmd](../START_CHIDI.cmd).
4. Mở **http://localhost:2000**. Bản V1.1 đồng bộ cổng chạy ứng dụng với Site URL bạn đã chọn.
5. Kiểm tra giao diện hiển thị đăng nhập hoặc nhãn **Supabase online**, tùy bạn đã có phiên đăng nhập hay chưa.

Frontend dùng `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` và `VITE_DEMO_MODE=false`. Không điền mật khẩu database, `sb_secret_...` hoặc `service_role` vào biến frontend.

**Site URL và Redirect URLs trong Supabase phải phù hợp với địa chỉ bạn thực sự dùng để mở ERP.** Với lần chạy này, dùng `http://localhost:2000` cho Site URL và thêm URL này vào danh sách redirect được phép. Các ví dụ cũ dùng cổng 5173 không phải địa chỉ chạy của V1.1. Bộ kiểm thử tự động dùng cổng riêng và demo; không lấy địa chỉ kiểm thử làm Site URL.

Nếu đã có một website thật tại `chidivibes.vn`, chỉ dùng URL tên miền khi website đã được triển khai và cấu hình đúng. Việc xuất hiện tên miền trong tài liệu không xác nhận website đã được xuất bản.

Không đổi cấu hình tên miền đang vận hành chỉ vì một ví dụ trong tài liệu. Đối chiếu địa chỉ thực tế và môi trường muốn kiểm tra trước.

## 4. Hoàn tất đăng nhập và workspace

Nếu bước 7 của hướng dẫn V1 chưa thực hiện:

1. Chọn **Tạo tài khoản** trên ChiDi; dùng email của bạn và mật khẩu dành cho ERP.
2. Hoàn tất xác nhận email nếu project yêu cầu. Email đăng ký Supabase Dashboard không tự tạo tài khoản trong ứng dụng ChiDi.
3. Đăng nhập ChiDi. Nếu chưa tham gia workspace nào, tạo workspace tên dễ nhận biết, ví dụ `ChiDi — Thử nghiệm`.
4. Người tạo workspace có vai trò chủ shop. Workspace đã có dữ liệu phải được chọn lại; không tạo workspace mới để thay cho dữ liệu đang cần tìm.
5. Khi tài khoản có nhiều workspace, dùng bộ chọn workspace để chuyển đúng nơi làm việc.
6. Tải lại trang và xác nhận đang xem đúng workspace, đúng vai trò và đúng danh mục.

Kho chính và tài khoản tiền nền là danh mục ban đầu. Giá trị số dư đầu chưa được đối chiếu không trở thành số dư thật chỉ vì tài khoản đã được tạo.

Nếu không nhận email, kiểm tra cấu hình email và giới hạn gửi trong [hướng dẫn Supabase](SUPABASE_SETUP.md). Tính năng quản lý thành viên ERP không tự cấu hình SMTP và không thay cho xác nhận email.

## 5. Thêm người làm cùng shop

Luồng quản lý nhóm của V1.1 là **cấp quyền cho tài khoản đã đăng ký trong cùng Supabase project**. Đây không phải tính năng gửi thư mời.

1. Thành viên tự đăng ký tài khoản ChiDi, **xác nhận email**, rồi đăng nhập theo cấu hình Auth của project. Tài khoản chưa xác nhận email chưa đủ điều kiện được thêm.
2. Chủ shop đăng nhập, chọn đúng workspace, mở phần quản lý thành viên trong **Thiết lập**.
3. Nhập email tài khoản đã đăng ký và chọn vai trò cần dùng.
4. Kiểm tra lại email, workspace và vai trò trước khi lưu. Không thêm người vào Supabase Organization chỉ để cho họ sử dụng ERP.
5. Thành viên đăng nhập hoặc tải lại ứng dụng, chọn workspace vừa được cấp quyền.
6. Thử bằng chính tài khoản thành viên để xác nhận phạm vi xem và thao tác.

**Ứng dụng không tự gửi email mời thành viên.** Việc nhập email trong màn hình này chỉ tra tài khoản đã tồn tại, đã xác nhận email và cấp quyền trong workspace. Nếu hệ thống không tìm thấy tài khoản đủ điều kiện, kiểm tra email, trạng thái xác nhận và project đăng ký; không tự tạo mật khẩu hoặc tài khoản dùng chung cho người khác.

Danh sách nhóm hiển thị email đã che một phần để hạn chế lộ thông tin. Muốn đổi quyền người đã có, dùng thao tác đổi vai trò. Khi cần thu hồi, dùng thao tác xóa thành viên khỏi workspace; đây không phải xóa tài khoản Auth hoặc xóa chứng từ họ từng tạo. Hệ thống chặn tự xóa membership và chặn mất chủ shop cuối cùng. Chủ shop chỉ có thể tự hạ quyền khi còn chủ shop khác trong workspace.

| Vai trò | Dùng cho công việc nào | Quyền nghiệp vụ nền V1 |
|---|---|---|
| Chủ shop — `owner` | Chủ dữ liệu và người chịu trách nhiệm vận hành | Quản lý nhóm, danh mục, số dư đầu, nhập dữ liệu, ghi sổ và đảo chứng từ |
| Quản lý — `manager` | Người kiểm tra và duyệt công việc hàng ngày | Danh mục thông thường, tạo nháp và ghi sổ; không quản lý số dư đầu hoặc đảo theo quyền V1 |
| Nhân viên — `staff` | Người nhập liệu | Tạo/sửa nháp trong phạm vi được cấp; không ghi sổ |
| Chỉ xem — `viewer` | Người theo dõi | Xem dữ liệu được cấp; không tạo hoặc sửa chứng từ |

Cấp quyền tối thiểu cần thiết. Quản lý nhóm phải do chủ shop thực hiện; thử trường hợp sửa vai trò hoặc thu hồi thành viên bằng tài khoản không phải chủ shop để xác nhận máy chủ từ chối. Không coi việc ẩn một nút trên giao diện là bằng chứng phân quyền đủ.

## 6. Đọc báo cáo và phân biệt số liệu

V1.1 bổ sung hàm lấy số tổng hợp từ database để báo cáo trong chế độ online dùng cùng phạm vi workspace và kỳ. Một lần tải báo cáo lấy tổng quan, tài khoản, nhóm tiền, phát sinh nhập theo SKU và các cảnh báo từ cùng một lần đọc dữ liệu. Báo cáo vẫn dựa trên các nghiệp vụ hiện có: nhập kho và thu chi đã ghi sổ.

| Số liệu | Ý nghĩa |
|---|---|
| Nháp/chờ đối chiếu | Thông tin đã lưu, chưa làm tăng kho hoặc thay đổi dòng tiền đã ghi |
| Phát sinh nhập kho | Chuyển động do phiếu nhập đã ghi sổ, có tính phát sinh đảo theo ngày |
| Thu, chi trong kỳ | Tiền đã ghi trên tài khoản trong khoảng ngày đã chọn |
| Số dư đến ngày | Số dư đầu đã xác nhận cộng các phát sinh tiền hợp lệ tới ngày chọn |
| Nhóm chi | Phân tích dòng tiền theo loại; chưa phải chi phí kế toán dồn tích đầy đủ |

Nếu tài khoản chưa xác nhận ngày/số dư đầu, báo cáo phải cho thấy phần chưa đủ căn cứ. Không gộp số dư chưa biết thành số dư bằng không đã xác nhận.

Tài khoản mở sổ giữa kỳ phải hiển thị riêng phần số dư được đưa vào trong kỳ; không làm cho số dư này giống tiền thu từ hoạt động bán hàng. Tài khoản có ngày mở sổ sau ngày kết thúc kỳ chưa được tính vào số dư đến ngày đó.

Chọn kỳ → tải báo cáo → mở các chứng từ tạo ra con số đó → so lại tổng. Giữ một phiếu nháp trong bài thử để xác nhận nháp không lọt vào báo cáo đã ghi. Thử ngày trước và sau một phiếu đảo để kiểm tra lịch sử.

V1.1 chưa chứng minh tồn kho khả dụng đầy đủ khi chưa có lịch sử bán/xuất/hoàn, và chưa có giá vốn FIFO bán hay sổ cái kép. Không dùng tổng nhập làm tồn thực tế hoặc tiền thu về làm doanh thu đã xác nhận.

## 7. Nhập dữ liệu riêng của ChiDi

1. Hoàn tất thử đăng nhập, quyền và nghiệp vụ với vài phiếu thử trước khi nhập file riêng.
2. Chọn đúng workspace nhận dữ liệu. Đọc lại tên workspace trên giao diện.
3. Mở **Đối chiếu dữ liệu**, chọn JSON cần nhập từ thư mục `data/`.
4. Xem trước số lượng và tổng. Bản `chidi-import-2026-09-10.json` đã bàn giao có 17 dòng nhập hàng, 1.566 sản phẩm, 79.043.000 đ tiền hàng và 12 dòng thu chi. Nếu dùng file xuất mới, so với số mới của chính file đó.
5. Nhấn nhập vào workspace hiện tại. Đây là thao tác đưa dữ liệu đã chọn lên cloud; ứng dụng không tự tải toàn bộ thư mục `data/`.
6. Kiểm tra lịch sử nhập, số dòng thêm, dòng bỏ qua và xung đột. Nhập lại cùng dữ liệu không được nhân đôi chứng từ.
7. Giữ nguyên nháp với SKU tạm, ngày ước tính, khoản chi chưa biết tài khoản hoặc chưa đủ chứng từ. Chỉ ghi sổ sau khi đối chiếu.

Dữ liệu tháng 9 đã có trong workbook sau bản tháng 8. Không gán tất cả giao dịch về tháng 8. Ngày nhập được chọn theo ước tính trước đây vẫn là ngày ước tính. Hai dòng nguồn đánh dấu đã ghi cũng tiếp tục qua hàng chờ của website để tránh nhận nhầm trạng thái nguồn thành kết quả nghiệm thu.

Không đổi mã nguồn để né cảnh báo xung đột hoặc nhập cùng dữ liệu vào nhiều workspace rồi cộng báo cáo. File Excel gốc phải được giữ nguyên để đối chiếu.

## 8. Bài kiểm tra cloud cần hoàn tất

Các mục dưới đây là việc cần làm với project Supabase thật, **không phải danh sách đã đạt**.

| Bài thử | Kết quả cần thấy | Bằng chứng nên lưu |
|---|---|---|
| Migration 002 | Query thành công trong đúng project; dữ liệu V1 giữ nguyên | Tên project, thời điểm, trạng thái chạy SQL; không lưu secret |
| Auth | Đăng ký, xác nhận email, đăng nhập/đăng xuất hoạt động đúng URL | Tài khoản thử và kết quả, không ghi mật khẩu/token |
| Workspace | Chọn đúng workspace; dữ liệu workspace khác không lẫn vào | Tên workspace và tổng trước/sau chuyển |
| Thành viên | Chủ shop thêm tài khoản đã có; tài khoản khác không tự nâng quyền | Vai trò trước/sau và lỗi từ chối quyền |
| Quyền API | Gọi API/RPC bằng người không có quyền bị từ chối | Mã phản hồi, không lưu Authorization header |
| Ghi sổ | Nháp không tạo sổ; ghi sổ một lần; gửi lại không tăng thêm | Mã phiếu và số phát sinh trước/sau |
| Báo cáo | Tổng theo đúng workspace/kỳ; ngày đảo ảnh hưởng đúng kỳ | Tổng độc lập so với báo cáo |
| Nhiều người | Hai phiên gửi cùng chứng từ không tạo hai phát sinh | Kết quả của hai phiên và số dòng ledger |
| Sao lưu/khôi phục | Khôi phục bản sao sang môi trường thử và đối chiếu tổng | Thời điểm backup, nơi khôi phục và kết quả |

Kiểm thử trên máy có thể kiểm quy tắc và SQL, nhưng không thay cho Supabase Auth thật, cấu hình email, JWT/REST, nhiều kết nối và khôi phục cloud. Khi chưa có kết quả, giữ trạng thái “chưa kiểm chứng”.

## 9. Xử lý vướng mắc thường gặp

| Hiện tượng | Việc làm tiếp |
|---|---|
| Ứng dụng báo thiếu nâng cấp database | Kiểm tra `002_operations.sql` đã chạy trong cùng project cấu hình frontend; không rerun V1 |
| Vẫn hiện chế độ demo | Kiểm chế độ và khởi động lại Vite; demo và cloud không đồng bộ ngầm |
| Đăng nhập được nhưng không thấy shop | Kiểm membership và workspace; tài khoản mới không tự có quyền xem shop cũ |
| Không tìm thấy email thành viên | Người đó phải đăng ký trong đúng Supabase project; kiểm chính tả email |
| Thành viên không có nút ghi sổ | Kiểm vai trò; staff/viewer không được ghi sổ theo thiết kế |
| Báo cáo chưa có số | Kiểm kỳ, workspace, trạng thái đã ghi và số dư đầu; đừng ghi sổ nháp chỉ để làm đầy dashboard |
| Xác nhận email mở nhầm cổng/tên miền | Đối chiếu URL thực chạy với cấu hình Auth; không lấy ví dụ tài liệu làm URL vận hành mặc định |
| Lỗi quyền khi sửa bảng trực tiếp | Dùng nghiệp vụ trên ứng dụng; không nới quyền RLS/grants |

## 10. Thói quen vận hành hàng ngày

Đầu ngày chọn đúng workspace và kỳ. Nhập liệu thành nháp, đối chiếu chứng từ, rồi người có quyền ghi sổ. Cuối ngày so thu chi với tài khoản thực, xem phiếu chờ và lịch sử thay đổi. Khi sửa sai chứng từ đã ghi, dùng nghiệp vụ đảo có lý do, giữ bản gốc để truy lại.

Database cần bản sao ngoài project và cần thử khôi phục. Bản demo trong trình duyệt hoặc CSV một màn hình không thay cho backup PostgreSQL. Các phân hệ bán hàng, vận chuyển/COD, công nợ, kế toán kép, thuế, lương và tài sản tiếp tục theo [kiến trúc ERP](KIEN_TRUC_ERP_CHIDI.md); chỉ chuyển thành chức năng vận hành sau khi có code và nghiệm thu tương ứng.
