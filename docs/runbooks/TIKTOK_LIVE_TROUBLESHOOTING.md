# Chẩn đoán kết nối TikTok LIVE

Cập nhật **25/09/2026** từ [audit T0 ngày 24/09](../verification/TIKTOK_LIVE_CONNECTIVITY_AUDIT.md), mã hiện tại và [yêu cầu chẩn đoán](../CODEX_TIKTOK_LIVE_CONNECTION_DIAGNOSE_COMPLETE.md). Đây là hướng dẫn kiểm tra; **chưa phải biên bản nghiệm thu TikTok thật hoặc chấp nhận vận hành production**. Không có thao tác cloud hay kết nối provider nào được thực hiện chỉ bởi việc tạo tài liệu này.

## Kết luận đã biết

- Tại lần kiểm tra máy ngày **24/09/2026**, Vite đang chạy nhưng không thấy tiến trình channel listener, listener cũ hoặc printer bridge; `services/live-bridge/.env` chưa tồn tại. Đây là ảnh chụp trạng thái lúc kiểm tra, không xác nhận trạng thái máy khác hoặc lần khởi động sau.
- Kiểm tra bổ sung **25/09/2026 lúc 08:20 UTC** tiếp tục ghi nhận thiếu service `.env`, có Vite và một tiến trình Node khác nhưng không thấy listener local. Probe REST **anonymous, chỉ đọc** tới sáu bảng Live và `get_tiktok_channels`/`get_live_operations`/`get_live_intake` đều trả `401 / 42501`; chỉ xác nhận endpoint phản hồi và anonymous bị từ chối. Không đọc được dòng Auth/workspace, không có thao tác ghi và không suy ra cloud E2E PASS. Bằng chứng: [tiktok-cloud-metadata.json](../../test-results/tiktok-cloud-metadata.json).
- **START_CHIDI.cmd chỉ khởi động giao diện.** CONNECT ghi ý định vào database; nó không tự khởi động Node listener. Giao diện đang chạy và đăng nhập ERP thành công chưa chứng minh listener đã hoạt động.
- Audit phát hiện CONNECTING/RECONNECTING chưa có hạn chờ đầy đủ. Khi listener không xử lý được yêu cầu, màn hình có thể chờ mãi. Không dùng trạng thái chờ này làm bằng chứng TikTok đã xác nhận LIVE.
- Adapter đã cài là `tiktok-live-connector@2.5.0`. Audit xác định payload protobuf v3 không khớp normalizer chat cũ và chưa có đường xử lý số người xem. Phần sửa/kiểm thử mới cần có bằng chứng riêng trước khi đánh dấu đã khắc phục.
- Baseline 001–011 đã có kiểm thử local; **Supabase/Realtime thật, kênh đang LIVE, máy in và backup/restore chưa được nghiệm thu**. Xem [verification hiện có](../verification/TIKTOK_CHANNEL_VERIFICATION.md) để phân biệt từng loại bằng chứng.

## Ba tiến trình khác nhau

| Thành phần | Cách chạy từ project | Dấu hiệu có thể xác nhận |
|---|---|---|
| Giao diện React/Vite | `START_CHIDI.cmd` | Truy cập được web ở địa chỉ terminal thông báo; chưa chứng minh nhận TikTok |
| Channel listener | `npm.cmd --prefix services/live-bridge run worker:channels:login` | Đăng nhập ERP cho tiến trình, đọc ý định kết nối, kiểm provider và gửi bình luận vào đúng workspace |
| Printer bridge | `npm.cmd --prefix services/live-bridge start` | Cầu nối máy in local; `/health` của nó không kiểm sức khỏe TikTok listener |

Giữ listener trong terminal riêng. Tắt terminal web không phải quy trình quản lý vòng đời listener, và mở web trên điện thoại không khởi động listener ở máy quầy. Channel listener quản lý các kênh đã lưu trong workspace; không cần nhập TikTok ID hoặc `LIVE_SESSION_ID` vào cấu hình luồng tự động.

## Chuẩn bị listener trên môi trường thử

Các lệnh dưới đây dành cho người vận hành chạy trong PowerShell tương tác. **Chỉ khởi động listener sau khi đã chọn workspace thử có quyền sử dụng và đã kiểm tra migrations cần thiết**: listener có thể ghi trạng thái/phiên/bình luận khi nhận yêu cầu CONNECT. Runbook không cấp thêm quyền ghi production hoặc chạy lại SQL lịch sử.

