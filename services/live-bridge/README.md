# ChiDi local LIVE / printer bridge

Cập nhật **23/09/2026**. Hai tiến trình riêng: **printer bridge** phục vụ máy in tại quầy; **channel listener** nhận yêu cầu kết nối TikTok ID từ web, kiểm tra LIVE thật rồi nhận bình luận. Cả hai dùng Node.js của project, không tự chốt đơn và không giữ service-role key. Luồng thường dùng là **lưu TikTok ID → Kết nối → bán hàng**; listener tự nhận phiên do server chọn.

## 1. Cài đặt trên máy Windows tại quầy

Mở PowerShell. Các lệnh dưới đây chỉ cài dependency trong thư mục service:

```powershell
Set-Location 'D:\ChiDi Manager\ChiDi\_ERP\ChiDi\_Online\_ERP\_Project\services\live-bridge'
$env:Path = 'D:\ChiDi Manager\ChiDi\_ERP\ChiDi\_Online\_ERP\_Project\.tools\node-v24.21.0-win-x64;' + $env:Path
npm.cmd ci --ignore-scripts --omit=optional
if (-not (Test-Path -LiteralPath '.env')) { Copy-Item -LiteralPath '.env.example' -Destination '.env' }
notepad.exe .env
```

`--omit=optional` đủ cho in và NDJSON simulator. Muốn dùng adapter TikTok, cài thêm optional package:

```powershell
npm.cmd ci --ignore-scripts --include=optional
```

Service pin `playwright 1.63.0`, `pngjs 7.0.0`, optional `tiktok-live-connector 2.5.0`. Frontend React không import connector. Windows dùng Microsoft Edge đã cài; nếu cần chọn browser khác, đặt `BRIDGE_BROWSER_EXECUTABLE` thành đường dẫn executable đã tin cậy. Trên Linux/macOS, cài browser cho Playwright theo môi trường trước khi dùng raster.

## 2. ZYWELL 822 qua USB: dùng driver và trình duyệt

1. Cài đúng driver của model ghi trên tem máy, chọn khổ giấy phù hợp trong Windows và in trang thử từ driver.
2. Trên web ChiDi, chọn **USB / driver hệ điều hành qua trình duyệt**. Giao diện hiện tại in khổ **80 mm**; chọn cùng khổ trong driver và tắt header/footer của browser.
3. Chọn in phiếu đã chốt; cho phép cửa sổ in, chọn máy ZYWELL trong hộp thoại.
4. Chỉ xác nhận **đã in** sau khi đã thấy đúng phiếu giấy.

