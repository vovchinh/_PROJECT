# Phase C — TikTok LIVE, chốt phiếu và in ZYWELL 822

**Luồng TikTok mới từ 23/09/2026:** [lưu TikTok ID → KẾT NỐI LIVE](TIKTOK_CHANNEL_SETUP.md). Các bước tạo campaign/session thủ công trong tài liệu này dành cho chế độ nâng cao/mô phỏng hoặc bản 007/008; người bán dùng luồng mới không cần nhập các trường này. 010 tự tạo ngữ cảnh sau khi listener xác nhận LIVE; chỉ chạy các migration còn thiếu theo thứ tự.

Cập nhật 22/09/2026. Phase C bổ sung vào ERP đang có, dùng React JavaScript và Supabase. Nghiệp vụ live có màn hình **Live · Chốt & In**, migration 007/008, parser, worker nhận bình luận và cầu nối máy in. Kết quả local và phần còn cần nghiệm thu thực tế được ghi tại [verification Phase C](verification/PHASE_C_VERIFICATION.md).

Giao diện theo bảy ảnh tham chiếu có sáu khu vực: **Bàn live · Giỏ khách · Lịch sử phiên · Hàng đợi in · Báo cáo live · Thiết lập**. Trên điện thoại, thanh điều hướng nằm dưới; mở **Thống kê & kết nối** để xem trạng thái nguồn. Xem [hồ sơ UI/UX và cách dùng từng màn hình](architecture/PHASE_C_UI_UX.md). Đợt cập nhật giao diện này không thêm migration sau 008.

## 1. Nâng cấp database

1. Xác nhận project đã chạy thành công 001–006. Nếu chưa hoàn tất Phase B, làm theo [hướng dẫn Phase B](PHASE_B_COMMERCE_FOUNDATION.md). Không chạy lại file đã thành công.
2. Dùng một project/workspace thử để nghiệm thu trước; lưu bản sao database bằng quy trình backup của project. Việc restore backup thật chưa được phiên phát triển này kiểm chứng.
3. Trong Supabase SQL Editor, chạy [007_live_intake.sql](../supabase/migrations/007_live_intake.sql) một lần.
4. Khi 007 thành công, chạy [008_live_tickets_print.sql](../supabase/migrations/008_live_tickets_print.sql) một lần.
5. Chạy script chỉ đọc [verify_phase_c.sql](../supabase/verification/verify_phase_c.sql), lưu kết quả metadata/đối chiếu, không gửi mật khẩu hoặc token. Các chỉ số sai lệch phải bằng 0.
6. Mở lại **START_CHIDI.cmd**, đăng nhập workspace và chọn **Live · Chốt & In**. Không nhập lại Excel hoặc dữ liệu cũ để bật live.

Mỗi migration chạy trong transaction. Nếu một file báo lỗi thì xử lý nguyên nhân của file đó; không tiếp tục file kế tiếp và không chạy lại cả chuỗi. Nếu publication `supabase_realtime` đang xuất mọi bảng, 007 sẽ dừng để tránh phát token claim. Cần chuyển publication về danh sách bảng rõ ràng trước khi cài; không tự xóa publication đang dùng. PostgreSQL 15+ chỉ xuất các cột được phép của claim/print job; bản cũ dùng tải lại qua RPC cho các bảng có token.

Script verification kiểm **tất cả publication**, kể cả publication bổ sung sau migration. Không xuất `claim_token`, `lease_token` hoặc bảng private chứa kết quả request qua publication khác. Nếu verification báo lộ token thì xử lý cấu hình replication đó trước vận hành; không chỉ nhìn cấu hình `supabase_realtime`. Mất publication realtime đơn thuần được báo là cảnh báo vì UI còn polling.

Lỗi nền A1 `003/55006` trên đường V1 có dữ liệu → V2 chưa được Phase C sửa. Phạm vi nâng cấp đã kiểm tra là **V2/Phase B đã cài thành công và có dữ liệu → 007/008**. Xem [trạng thái hiện tại](architecture/V2_CURRENT_STATE.md).

