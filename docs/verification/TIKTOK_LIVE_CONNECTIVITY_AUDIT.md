# T0 — kiểm tra đường kết nối TikTok LIVE

Cập nhật **25/09/2026**: kiểm tra lại lúc 08:20 UTC vẫn không có listener Node tại máy và chưa có `services/live-bridge/.env`. Vite đang chạy. Kiểm tra chỉ đọc trên Supabase cho sáu bảng LIVE/kênh và ba RPC đọc đều trả **401 / 42501** với anonymous; điều này xác nhận endpoint có phản hồi và từ chối anonymous, chưa chứng minh Auth/workspace/RLS/Realtime đầu cuối hoặc đã áp dụng toàn bộ 011. Bằng chứng local: `test-results/tiktok-cloud-metadata.json`; không đọc dòng dữ liệu hay ghi cloud.

Đã tái hiện lỗi chat qua **encode/decode protobuf v3 thật của dependency đã cài** với dữ liệu tổng hợp: `user.id` và `content` giữ đúng chuỗi nhưng normalizer trả `INVALID_AUTHOR_ID`; chỉ thêm trường ID cũ thì tiếp tục lỗi `INVALID_TEXT`. Payload cũ `user.userId/comment` PASS. Vì vậy đây là lỗi hợp đồng adapter đã được chứng minh, không suy từ ảnh UI. Các ID dài hơn giới hạn Number vẫn phải giữ nguyên dạng chuỗi khi sửa.

Quy trình kiểm tra và khởi động listener dành cho quản trị viên: [runbook](../runbooks/TIKTOK_LIVE_TROUBLESHOOTING.md).

Ngày 24/09/2026. Nguồn: prompt `CODEX_TIKTOK_LIVE_CONNECTION_DIAGNOSE_COMPLETE.md`, `docs/AGENTS.md`, mã/migrations 001–011 và trạng thái tiến trình tại máy. Audit này được lập trước sửa product code trong action chẩn đoán mới. Các kiểm thử trước đây là bằng chứng local, không chứng minh đã kết nối TikTok thật.

## Phát hiện có bằng chứng

1. Có tiến trình Vite, **không có tiến trình channel/legacy listener hoặc printer bridge** trong danh sách Node hiện tại. `services/live-bridge/.env` không tồn tại; `.env.local` chỉ có cấu hình frontend. Không xuất URL/key/token ra báo cáo. Nếu listener được chạy ở máy khác thì chưa có bằng chứng về máy đó.
2. CONNECT ghi yêu cầu trong PostgreSQL rồi chờ một listener Node xử lý. Nút bấm không tự khởi động tiến trình Node. `START_CHIDI.cmd` chỉ mở web qua `scripts/start.ps1`.
3. `TikTokChannels.jsx` chỉ tính tuổi heartbeat cho trạng thái LIVE. CONNECTING/RECONNECTING không có hạn chờ và khóa nút kết nối; không có listener thì có thể chờ vô hạn.
4. Provider đã cài đúng `tiktok-live-connector` **2.5.0**. Trong code thư viện, nhánh WebSocket đóng trước khi mở có thể bỏ timeout mà không settle connect promise. Probe hiện không có deadline tổng để chặn trường hợp này. Cấu hình HTTP timeout truyền vào hiện tại cũng không được thư viện dùng đúng như mong đợi.
5. Provider có sự kiện `WebcastEvent.ROOM_USER` (`roomUser`), nhưng bản 2.5.0 đang dùng protobuf **v3**: số người xem hiện tại là `total` (chuỗi), không phải `viewerCount` của v1/v2; `totalUser` là trường khác. Chưa có handler → normalize → persist → UI cho chỉ số này.
6. **Sai hợp đồng chat của phiên bản đã cài:** provider import `tiktok-live-proto/v3`; payload thật dùng `user.id`, `content`, `common.msgId/createTime`. Normalizer đang đọc `user.userId` và `comment` theo kiểu cũ. Chat v3 có thể bị từ chối `INVALID_AUTHOR_ID` rồi dừng intake. Các fixture cũ chưa bao phủ payload v3 thật. Đây là lỗi mã độc lập với việc listener chưa chạy.

## Bản đồ T0