Đường USB này dùng driver hệ điều hành. Chưa có triển khai raw USB/WebUSB. Hộp thoại in đóng hoặc sự kiện `afterprint` không chứng minh đã ra giấy: nó cũng có thể xảy ra khi đóng preview. [MDN afterprint](https://developer.mozilla.org/en-US/docs/Web/API/Window/afterprint_event).

## 3. ZYWELL qua LAN: chạy thử không gửi giấy trước

Giữ `PRINTER_DRY_RUN=true` trong `.env`, rồi chạy:

```powershell
npm.cmd start
```

Terminal hiện URL mặc định `http://127.0.0.1:47831` và **pairing token** ngẫu nhiên. Nhập hai giá trị này vào cấu hình máy in của web trên **cùng máy tính**. Token chỉ giữ trong bộ nhớ trang; không lưu vào Supabase/localStorage. Khởi động lại bridge sinh token mới nếu không cấu hình token cố định.

Dry-run vẫn kiểm tra snapshot và lưu trạng thái lần in, nhưng không gửi TCP tới máy in. Không xác nhận đã có giấy từ một kết quả `dry_run`.

Khi đã biết IP thật từ trang self-test/cấu hình của máy in, dừng bridge bằng Ctrl+C, sửa `.env`:

```dotenv
PRINTER_DRY_RUN=false
PRINTER_LAN_IP=192.168.1.25
PRINTER_LAN_PORT=9100
```

IP trên chỉ là ví dụ. Dùng đúng IP riêng đã xác định của máy shop; service không dò mạng. Chạy `npm.cmd start` lại và ghép token mới. Printer đích được cố định từ cấu hình service; yêu cầu HTTP không được đổi host/port hoặc gửi ESC/POS tùy ý.

Bridge nghe **127.0.0.1**, không mở ra LAN. Origin mặc định chỉ chấp nhận `http://localhost:2000` và `http://127.0.0.1:2000`. Khi web chạy tại tên miền HTTPS, thêm đúng origin vào `BRIDGE_ALLOWED_ORIGINS`, phân cách bằng dấu phẩy; không dùng wildcard/path. Trình duyệt có thể yêu cầu quyền truy cập mạng cục bộ. Khi chính sách trình duyệt chặn kết nối này, dùng Browser/USB hoặc web localhost trên máy quầy.

Điện thoại không gọi `127.0.0.1` của máy quầy: địa chỉ đó trỏ vào chính điện thoại. Nhân viên chốt bằng điện thoại; máy quầy đăng nhập cùng workspace, mở hàng đợi in và xử lý phiếu đã có. Không mở cổng bridge ra Internet để khắc phục.

**Tiếng Việt:** HTML được escape và raster hóa bằng browser, sau đó đóng gói ảnh đơn sắc ESC/POS. Không bỏ dấu hay gửi chữ UTF-8 thẳng vào code page của printer. Web hiện dùng 80 mm/576 dots; thư viện và API cũng hỗ trợ 58 mm/384 dots nhưng UI chưa có bộ chọn 58 mm. Giới hạn ảnh cao 4096 dots, tối đa 20 dòng snapshot; phiếu LIVE hiện tại có một dòng.

Tài liệu hãng mô tả dòng **ZY-Q822** có ESC/POS; cần đối chiếu model/firmware thật của máy shop trước nghiệm thu. [ZYWELL ZY-Q822](https://www.zywell.net/zy-q822-80mm-thermal-receipt-printer.html). Raster hiện dùng `GS v 0`, một lệnh được Epson ghi là cũ và chỉ có trên một số model; xác nhận lệnh này, độ rộng và dao cắt trên máy thật. [ESC/POS raster reference](https://download4.epson.biz/sec_pubs/pos/reference_en/escpos/gs_lv_0.html).

## 4. Trạng thái in và xử lý mất kết nối

| Trạng thái bridge | Ý nghĩa |
|---|---|
| `sending` | Lần in đã được giữ trong spool; chưa biết kết quả |
| `sent` | Đã gửi bytes tới kết nối printer; chưa chứng minh có giấy |
| `dry_run` | Đã kiểm tra/lưu thử; không gửi printer |
| `failed` | Render thất bại trước khi gọi transport |
| `unknown` | Không xác định kết quả, gồm cả tiến trình dừng khi đang in |

Mỗi `attempt_id` gắn với hash của snapshot/khổ giấy. Gửi lại cùng ID trả trạng thái đã lưu và **không gửi thêm giấy**; đổi nội dung dưới ID cũ bị từ chối. Trước TCP, service ghi durable spool tại `state/printer/`. Các phiếu khác nhau cũng được render/gửi tuần tự, tránh trộn bytes trong cùng máy in. Khi restart, các lần `sending` chuyển thành `unknown`, không tự chạy lại. Spool giữ tối đa 5.000 lần; không tự xóa lịch sử chống trùng. Chạy một printer bridge cho một máy in.

Mỗi lần in có hạn 15 giây tính từ khi `PrintSpool.submit` nhận yêu cầu, gồm thời gian chờ các phiếu trước, render và truyền dữ liệu; web chờ phản hồi bridge tối đa 20 giây. Hết hạn trước khi gửi thì ghi `failed`, không mở kết nối TCP muộn. Nếu đã gọi transport nhưng không xác định được kết quả thì ghi `unknown` và hủy kết nối còn chờ. Renderer hoàn tất muộn hoặc khởi động lại service không tự gửi lại lần in đã hết hạn.

Nếu không biết máy đã in hay chưa: kiểm tra giấy, xem trạng thái lần in và xử lý phiếu đó trong web. Chỉ yêu cầu lần in lại mới khi nhân viên đã quyết định; không chốt lại giao dịch để có bản in. Không xóa thư mục `state/` để chữa lỗi, vì mất dấu vết chống gửi trùng. Bảo vệ thư mục này bằng quyền tài khoản Windows tại quầy; nó có snapshot/nhãn khách, không có mật khẩu hay token đăng nhập.

API chỉ nhận origin hợp lệ và `Authorization: Bearer <pairing token>`:

| Endpoint | Dữ liệu |
|---|---|
| `GET /health` | Trạng thái sẵn sàng và `dry_run`/`lan` |
| `POST /print` | `{attempt_id,snapshot,paper_width:58 hoặc 80}` |
| `GET /status?attempt_id=...` | Trạng thái lần in, không trả snapshot khách |

HTTP body tối đa 64 KiB, tối đa 120 request/phút. Snapshot bắt buộc gồm `ticket_no`, `customer_no`, `customer_name`, `campaign_name`, `session_code`, `committed_at`, `lines`, `total_amount`; renderer kiểm tiền nguyên VND/tổng dòng. Raw comment/HTML/URL không được sử dụng làm nội dung thực thi.

## 5. TikTok ID → Kết nối: cấu hình listener một lần

Project cần có migration **009 → 010 → 011**; nếu đã cài 010, chỉ chạy [011_tiktok_live_end.sql](../../supabase/migrations/011_tiktok_live_end.sql) rồi khởi động lại listener. Chủ shop chuẩn bị kho `CHIDI-MAIN`, hoặc workspace chỉ có đúng một kho để server chọn. Không phải tự tạo campaign/phiên cho luồng này.

Cài optional adapter bằng `npm.cmd ci --ignore-scripts --include=optional` như bước 1. Điền ba giá trị trong service `.env`:

| Biến | Nội dung |
|---|---|
| `SUPABASE_URL` | URL HTTPS project đang dùng |
| `SUPABASE_PUBLISHABLE_KEY` | Publishable key, không dùng secret/service-role |
| `LIVE_WORKSPACE_ID` | UUID workspace cần phục vụ; chỉ cấu hình một lần trên máy quầy |

Không cần `LIVE_SESSION_ID`, không điền TikTok ID vào `.env`. Luồng channel luôn dùng TikTok, bỏ qua `LIVE_SOURCE=ndjson` của phần thử nghiệm nâng cao. Nếu nhà cung cấp ký kết nối yêu cầu khóa, đặt `TIKTOK_SIGN_API_KEY` riêng ở service, không đưa vào biến `VITE_*`.

Chạy và giữ terminal mở:

```powershell
npm.cmd run worker:channels:login
```

Nhập email và mật khẩu **tài khoản ERP ChiDi có quyền owner/manager** tại workspace đó. Đây là đăng nhập Supabase Auth của ERP, **không phải TikTok OAuth hay mật khẩu TikTok**. Mật khẩu không hiện; helper không ghi mật khẩu/token vào file hoặc log. Access/refresh token chỉ giữ trong bộ nhớ, refresh khi cần. Khởi động lại listener thì đăng nhập lại; không cần lấy JWT từ DevTools hoặc điền hai biến `LIVE_OPERATOR_*` khi dùng lệnh login.

Trên web, lưu/chọn **TikTok ID** rồi bấm **Kết nối**. Listener đọc yêu cầu mỗi 3 giây. Nó kiểm tra tài khoản đang LIVE và kết nối được phòng có ID thực tế trước khi báo server. Khi đã xác minh, server tạo/chọn campaign theo kênh và ngày Việt Nam, chọn phiên theo phòng LIVE; kết nối lại cùng phòng trong ngày dùng lại phiên còn mở. Listener nối vào đúng ID phòng đó để nhận chat. Khi tài khoản chưa phát LIVE, web báo offline; không tạo campaign/phiên rỗng. Bắt đầu LIVE rồi bấm Kết nối lại. Chọn ngắt kết nối trên web sẽ dừng nhận; Ctrl+C dừng listener và chờ các thao tác đang chạy kết thúc.

Yêu cầu kết nối có **revision** và quyền xử lý tạm **90 giây**. Heartbeat của worker khoảng 30 giây gia hạn quyền; `ingest_tiktok_comments` và `report_tiktok_connection` kiểm tra người vận hành, workspace, revision và token. Worker cũ hoặc hết quyền không được ghi tiếp sau lần kết nối mới. Bấm lặp không tạo thêm worker cho cùng yêu cầu. Mỗi máy chỉ chạy một channel listener cho một workspace.

Lỗi provider được thử lại với thời gian chờ tăng dần, tối đa 30 giây; dừng thử sau 5 lỗi liên tiếp. Yêu cầu mới đặt lại bộ đếm; kết nối chạy ổn định ít nhất 60 giây cũng đặt lại bộ đếm. Quyền xử lý đang bận thì chờ 90 giây trước khi thử. Hết lượt, kiểm tra provider/đăng nhập rồi yêu cầu kết nối lại trên web. Tài khoản offline chờ yêu cầu mới, không tự kiểm tra liên tục. Có thể chỉnh `LIVE_SUPERVISOR_POLL_MS` từ 1000 đến 30000, mặc định 3000.

Adapter optional `tiktok-live-connector` là bên thứ ba; khả năng kết nối thật và dịch vụ ký kết nối cần nghiệm thu riêng. [Repository của maintainer](https://github.com/zerodytrash/TikTok-Live-Connector). ID khách lấy từ `data.user.userId` dưới dạng chuỗi; username/nhãn hiển thị không dùng để tự gộp khách. Worker chỉ nhận chat, không tạo giao dịch bán hoặc tự bấm CHỐT.

## 6. Nâng cao: mô phỏng và phiên tạo thủ công

Các lệnh cũ vẫn được giữ để thử nghiệm hoặc vận hành phiên tạo thủ công. Trên web, mở **Thủ công / mô phỏng**; owner/manager tạo campaign hoạt động và phiên đang mở. Lấy workspace/session ID từ **Thiết lập Live & máy in → Phiên live → Thông tin cấu hình worker trên máy tính**. Chủ project cũng có thể đọc metadata trong SQL Editor:

```sql
select id, workspace_id, code, provider, status
from public.live_sessions
where code = 'MA-PHIEN-CUA-BAN';
```

Điền thêm `LIVE_SESSION_ID` rồi chọn một cách:

| Mục đích | Cấu hình và lệnh |
|---|---|
| NDJSON trong workspace thử | Phiên `manual` hoặc `simulator`; `LIVE_SOURCE=ndjson`, `LIVE_FIXTURE_FILE=./fixtures/comments.ndjson`; `npm.cmd run worker:login` |
| TikTok với phiên tạo thủ công | Phiên `tiktok_live`, profile bật và `room_id` khớp username; `LIVE_SOURCE=tiktok`; `npm.cmd run worker:login` |
| Theo dõi yêu cầu kết nối của một phiên thủ công | Cần 009, `LIVE_SOURCE=tiktok`; `npm.cmd run worker:supervise:login` |

Simulator dùng cùng queue và RPC `ingest_live_comments`, có kiểm tra trùng ID/nội dung; không chạy fixture vào phiên TikTok hoặc dữ liệu bán thật. Các lệnh phiên thủ công không thay thế channel listener cho phiên do 010 tự tạo: phiên đó bắt buộc gửi bình luận bằng RPC có token/revision.

Nếu môi trường chạy tự động đã cấp `LIVE_OPERATOR_ACCESS_TOKEN`/`LIVE_OPERATOR_REFRESH_TOKEN`, dùng các lệnh tương ứng `worker:channels`, `worker:supervise` hoặc `worker`. Với lệnh trực tiếp `worker:login`, provider dừng thì người vận hành kiểm tra và khởi động lại; hai supervisor có cơ chế thử lại giới hạn. Không cần cookie hay mật khẩu TikTok ở các lối đăng nhập này.

## 7. Queue bình luận và giới hạn vận hành

**Cập nhật 24/09 — kết thúc LIVE tự động:** nhận `STREAM_END` từ provider sẽ dừng nhận mới, gửi các bình luận đã nhận còn chờ rồi gọi `finish_tiktok_live`. RPC kết thúc phiên, ngắt kênh và vô hiệu hóa lease; không đợi người dùng duyệt. Nếu gửi batch thất bại, queue còn nguyên để đối chiếu. Phiên đã kết thúc không nhận thêm comment; không tự xóa hoặc sửa file queue để gửi sang phiên khác. Mất mạng/`DISCONNECTED` thông thường vẫn theo retry, không tự suy thành STREAM_END.

Mất phản hồi RPC kết thúc: supervisor tự thử lại cùng UUID và không mở lại provider trong lúc chờ. Quyền kết thúc chỉ chấp nhận token/actor/revision hiện hành; expiry đơn thuần sau chờ gửi cuối không cho phép token đó ingest hoặc gia hạn LIVE. UUID chờ kết thúc giữ trong bộ nhớ tiến trình; nếu máy tắt đột ngột trước xác nhận, cần đối chiếu database/queue khi khởi động lại. Đây chưa phải cơ chế nhật ký kết thúc bền vững qua mọi lần crash.

`state/intake/` lưu queue riêng theo workspace/session, tối đa 2.000 bình luận đang chờ. Mỗi batch tối đa 100. Chỉ xóa bình luận khỏi queue khi RPC xác nhận đủ số inserted + duplicates; lỗi mạng, lỗi Auth hoặc acknowledgement thiếu giữ nguyên dữ liệu chờ. Lần gửi lại có cùng ID, nội dung và thời điểm; database xử lý idempotency.

Khi queue đầy hoặc provider đưa sự kiện không hợp lệ, worker dừng nhận, giữ queue đã lưu và ghi diagnostic có giới hạn. Diagnostic có thể chỉ có trích đoạn khi đầu vào vượt kích thước. Không đảm bảo khôi phục bình luận mà TikTok chưa giao cho worker hoặc phát sinh trong khoảng mất kết nối; cần đối chiếu với phiên LIVE. Timestamp provider được dùng khi có; thiếu timestamp thì dùng thời điểm worker nhận, giữ cố định khi retry.

Spool/queue không phải backup dữ liệu Supabase. Chỉ một worker vận hành một workspace/session trên cùng máy: service giữ một cổng loopback cố định theo hash của hai ID làm khóa tiến trình, không trao đổi dữ liệu qua cổng này. Worker thứ hai bị từ chối trước khi mở queue; hệ điều hành nhả khóa khi tiến trình thoát hoặc crash. `WORKER_SLOT_BUSY` nghĩa là worker/cổng tương ứng còn bận; kiểm tra tiến trình cũ trước, không xóa queue để vượt khóa. Không sửa JSON để đánh dấu đã gửi. Credential session không nằm trong các file này.

Khi dừng bình thường, worker ngừng nhận bình luận mới, hủy lịch retry và chờ các thao tác ghi queue, RPC ingest và báo trạng thái khởi động đang chạy kết thúc rồi mới nhả khóa. Gọi dừng nhiều lần hoặc provider phát thêm sự kiện mất kết nối đều chờ cùng một tiến trình kết thúc. RPC thất bại giữ bình luận trên đĩa. Kết nối provider hoàn tất muộn sau lệnh dừng sẽ bị ngắt lại, không báo “connected” hay tạo lịch gửi mới. Quy trình này không thay thế việc đối chiếu sau mất điện hoặc cưỡng bức kết thúc tiến trình.

## 8. Bằng chứng kiểm tra và phần còn phải nghiệm thu

**24/09/2026: 77/77 service tests PASS**, không skip. Thêm 9 ca tự nhận comment, STREAM_END, thứ tự gửi/ACK, giữ queue khi lỗi, retry kết thúc cùng UUID, callback cũ và tương thích worker 007. Mốc 68/68 bên dưới là trước bản sửa 011.

```powershell
npm.cmd test
```

Kết quả local ngày **23/09/2026: 68/68 test PASS**, không bỏ qua test; đã chạy độc lập lại toàn bộ service. Gồm 20 test channel listener, 15 test supervisor theo phiên và 33 test intake/printer. Các test xác nhận: offline không tạo phiên; chỉ báo LIVE sau bằng chứng provider; revision/lease cũ bị chặn; kết nối sai phòng không lưu/gửi chat; dừng chờ acknowledgement và không nhận kết nối hoàn tất muộn. Bộ cũ tiếp tục kiểm tra Unicode/ID lớn, queue/retry, Auth mock, simulator, origin/token, spool chống in trùng, deadline chống gửi muộn và render tiếng Việt 58/80 mm bằng browser thật tại máy.

Tests không kết nối Supabase/TikTok thật và không gửi bytes tới máy in vật lý. Parser/browser driver còn có bộ Vitest trong `src/lib/*.test.js`, chạy từ project gốc.

Trước vận hành cần ghi kết quả: in USB thật; in LAN thật với đúng model, độ rộng và dấu tiếng Việt; rút cáp/mất giấy giữa lần in; restart khi trạng thái chưa rõ; hai thiết bị cùng mở hàng đợi; đăng nhập owner/manager và nhận chat từ phiên TikTok thật. Giữ phiếu đã chốt nguyên trạng khi thử lỗi; chỉ thao tác in lại theo hàng đợi.