## 2. Chuẩn bị danh mục và nguồn hàng

- Trong **Nền tảng thương mại**, kiểm tra SKU và variant đã xác nhận; SKU tạm hoặc mapping đang chờ đối chiếu không được chốt live.
- Thêm alias dễ đọc khi livestream. Hai SKU có cùng alias sẽ tạo kết quả mơ hồ; nhân viên phải chọn lại sản phẩm, hệ thống không chọn ngầm.
- Đảm bảo kho đã có hàng nhập hợp lệ đúng ngày. Hàng giữ cho đơn cũ, giữ thủ công và giữ live cùng trừ vào khả dụng.
- Không dùng tên người xem làm bằng chứng họ là khách ERP nào. Có thể chốt với khách ERP chưa liên kết; STT/rổ vẫn được tạo theo định danh nguồn trong chiến dịch.

## 3. Tạo chiến dịch, phiên và tài khoản TikTok

Trong tab **Thiết lập Live & máy in**, owner/manager thực hiện:

1. **Tạo chiến dịch**: nhập mã, tên, kho và trạng thái hoạt động. Nhiều buổi live có thể thuộc cùng chiến dịch để giữ cùng STT khách.
2. **Thêm tài khoản TikTok**: nhập tên hồ sơ và username, ví dụ `chidi.shop`. Đây là thông tin công khai; không nhập URL, mật khẩu, cookie hoặc secret TikTok. Username tối đa 24 ký tự, không kết thúc bằng dấu chấm.
3. **Tạo phiên live**: chọn chiến dịch, mã phiên, tiêu đề và nguồn. Với nguồn TikTok, chọn hồ sơ vừa tạo; phòng phải khớp username đó. Đặt phiên đang live khi bắt đầu.
4. Chọn phiên trong **Bàn live**. Theo dõi trạng thái kết nối/heartbeat; phiên được mở trên ERP chưa có nghĩa worker đã kết nối TikTok.

Mã chiến dịch/phiên và thông tin nguồn của phiên đã tạo không đổi. Nếu nhầm tài khoản/phòng, kết thúc phiên đó và tạo phiên mới đúng nguồn. Tắt hồ sơ TikTok sẽ chặn nhận bình luận mới; bình luận đã nhận vẫn còn để đối chiếu.

Để thử trước khi kết nối TikTok, tạo phiên **thủ công** hoặc **mô phỏng**, dùng **Nhập bình luận** hoặc **Nhập JSON**. JSON nhận mảng tối đa 100 phần tử, mỗi phần tử có `message_id`, `author_external_id`, `author_display_name`, `text`, `occurred_at` dạng ISO 8601 có múi giờ. Giữ ID nguồn là chuỗi, đặc biệt với số dài; không tự tạo ID mới khi gửi lại cùng bình luận.

## 4. Chạy worker TikTok

Worker nằm riêng trong [services/live-bridge](../services/live-bridge/README.md); ứng dụng web không tải thư viện TikTok hoặc giữ credentials worker. README service ghi cấu hình, đăng nhập, simulator và lệnh chạy đúng phiên.

Từ thư mục project, với Node đã có trong PATH:

```powershell
npm --prefix services/live-bridge ci
npm --prefix services/live-bridge test
```

