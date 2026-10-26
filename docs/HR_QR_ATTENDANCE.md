# Chấm công QR ChiDi — thiết lập và sử dụng

Tính năng này dùng ca làm và bảng chấm công hiện có của ChiDi ERP. Một lần quét QR ghi **giờ server** vào bản chấm công **nháp**; owner/manager vẫn xác nhận bản chấm công trước khi tính lương. QR không tự trả lương, không tạo phiếu Thu Chi và không sửa phiếu lương đã duyệt.

> **Trạng thái triển khai:** mã và migration QR mới được kiểm thử cục bộ trong repository. Chưa có bằng chứng migration đã được áp dụng hoặc kiểm tra trên Supabase thật. Không dùng để ghi công chính thức trước khi hoàn tất bước kiểm thử triển khai bên dưới.

> **Lưu ý quyền dữ liệu:** từ migration `026`, tài khoản chỉ cần chấm công và xem phiếu lương của mình dùng vai trò `employee`. Vai trò này không đọc các bảng ERP chung; `staff` và `viewer` cũ vẫn có quyền đọc rộng và không thích hợp cho nhân viên chỉ dùng tự phục vụ. Chưa có bằng chứng `026` đã áp dụng trên Supabase thật. Xem [vai trò và hướng dẫn cấp quyền](ERP_ROLES_AND_SELF_SERVICE.md).

## 1. Điều kiện chuẩn bị

1. Đăng nhập workspace Supabase bằng tài khoản **owner/manager**. Workspace cần có các migration HR `017`–`020`, `023`–`025` và `026_employee_self_access.sql` cho vai trò `employee`, mỗi file một lần theo thứ tự migration của dự án. Sao lưu, thử trên môi trường kiểm tra và xác minh trạng thái migration trước khi áp dụng lên dữ liệu thật. Không chạy lại `001`–`003` hoặc chạy migration từ giao diện web.
2. Tạo hồ sơ nhân viên trong **Nhân sự & Tiền lương → Nhân viên**. Để tự quét QR, nhân viên phải có tài khoản Supabase là thành viên của **cùng workspace**, được liên kết với hồ sơ qua trường Auth user ID, và hồ sơ đang hoạt động. Tạo hồ sơ không tự tạo tài khoản đăng nhập.
3. Dùng HTTPS hoặc `localhost` cho trang quét để browser cho phép camera. Trên thiết bị không có camera hoặc chưa được cấp quyền, owner/manager tiếp tục nhập chấm công thủ công theo [hướng dẫn HR](HR_PAYROLL_SETUP.md).

### Liên kết tài khoản đăng nhập với hồ sơ nhân viên

1. Nhân viên tự đăng ký và xác nhận email đăng nhập ChiDi. Việc tạo hồ sơ nhân viên không tạo tài khoản đăng nhập.
2. **Owner** chọn đúng workspace, mở **Thiết lập → Thành viên và quyền**, nhập email đã xác nhận và giữ lựa chọn mặc định **Nhân viên · chỉ dữ liệu cá nhân (`employee`)**. Không dùng `viewer` hoặc `staff` cho nhân viên chỉ chấm công. Sau khi thêm, sao chép **UUID hiển thị dưới email** trong danh sách thành viên; đây là Auth user ID, không phải mã nhân viên.
3. **Owner/manager** mở **Nhân sự & Tiền lương → Nhân viên → Xem/sửa → Tài khoản**, dán UUID vào **Auth user ID** rồi bấm **Lưu hồ sơ**. Hồ sơ cần chưa lưu trữ và có trạng thái **Đang làm việc**. Email trong hồ sơ chỉ là thông tin liên hệ, không tự tạo liên kết Auth.
4. Nhân viên đăng nhập lại hoặc tải lại trang, chọn **cùng workspace** và mở **Chấm công của tôi**. Mỗi Auth user ID chỉ liên kết được với một hồ sơ nhân viên trong một workspace. Nếu owner xóa thành viên khỏi workspace, hệ thống tự gỡ liên kết nhưng giữ hồ sơ và lịch sử chấm công.

Nếu vẫn thấy `HR_QR_EMPLOYEE`, kiểm tra UUID đã dán khớp với **thành viên của workspace đang chọn**, vai trò là `employee`, và hồ sơ không ở trạng thái tạm nghỉ/nghỉ việc/lưu trữ. Sau khi liên kết thành công, nhân viên vẫn cần được gán vào cửa hàng và có ca phù hợp để quét QR.