Tại thư mục project:

```powershell
Set-Location -LiteralPath 'D:\ChiDi Manager\ChiDi\_ERP\ChiDi\_Online\_ERP\_Project'
$env:Path = (Join-Path (Get-Location) '.tools\node-v24.21.0-win-x64') + ';' + $env:Path
node --version
```

Nếu máy chưa có dependency service, cài theo lockfile hiện tại. Optional dependency là adapter TikTok:

```powershell
npm.cmd --prefix services/live-bridge ci --ignore-scripts --include=optional
```

Tạo cấu hình service khi chưa có, rồi sửa trực tiếp tại máy. Lệnh này giữ nguyên `.env` hiện có:

```powershell
if (-not (Test-Path -LiteralPath 'services/live-bridge/.env')) {
    Copy-Item -LiteralPath 'services/live-bridge/.env.example' -Destination 'services/live-bridge/.env'
}
notepad.exe services/live-bridge/.env
```

Điền đúng ba giá trị theo [hướng dẫn thiết lập](../TIKTOK_CHANNEL_SETUP.md):

| Biến trong service `.env` | Giá trị cần có |
|---|---|
| `SUPABASE_URL` | URL HTTPS của project thử |
| `SUPABASE_PUBLISHABLE_KEY` | Publishable key của cùng project |
| `LIVE_WORKSPACE_ID` | Workspace thử mà tài khoản listener có quyền owner/manager |

`.env.local` của frontend và `services/live-bridge/.env` là hai cấu hình riêng. Không sao chép toàn bộ `.env.local` sang service. Không dùng service-role key. Với lệnh đăng nhập tương tác, để trống `LIVE_OPERATOR_ACCESS_TOKEN` và `LIVE_OPERATOR_REFRESH_TOKEN`; không lấy token từ DevTools hoặc đưa mật khẩu lên dòng lệnh. Nếu provider yêu cầu khóa ký, chỉ đặt `TIKTOK_SIGN_API_KEY` trong cấu hình server riêng, không dùng biến `VITE_*` và không gửi khóa trong báo cáo lỗi.

Khởi động listener:

```powershell
npm.cmd --prefix services/live-bridge run worker:channels:login
```

Nhập email và mật khẩu **ERP owner/manager của workspace thử**, không phải mật khẩu TikTok. [Login helper](../../services/live-bridge/login-worker.mjs) yêu cầu terminal tương tác, che mật khẩu, giữ access/refresh token trong bộ nhớ. Không chuyển hướng đầu vào mật khẩu từ file hoặc chèn vào command history. Thông báo đăng nhập thành công mới xác nhận Auth; tiếp tục kiểm tra quyền workspace/provider, không coi đó là LIVE thành công.

Giữ terminal mở. Listener đọc yêu cầu định kỳ; nhân viên trên web chọn kênh, bật LIVE ở TikTok và bấm CONNECT. Trong môi trường thử, dừng bằng **Ngắt kết nối** trên web rồi `Ctrl+C` tại terminal listener; chờ tiến trình hoàn tất việc ghi queue/ACK. Không xóa `state/` hoặc ép sửa queue để khắc phục lỗi.

## Kiểm tra provider độc lập — T1

Script smoke đang được bổ sung theo audit: `scripts/live/test-tiktok-connection.mjs`. **Chỉ chạy khi file đã được bàn giao**; tài liệu này không khẳng định script đã chạy PASS. Từ project root, với Node đã có trên Path:

```powershell
node scripts/live/test-tiktok-connection.mjs hoamocyb
```

`hoamocyb` là ID công khai trong tình huống chẩn đoán, không phải xác nhận rằng tài khoản đang phát LIVE. Smoke cần có giới hạn thời gian, chỉ quan sát provider và ngắt kết nối sau kiểm tra; bỏ qua React/Supabase, không tạo session/ticket hoặc chốt đơn. Không khởi động channel listener để thay thế bước cô lập này.

Ghi kết quả thực tế: thời điểm thử, username chuẩn hóa, kiểm LIVE, tìm phòng, kết nối, có/không quan sát được chat hoặc viewer event, thời gian từng bước và mã lỗi đã lọc. Không nhận được bình luận khi không ai gửi chưa đủ để kết luận handler hỏng. Không có tài khoản đang LIVE, thiếu credential cần thiết hoặc provider bị giới hạn thì ghi **BLOCKED**, không thay bằng dữ liệu mẫu.