| Mắt xích | Phân loại | Bằng chứng / khoảng thiếu |
|---|---|---|
| Cấu hình kênh | IMPLEMENTED | `TikTokChannels.jsx`, `save_tiktok_channel`; chuẩn hóa, RLS, default, bảo vệ lịch sử qua 011 |
| Nút CONNECT | IMPLEMENTED | `requestTikTokConnection` → `request_tiktok_connection`; chỉ tạo intent/outbox có revision |
| State machine frontend | BROKEN | CONNECTING không có deadline; stale LIVE chỉ đổi sang RECONNECTING không có điểm dừng |
| Repository RPC | PARTIAL | `repository.js`; scoped/authenticated nhưng không có deadline riêng cho yêu cầu kết nối |
| Listener Node | IMPLEMENTED / runtime MISSING | `channel-supervisor.mjs`; không có tiến trình tại máy và thiếu service `.env` |
| Provider/version | IMPLEMENTED | `tiktok-live-connector@2.5.0` có trong service node_modules và lockfile |
| Chuẩn hóa username | PARTIAL | Regex/trim/lowercase có ở UI, SQL và adapter; chưa dùng chung một helper JavaScript |
| Kiểm LIVE / lookup room | PARTIAL / UNVERIFIED thật | `probeTikTokChannel`: fetchIsLive rồi connect lấy room; thiếu phân loại/timing từng bước |
| WebSocket | PARTIAL / UNVERIFIED thật | Adapter kiểm đúng room ID; thiếu deadline tổng, có đường provider không settle |
| Chat handler | BROKEN với payload v3 | Handler CHAT/queue/RPC có, nhưng `intake-core.mjs` đọc trường cũ không khớp installed 2.5.0/v3; cần sửa và kiểm chứng event thật |
| Viewer handler | MISSING | Thư viện có ROOM_USER; chưa đăng ký handler và chưa có read model số người xem |
| Session persistence | IMPLEMENTED | 010 mapping workspace/channel/ngày/phòng; 011 kết thúc idempotent |
| Trusted ingest | IMPLEMENTED | `ingest_tiktok_comments`, lease/revision/actor, giới hạn batch và dedupe; không dùng service-role frontend |
| Realtime | PARTIAL / UNVERIFIED cloud | `watchLive` có cleanup/filter workspace; kênh có token được đọc qua poll. Khi reconnect Realtime chưa refetch ngay |
| UI read/metrics | PARTIAL | LiveCommerce poll 10s; có comments/STT/qty; thiếu viewer/current/peak và đồng hồ giây độc lập |
| Ngắt/kết nối lại | IMPLEMENTED / UNVERIFIED thật | Lease, backoff, STREAM_END và 011 có test local; chưa đo provider thật |
| Log/error | PARTIAL | Log an toàn nhưng phần lớn lỗi bị gộp, thiếu correlation và panel admin |
| Listener health/readiness | MISSING | Printer có health riêng; không phải health của listener. Chưa có read model readiness cho web |
| Timeout | BROKEN | Không có hạn tổng probe/connect hoặc yêu cầu chờ listener ở UI |
| Simulator end-to-end | PARTIAL | Có NDJSON comment/DB/UI fixtures riêng; chưa có bài chứng minh COMMENT + VIEWER_COUNT + MEMBER_JOIN qua toàn tuyến |

## Bối cảnh thay thế

Repository hiện dùng `V2_CURRENT_STATE.md`, `V2_MIGRATION_PLAN.md`, `PHASE_C_IMPLEMENTATION_PLAN.md`, `TIKTOK_CHANNEL_VERIFICATION.md`, `TIKTOK_CHANNEL_SETUP.md` và service README làm tương đương bộ context trong prompt. Không tạo lại kiến trúc vì tên context mới chưa được dùng ở repository.

Baseline gần nhất: 540 check, 57 UI, 77 service, 18 native concurrency và build PASS, migrations 001–011. Baseline không bao gồm viewer event và không xác nhận listener đã được cài/chạy ở máy shop.

## Các gate tiếp theo

- T0: PASS — đã xác định bản đồ và lỗi chờ vô hạn/thiếu runtime/viewer pipeline.
- T1: Chạy smoke provider có timeout, chỉ quan sát kênh công khai, không Supabase và không chốt đơn.
- T2–T6: Chưa nghiệm thu. Chỉ dùng workspace thử; không chạy migration hoặc ghi vào Supabase production khi chưa có ủy quyền rõ.

Chưa kết luận nguyên nhân phía TikTok hoặc rằng tài khoản đang LIVE. Cần bằng chứng T1 và môi trường thử trước khi tuyên bố hệ thống vận hành thực tế.