## 2. Thiết lập cửa hàng, nhân viên và ca

1. Owner/manager mở **Nhân sự & Tiền lương → Cửa hàng & QR** (`#/hr/qr`), thêm cửa hàng bằng **mã** và **tên**. Đây là địa điểm chấm công; kho hàng của nghiệp vụ tồn kho không tự trở thành cửa hàng chấm công. Nếu chỉ có một địa điểm, vẫn thêm một cửa hàng thật.
2. Trong cùng màn hình, **gán nhân viên vào cửa hàng** với ngày hiệu lực từ/đến. Có thể gán một nhân viên cho nhiều cửa hàng. Không dùng chữ trong trường “Cửa hàng / nơi làm” của hồ sơ cũ làm quyền quét.
3. Với một ngày riêng lẻ, mở **Chấm công** (`#/hr/attendance`), tạo ca có ngày, giờ bắt đầu/kết thúc, phút nghỉ và chọn **Cửa hàng chấm công QR**. Với lịch lặp cho nhiều nhân viên, dùng **Ca làm việc** (`#/hr/schedule`) theo [hướng dẫn lịch lặp](HR_RECURRING_SCHEDULES.md). Ca qua đêm dùng ngày công của lúc bắt đầu ca tại Việt Nam. Nếu đã có ca chưa gắn cửa hàng, quản lý có thể gắn cửa hàng trước khi phát sinh chấm công.
4. Kiểm tra ca, nhân viên và cửa hàng trước khi mở kiosk. Ca lịch sử không gắn cửa hàng vẫn dùng chấm công thủ công; hệ thống không đoán cửa hàng từ dữ liệu cũ.

## 3. Mở màn hình QR tại cửa hàng

1. Owner/manager đăng nhập trên thiết bị dùng làm kiosk, mở **Cửa hàng & QR**, chọn đúng cửa hàng rồi bấm **Mở kiosk**.
2. Màn hình hiển thị mã QR ngắn hạn và tự lấy mã mới khoảng mỗi 26 giây. Nhân viên quét bằng **ứng dụng ChiDi của chính mình**. Mã QR không chứa tên nhân viên, mã nhân viên hay mật khẩu.
3. Khi kết thúc ca vận hành, bấm **Dừng kiosk**. Phiên kiosk cũng tự hết hạn theo thời gian server. Nếu trang đóng hoặc mạng mất, cần kiểm tra trạng thái và mở phiên mới khi cần; không dùng ảnh QR cũ.

**Bảo vệ thiết bị kiosk:** chỉ dùng thiết bị do cửa hàng quản lý, khóa màn hình khi không giám sát và đăng xuất sau ca. Phiên web kiosk hiện chạy dưới tài khoản owner/manager nên không để thiết bị đăng nhập mở ở nơi công cộng. QR tự đổi không chứng minh chắc chắn người quét có mặt vật lý nếu ảnh mã bị chia sẻ; quản lý vẫn cần rà soát bất thường.

## 4. Nhân viên quét giờ vào và giờ ra

1. Nhân viên đăng nhập ChiDi bằng tài khoản đã liên kết hồ sơ, chọn đúng workspace, mở **Chấm công của tôi** (`#/my-attendance`) trên điện thoại.
2. Khi đến ca, bấm **Quét giờ vào**, cho phép camera rồi hướng vào QR đang hiển thị ở kiosk đúng cửa hàng. Chờ thông báo server ghi nhận; không dùng giờ trên điện thoại làm giờ công.
3. Khi rời ca, bấm **Quét giờ ra** và quét QR mới. Ca qua nửa đêm vẫn thuộc ngày công của ca ban đầu. Xem kết quả trong **Lịch sử của tôi**; bản thiếu giờ ra vẫn là nháp và chưa được tính lương.
4. Nếu mất mạng hoặc không nhận phản hồi, kiểm tra lịch sử rồi thử lại theo hướng dẫn trên màn hình. Không quét bằng tài khoản người khác. Quét lặp không được tạo thêm lần vào/ra cho cùng ca.

Tài khoản chưa liên kết nhân viên, nhân viên/cửa hàng không hoạt động, chưa được gán cửa hàng, chưa có ca phù hợp, QR hết hạn, sai cửa hàng hoặc đã quét hành động đó sẽ bị từ chối. Với lịch lặp, `025` yêu cầu server tạo ca hợp lệ cho hôm qua/hôm nay/ngày mai trước khi xử lý lần quét; không cần quản lý mở trang lịch để quét được ca đã phân công. Nhân viên không có tài khoản đăng nhập tiếp tục dùng quy trình quản lý ghi nhận thủ công; chưa có kiosk/PIN thay thế.