## Thứ tự kiểm tra từ nguồn đến màn hình

Đi theo thứ tự này để biết lỗi ở tầng nào. Chỉ chuyển sang bước sau khi có bằng chứng của bước trước hoặc đã ghi rõ giới hạn.

| Bước | Kiểm tra và bằng chứng cần giữ | Cách phân biệt lỗi |
|---|---|---|
| 1. Sức khỏe listener | Terminal đúng tiến trình còn hoạt động; Auth và quyền workspace hợp lệ; trạng thái đọc điều khiển | Hiện chưa có health/readiness đầy đủ cho frontend. `/health` cổng máy in không chứng minh listener sống. Không có listener thì CONNECT chỉ có intent |
| 2. Provider độc lập | Kết quả smoke T1 theo phiên bản đã cài | Smoke thất bại trước Supabase thì kiểm provider/runtime trước khi sửa danh sách bình luận |
| 3. Username | `@hoamocyb`, `hoamocyb`, khoảng trắng đầu/cuối phải về cùng ID canonical | Không truyền URL hồ sơ, tên hiển thị hoặc `@` thừa vào adapter. ID có số như `chidi.vibes2` được hỗ trợ |
| 4. Kiểm LIVE/tìm room | Phân biệt kết quả không LIVE với lỗi tìm phòng; giữ mã phòng nguồn chính xác dưới dạng chuỗi | Chưa xác nhận LIVE thì không tạo campaign/session để che lỗi. Không dùng UUID session ERP thay ID phòng TikTok |
| 5. WebSocket | Kết nối thật, đúng room, deadline và ngắt có kết quả rõ | CONNECTING không phải bằng chứng socket đã mở. Lỗi mạng không đồng nghĩa TikTok đã kết thúc LIVE |
| 6. Event provider | Quan sát CHAT, ROOM_USER hoặc STREAM_END đúng phiên bản | Audit 2.5.0/v3: chat dùng `user.id`, `content`, `common.msgId/createTime`; ROOM_USER dùng `total`, không lấy `totalUser` làm số người xem hiện tại |
| 7. Chuẩn hóa | ID sự kiện/người dùng là chuỗi; text/timestamp hợp lệ; dữ liệu không được tự biến thành sale | Lỗi payload v3 có thể dừng intake trước khi vào queue/DB. Giữ diagnostic đã lọc; không ghi cả payload chứa thông tin nhạy cảm vào báo cáo |
| 8. Database/ingest | Workspace/session/actor/revision/lease đúng; RPC trả ACK inserted/duplicates; queue giảm sau ACK | Mạng/Auth/RLS/lease hoặc ACK thiếu thì queue phải giữ nguyên. Bình luận nhận được không làm tăng ticket, tồn giữ hoặc doanh thu |
| 9. Realtime/read API | Đọc được comment đã lưu; subscription đúng workspace, cleanup đúng, fallback poll hoạt động | Token listener không được đưa vào publication. Kênh kết nối hiện được đọc qua poll; mất Realtime không được kết luận DB mất dữ liệu |
| 10. Giao diện | Đúng channel/session, bộ lọc/trang bình luận, trạng thái mới nhất; metrics lấy từ dữ liệu xác nhận | Poll hiện khoảng 10 giây khi tab đang hiển thị. Số người xem chưa có pipeline ở baseline; `—` khác `0` |

Source đối chiếu: [provider](../../services/live-bridge/tiktok-channel-provider.mjs), [supervisor](../../services/live-bridge/channel-supervisor.mjs), [worker](../../services/live-bridge/intake-worker.mjs), [normalizer/queue/client](../../services/live-bridge/intake-core.mjs), [repository](../../src/lib/repository.js), [UI TikTok](../../src/features/TikTokChannels.jsx), [LiveCommerce](../../src/features/LiveCommerce.jsx).

## Đọc dữ liệu và metadata an toàn

Trong project thử, xác nhận schema 001–011 và các prerequisite đã cài thành công. **Không chạy lại 001/002/003 hoặc SQL đã thành công** để chữa biểu tượng chờ. Không dùng dữ liệu shop cho thử nghiệm gây lỗi.