Sao chép mẫu `.env.example` của service thành `.env` tại chính thư mục service. Điền `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `LIVE_WORKSPACE_ID`, `LIVE_SESSION_ID`. Hai ID có thể sao chép từ **Thiết lập Live & máy in → Phiên live → Thông tin cấu hình worker trên máy tính**, sau khi chọn phiên ở đầu trang.

Đặt `LIVE_SOURCE=ndjson` và `LIVE_FIXTURE_FILE=./fixtures/comments.ndjson` để thử với phiên mô phỏng; dùng `LIVE_SOURCE=tiktok` với phiên TikTok thật. Chạy:

```powershell
npm --prefix services/live-bridge run worker:login
```

Lệnh hỏi email và mật khẩu ERP trong terminal local, không in token; phiên đăng nhập giữ trong bộ nhớ. Dùng owner/manager của workspace. Không dùng service-role key và không lấy JWT từ trình duyệt. Cấu hình local `.env` và spool nằm ngoài Git. Một worker vận hành một phiên; dừng worker cũ trước khi đổi phiên/tài khoản. Các tùy chọn/đường khôi phục chi tiết nằm trong README service.

Nguồn TikTok dùng adapter bên thứ ba [TikTok Live Connector](https://github.com/zerodytrash/TikTok-Live-Connector), phiên bản được khóa trong service. Đây là connector không chính thức; khả năng kết nối phụ thuộc TikTok/nhà cung cấp và cần thử với tài khoản ChiDi đang phát live. Simulator/NDJSON là đường kiểm tra độc lập, không chứng minh TikTok thật đã kết nối. README ghi giấy phép và giới hạn của dependency tùy chọn.

Bình luận được lưu trước khi gửi RPC; khi mất phản hồi, gửi lại giữ nguyên message ID/nội dung. Database phân biệt bản lặp giống hệt với bản trùng ID khác nội dung. Một lô xung đột không được ghi một phần. Không coi tên hiển thị hoặc username thay đổi là stable user ID.

## 5. Chốt phiếu và giỏ khách

1. Nhân viên chọn bình luận mới và **Nhận & kiểm tra**. Claim có hạn 120 giây; người khác không được chốt khi lease còn hiệu lực. Hết hạn thì nhận lại quyền xử lý.
2. Đọc gợi ý parser, kiểm tra sản phẩm/variant, số lượng, giá, ngày nghiệp vụ và khách ERP nếu đã xác minh. Parser không tự chốt hoặc giữ hàng.
3. Ghi chú xác nhận, đánh dấu đã kiểm tra rồi **CHỐT & IN**. Server kiểm quyền/claim/tồn một lần nữa.
4. Khi thành công, một transaction tạo ticket, dòng giỏ, lượt giữ tồn, print job, audit và outbox. Không tạo doanh thu, thu tiền hoặc đơn bán cuối cùng ở bước này.
5. Nếu mất phản hồi, thử lại trên form hiện tại để dùng cùng request ID. Nếu đã đóng trang, kiểm tra bình luận/giỏ/hàng đợi trước khi thao tác tiếp. Một bình luận chỉ có một ticket, kể cả ticket đã VOID.

Trong **Giỏ khách**, các phiếu active được gom theo khách nguồn trong chiến dịch; cùng khách qua nhiều phiên giữ cùng STT. Tên hiển thị giống nhau không tự gộp hai người. Giá và thông tin phiếu là snapshot tại thời điểm chốt.

Tìm giỏ bằng STT/tên/SKU/mã phiếu, mở chi tiết để xem **Thông tin / Phiếu đã chốt** hoặc hàng đợi riêng của giỏ. Chọn **Tất cả giỏ** để xem cả lịch sử đã VOID. **Lịch sử phiên** giúp mở đúng buổi live; ngày hiển thị là ngày tạo phiên. **Báo cáo live** lọc 7/30/180/365 ngày theo ngày nghiệp vụ và chỉ cộng phiếu còn hiệu lực của chiến dịch, chưa phải doanh thu/thu tiền.

**VOID** chỉ dành cho owner/manager, có lý do và ngày hợp lệ: ticket giữ lịch sử, dòng giỏ bị vô hiệu, hàng giữ được giải phóng, job bị hủy. Nếu job đang in thì xử lý trạng thái in trước. Không giải phóng/chuyển live hold từ màn hình giữ hàng thủ công. Giỏ live chưa có chức năng chuyển sang Final Order, gửi Zalo hoặc thu cọc; đó là Phase D.

## 6. In với ZYWELL 822 USB+LAN

Tài liệu hãng cho [ZY-Q822](https://www.zywell.net/zy-q822-80mm-thermal-receipt-printer.html) nêu khổ 80 mm và ESC/POS, có tùy chọn LAN. Cần đối chiếu mã đầy đủ trên tem/self-test của máy ChiDi trước chọn driver và nghiệm thu; tên “822” trong yêu cầu chưa đủ xác nhận mọi biến thể phần cứng.

### USB hoặc driver Windows

1. Cài driver đúng thiết bị theo nhà cung cấp ZYWELL; in trang thử Windows trước.
2. Trong ERP chọn **USB / driver hệ điều hành qua trình duyệt**. Cho phép popup của địa chỉ ERP.
3. Trong hộp thoại in chọn ZYWELL, khổ 80 mm, tắt header/footer trình duyệt và kiểm tra bản xem trước. Thiết lập lề/tỷ lệ theo giấy thử thực tế.
4. Sau khi giấy ra đúng phiếu, đánh dấu xác nhận và nhấn **Xác nhận giấy đã in** trong ERP.

Mở hoặc đóng hộp thoại in không tự đánh dấu đã in. [Sự kiện afterprint](https://developer.mozilla.org/en-US/docs/Web/API/Window/afterprint_event) không chứng minh thiết bị đã nhả giấy.

### LAN qua cầu nối trên máy tính

Làm theo [README cầu nối](../services/live-bridge/README.md): cấu hình IP LAN cố định của ZYWELL, cổng máy in, token ghép nối và Origin của ERP. Chạy cầu nối trên máy tính dùng để in; chọn **LAN qua cầu nối trên máy tính**, địa chỉ mặc định `http://127.0.0.1:47831`, nhập token vào ô mật khẩu. Token chỉ giữ trong bộ nhớ phiên trình duyệt.