## 5. Quản lý xác nhận và đối chiếu lương

1. Mở **Chấm công** để xem giờ vào/ra, phút nghỉ, đi muộn, về sớm và **ngoài giờ ghi nhận**. Xử lý ca thiếu giờ ra trước khi xác nhận. Nếu có sai sót sau xác nhận, dùng **Điều chỉnh** kèm lý do để giữ lịch sử trước/sau.
2. Xác nhận bản chấm công hợp lệ. `calculate_payroll` hiện yêu cầu mọi ca trong kỳ có bản chấm công đã xác nhận; không tự coi ca chưa ghi là vắng.
3. Với `025`, mở **Duyệt tăng ca** (`#/hr/overtime`), chọn số phút được duyệt từ `0` đến số phút ngoài giờ đã xác nhận và nhập lý do. Tính lương theo hợp đồng/kỳ đã cấu hình như [hướng dẫn HR](HR_PAYROLL_SETUP.md). Server chặn tính lương khi còn tăng ca chưa được duyệt; chỉ số phút được duyệt riêng mới sinh tiền tăng ca.
4. Nếu chấm công được sửa **sau khi bảng lương đã APPROVED/PAID**, phiếu lương đã duyệt không tự đổi. Chủ động đối soát chênh lệch và xử lý theo quy trình điều chỉnh lương riêng; repository hiện chưa có lệnh điều chỉnh kỳ sau tự động.

## 6. Lỗi thường gặp

| Hiển thị | Kiểm tra / xử lý |
| --- | --- |
| Không liên kết nhân viên | Owner/manager kiểm tra hồ sơ đang hoạt động, Auth user ID và membership cùng workspace. |
| Không có ca phù hợp / sai cửa hàng | Kiểm tra ca có gắn đúng cửa hàng, ngày công và phân công nhân viên còn hiệu lực. Không sửa giờ trên điện thoại để vượt kiểm tra. |
| QR hết hạn / kiosk đã dừng | Quét mã mới trên kiosk, hoặc manager mở phiên kiosk mới. |
| Đã quét giờ vào/ra | Xem lịch sử ca; nếu bản ghi sai, báo quản lý điều chỉnh có lý do. |
| Camera không mở | Kiểm tra quyền camera, HTTPS/localhost và camera đang được ứng dụng khác sử dụng; nhờ quản lý nhập chấm công thủ công nếu thiết bị không hỗ trợ. |
| Thiếu giờ ra | Quét giờ ra trong cửa sổ hợp lệ hoặc báo quản lý xử lý; không xác nhận bản thiếu giờ như ca làm đầy đủ. |

## 7. Kiểm tra trước khi vận hành thật

- Áp dụng migration mới vào **môi trường thử** theo thứ tự, không chạy lại migration lịch sử; xác minh site, phân công, RLS và RPC bằng tài khoản owner/manager, `employee` và workspace khác.
- Tạo một ca thử, quét vào/ra với hai QR khác nhau, kiểm tra giờ từ server, bản nháp, lịch sử và quyền tự xem. Kiểm tra QR hết hạn, sai cửa hàng, retry, quét trùng, ca qua đêm và nhân viên chưa liên kết.
- Với lịch lặp, kiểm tra phân công/cửa hàng đúng ngày hiệu lực, ca tự sinh khi quét hợp lệ, quét sai không để lại ca mới, và bản ghi ngoài giờ phải có quyết định quản lý trước khi tính lương.
- Owner/manager xác nhận bản thử, tính kỳ lương **thử** và đối chiếu với snapshot hiện có. Không dùng dữ liệu thử trong kỳ lương thật. Kiểm tra thêm trên thiết bị desktop/mobile và camera thật.
- Lệnh kiểm thử cục bộ, kết quả và giới hạn triển khai được ghi tại [Current verification](verification/CURRENT.md). Kiểm thử PGlite hoặc build không thay thế kiểm tra Supabase thực tế.

Thiết kế và các ranh giới dữ liệu nằm trong [kế hoạch QR](plans/qr-attendance-system.md). Khi rollback, ngừng sử dụng kiosk/scanner và dùng chấm công thủ công; không xóa sự kiện quét hoặc bảng lương đã ghi nhận.