Các verifier hiện có chỉ đọc metadata/tổng số:

- [verify_tiktok_channels.sql](../../supabase/verification/verify_tiktok_channels.sql): RLS, quyền RPC, FK/mapping, token và publication.
- [verify_tiktok_lifecycle.sql](../../supabase/verification/verify_tiktok_lifecycle.sql): bổ sung 011 và tính nhất quán kết thúc phiên.

Chạy bằng công cụ quản trị của đúng môi trường khi đã có quyền đọc; lưu kết quả JSON đã kiểm tra, không xuất nội dung `.env`, mật khẩu, access/refresh token, cookie hoặc secret. PASS metadata không chứng minh Auth/Realtime/provider chạy đúng. Một thử nghiệm simulator đi qua database/Realtime có ghi dữ liệu thử, nên chỉ chạy trong workspace thử đã xác định và trong phạm vi được phép.

## Xử lý theo dấu hiệu

| Dấu hiệu | Hành động tiếp theo |
|---|---|
| CONNECTING kéo dài | Xác nhận listener trước; nếu chưa có thì cấu hình/khởi động trong môi trường thử. Ghi lỗi thiếu timeout theo T0; không tự gán LIVE |
| `Vui lòng bật live` | Kiểm kênh đang chọn và LIVE thật; bật LIVE rồi thử lại |
| `WORKER_LOGIN_STOPPED` / `CHANNEL_CONTROL_UNAVAILABLE` | Kiểm cấu hình service, đăng nhập ERP, quyền workspace và schema; không gửi credential vào chat/log |
| `WORKER_SLOT_BUSY` | Kiểm listener cũ/cổng khóa đang được giữ; tránh chạy hai worker cùng scope. Không xóa queue để vượt khóa |
| `TIKTOK_CHANNEL_USED` | Nếu chưa có phiên, đối chiếu 011 đã cài. Nếu đã có lịch sử, dùng **LƯU THÀNH TIKTOK ID MỚI** và giữ lịch sử nguồn |
| `TIKTOK_LISTENER_STALE` / `TIKTOK_INGEST_STALE` | Đối chiếu revision/lease và yêu cầu CONNECT/DISCONNECT mới; callback cũ bị chặn là bảo vệ dữ liệu, không được bỏ kiểm tra server |
| Provider báo chat nhưng UI trống | Kiểm payload v3 → queue → ACK → DB → đúng session/bộ lọc/trang → Realtime/poll |
| Số người xem là `—` | Baseline chưa có pipeline viewer; không điền số đoán hoặc dùng lượt vào phòng cộng dồn |
| STREAM_END | Đối chiếu 011 đã kết thúc đúng phiên, giữ lịch sử/STT/ticket; callback cũ không được mở lại phiên |
| In lỗi | Kiểm hàng đợi in riêng; không chốt lại cùng bình luận để in lại |

## Kết quả cần có trước nghiệm thu

Ghi từng gate **PASS / PARTIAL / BLOCKED**, không gộp kết quả local thành PASS production:

1. **T1:** smoke provider kết nối kênh đang LIVE hoặc xác định được blocker bên ngoài.
2. **T2:** simulator COMMENT, VIEWER_COUNT, MEMBER_JOIN đi qua các tầng dự kiến trong môi trường thử; giữ rõ nguồn mô phỏng.
3. **T3:** ít nhất một event thật từ đúng phòng; viewer chỉ công bố khi có dữ liệu provider đúng nghĩa.
4. **T4:** event lưu một lần, refetch/Realtime khôi phục đúng; đọc lại vẫn giữ lịch sử.
5. **T5:** timeout, retry, restart, trùng event, ngắt và STREAM_END không làm trùng listener/session/ticket hoặc mất queue đã nhận.
6. **T6:** người bán thao tác được, lỗi được giải thích, chẩn đoán không lộ secrets; cập nhật biên bản bằng chứng thực tế.

T0 đã chỉ ra điểm thiếu runtime và các lỗi code cần sửa. Các gate tiếp theo vẫn chờ bằng chứng trong action mới. Khi không có LIVE thật hoặc chưa có workspace thử phù hợp, dừng ở gate tương ứng và ghi đúng điều kiện cần bổ sung; không dùng production để vượt bước kiểm tra.