Cầu nối chỉ nghe loopback, chỉ nhận snapshot phiếu hợp lệ, kiểm Origin/token và không cho client chọn IP đích hoặc gửi lệnh ESC/POS tùy ý. Phiếu được raster hóa để giữ chữ Việt; trạng thái gửi socket không thay xác nhận giấy thực tế. Chạy chế độ dry-run trước, rồi nghiệm thu khổ giấy, dấu tiếng Việt và cắt giấy trên ZYWELL thật. Không công khai cổng cầu nối ra Internet.

Điện thoại mặc định **Chỉ xếp hàng đợi — máy tính sẽ in**: chốt vẫn tạo phiếu/hold/print job, không tự nhận in hoặc mở popup. Dùng trang ERP được triển khai HTTPS và một máy tính đăng nhập cùng workspace, chọn USB/LAN để nhận và in hàng đợi. `127.0.0.1` trên điện thoại là điện thoại, không phải máy tính. Launcher local hiện tại không tự triển khai hosting hoặc mở mạng LAN cho điện thoại. Không có tuyên bố đã nghiệm thu in trực tiếp từ điện thoại.

Trong **Thiết lập**, chọn **Xem mẫu phiếu** rồi **In thử 80 mm** để kiểm chữ Việt/lề/cắt giấy trước khi bán. Mẫu ghi rõ **IN THỬ — KHÔNG PHẢI PHIẾU BÁN**, giá trị 0 đ và không tạo ticket, giữ tồn hoặc print job trong ERP. Nút in thử cần chế độ USB/LAN; viewer chỉ được xem mẫu. Chỉ xác nhận hoạt động của thiết bị sau khi kiểm giấy thật.

### Lỗi in, mất điện và in lại

- Ticket/giỏ/hàng giữ đã commit vẫn còn khi popup bị chặn, hết giấy, bridge tắt hoặc mạng lỗi.
- Trong **Hàng đợi in**, đọc trạng thái và kiểm tra giấy trước. Nếu chưa rõ giấy đã ra, dùng **Đối soát giấy** theo trạng thái cho phép; không chốt lại bình luận để in.
- **Kiểm tra / in lại** cần lý do, đưa cùng job vào hàng đợi và tạo attempt mới khi nhận in. Không tạo ticket/cart item/reservation lần hai.
- Job đang có lease in còn hạn không được máy khác nhận. Khi lease hết hạn, requeue sẽ vô hiệu token cũ; kết quả muộn không được ghi đè attempt mới.
- Bridge ghi spool theo attempt ID và nội dung: cùng attempt không tự gửi giấy lần hai, kể cả sau khởi động lại. Gửi bị gián đoạn có thể ở trạng thái chưa rõ; phải đối chiếu trước khi tạo attempt mới.

## 7. Phân quyền và giới hạn vận hành

| Vai trò | Thao tác Phase C |
|---|---|
| Owner / manager | Thiết lập tài khoản/chiến dịch/phiên, worker connection, nhận bình luận, chốt, in/đối soát, VOID |
| Staff | Nhận bình luận, claim, chốt sau kiểm tra, in/đối soát; không quản trị nguồn hoặc VOID |
| Viewer | Xem dữ liệu trong workspace; không ghi nghiệp vụ |

RLS và workspace FK bảo vệ bảng; ghi qua RPC kiểm role, không tin quyền hiển thị của React. Token claim/print lease không nằm trong kết quả đọc của người khác. Realtime chỉ nhắc tải lại; polling mỗi 10 giây, khi quay lại tab và nút tải lại phục hồi khi mất sự kiện.

Giới hạn hiện tại: tối đa 100 bình luận/lô nhận, 200/trang RPC (UI dùng 100); 1.000 hồ sơ/chiến dịch/phiên trong snapshot danh mục; 5.000 dòng mỗi tập dữ liệu commerce của chiến dịch. Vượt ngưỡng báo lỗi rõ ràng, không cắt lặng dữ liệu. Chưa có load test hoặc tự hết hạn live reservation. Kết thúc phiên không tự hủy ticket/giữ tồn.

## 8. Checklist nghiệm thu trên môi trường thật

- [ ] 007/008 đã áp dụng đúng thứ tự; metadata/RLS/grants/publication và chỉ số đối chiếu hợp lệ.
- [ ] Hai tài khoản thuộc hai workspace không đọc hoặc thao tác chéo.
- [ ] Hai nhân viên xử lý cùng bình luận: chỉ một người có claim; hàng cuối không bị chốt vượt tồn.
- [ ] Mất phản hồi rồi retry: vẫn một ticket, một dòng giỏ, một hold và một print job.
- [ ] Thử giấy ZYWELL qua đường USB/LAN sẽ dùng: đúng STT, SKU, số lượng, giá và dấu tiếng Việt.
- [ ] Rút mạng/hết giấy rồi in lại: phiếu còn nguyên, không nhân đôi bán; đối chiếu trước in lại.
- [ ] VOID giải phóng tồn đúng một lần; không thay doanh thu/thu chi.
- [ ] Worker nhận bình luận thật của tài khoản ChiDi, ID nguồn không bị làm tròn; kết nối lại không tạo trùng.
- [ ] Mở trên thiết bị di động qua URL HTTPS, đọc/chốt và in từ máy tính cùng workspace.
- [ ] Backup/restore trong môi trường thử và quy trình bàn giao người vận hành được xác nhận.

## 9. Khôi phục và hồ sơ kỹ thuật

Nếu cần tạm dừng: ngừng worker, ngừng chốt mới, đối chiếu job đang in và các live holds. Giữ dữ liệu/ticket/audit để kiểm tra; không xóa bảng mới hoặc hạ RPC kho về phiên bản bỏ qua hàng giữ. Sửa tiến bằng migration mới sau 008. Khôi phục backup chỉ thực hiện theo kế hoạch riêng có đối chiếu giao dịch phát sinh sau bản backup.

Xem [kế hoạch triển khai](architecture/PHASE_C_IMPLEMENTATION_PLAN.md), [trạng thái V2](architecture/V2_CURRENT_STATE.md), [gap analysis](architecture/V2_TARGET_GAP_ANALYSIS.md), [migration plan](architecture/V2_MIGRATION_PLAN.md) và [verification](verification/PHASE_C_VERIFICATION.md). Các tài liệu ghi riêng bằng chứng local, cloud và thiết bị; không coi mô phỏng là nghiệm thu production.
