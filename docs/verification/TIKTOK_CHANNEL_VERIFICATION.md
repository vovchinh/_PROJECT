# Verification — TikTok ID và KẾT NỐI LIVE

Triển khai ngày 23/09/2026; cập nhật **24/09/2026** với migration 011 theo lỗi người dùng cung cấp: sửa ID bị khóa sau CONNECT chưa có phiên, thông báo offline, tự kết thúc LIVE và nhận bình luận không cần phê duyệt. Dùng lại Phase C; không triển khai các phần còn lại của prompt FLIVE hoặc Phase D/E/F. [Hướng dẫn vận hành](../TIKTOK_CHANNEL_SETUP.md) ghi thứ tự cài đặt và cách tạm dừng an toàn.

## Kết quả tại máy

| Lệnh / bộ kiểm tra | Kết quả | Phạm vi bằng chứng |
|---|---|---|
| `npm run check` | **540 PASS**, build PASS | 256 unit + 25 core DB + 41 operations + 40 catalog + 36 customers + 24 inventory + 25 intake + 27 commerce + 14 verifier Phase C + 10 operations Live + 23 TikTok channels + 19 lifecycle 011 |
| `npm run test:tiktok-channels` | **23/23 PASS**, nằm trong check | Clean 001–010; upgrade từ dữ liệu 008; 12 tình huống yêu cầu; quyền/RLS/lease; đối chiếu SQL verifier |
| `npm run test:cloud-ui` | **57/57 PASS** | 6 Auth + 12 Phase B + 23 Phase C cũ + 16 luồng TikTok; API fixture, không phải Supabase thật |
| `npm run test:e2e` | **5/5 PASS** | Các luồng demo nhập hàng, thu chi, import và mobile |
| `npm run test:live-services` | **77/77 PASS**, không skip | 28 channel supervisor + 15 session supervisor + 34 worker/print bridge; gồm STREAM_END/drain/retry; không kết nối TikTok/máy in thật |
| `npm run test:builds` | **5/5 PASS** | Chặn secret/service-role trước bundling, demo/cloud build và khôi phục build cấu hình hiện tại |
| `npm run test:live-concurrency` | **18/18 PASS** | PostgreSQL 14.3 cô lập, 001–011; 8 ca nghiệp vụ cũ + 7 ca kết nối + 3 ca kết thúc LIVE; quan sát 17 cặp session chờ lock |

## Sửa lỗi 011 — bằng chứng bổ sung

- **19/19 database lifecycle PASS:** clean/upgrade giữ dữ liệu cũ; sửa `chidi.vibes` → `chidi.vibes2` sau CONNECT pending/offline hủy token cũ; đã có phiên vẫn bảo vệ tên nguồn qua cả RPC cũ và mới.
- Giao diện gõ từng phím khi thêm/sửa `chidi.vibes2`, không chỉ dùng `fill`; tên có số chưa từng bị regex từ chối. Lỗi người dùng gửi là `TIKTOK_CHANNEL_USED`, đã sửa điều kiện khóa trong migration mới.
- STREAM_END kết thúc phiên và ngắt kênh một lần, không đổi ticket/STT/giữ tồn/ledger. Cùng UUID trả kết quả cũ; đổi actor/payload, token cũ, workspace khác hoặc callback sau CONNECT mới bị chặn.
- Quyền kết thúc chấp nhận token hiện hành dù hết thời gian sau chờ gửi batch cuối, nhưng token đó vẫn không được ingest/gia hạn LIVE; lease mới hoặc revision mới vô hiệu hóa nó. Mất mạng không tự đánh dấu phiên đã kết thúc.
- Phát hiện và sửa trường hợp thử kết nối lại bị lỗi nguồn ghi đè trạng thái của phiên đã kết thúc: yêu cầu mới tách liên kết phiên hiện hành, lịch sử cũ giữ nguyên.
- [verify_tiktok_lifecycle.sql](../../supabase/verification/verify_tiktok_lifecycle.sql) kiểm 4 routine, ACL/search_path, constraint/trigger và đối chiếu kết thúc phiên/audit/outbox; kiểm thử cố ý làm sai rồi rollback. Chỉ trả metadata/tổng số, không dữ liệu cá nhân/token.

Các kiểm tra parser hiện có cộng corpus mở rộng là **202 PASS** trong bộ unit, không thay thuật toán thành cơ chế tự chốt. Mười kiểm tra của 009 là checkpoint tương thích/operations; không coi chúng là nghiệm thu đầy đủ mọi tính năng máy in trong prompt FLIVE.

Build có cảnh báo chunk chính vượt 500 kB; build thành công. Tối ưu bundle không thuộc thay đổi luồng TikTok này.

## Đối chiếu 12 tình huống yêu cầu

| Tình huống | Bằng chứng kiểm thử |
|---|---|
| Lưu một TikTok ID | RPC chỉ tạo/cập nhật kênh; giao diện không yêu cầu campaign/session/room |
| Username chuẩn hóa trùng | Bỏ `@` đầu, trim, lowercase; server từ chối trùng trong workspace |
| Workspace isolation | RPC, SELECT/RLS, actor và token không cho truy cập workspace khác |
| Kênh mặc định | Tối đa một kênh mặc định; chọn đúng khi vào trang; không tự đoán nếu dữ liệu cũ có nhiều kênh |
| Kết nối khi offline | Chỉ có yêu cầu/trạng thái; không tạo campaign/session hoặc sale |
| Kết nối khi LIVE | Listener xác minh phòng; báo LIVE tạo campaign/ngày và session qua server |
| Bấm kết nối lặp | Request idempotent; yêu cầu mới khi đang kết nối dùng revision hiện hành; không nhân đôi phiên |
| Ngắt kết nối | Vô hiệu hóa lease/revision cũ và chặn ingestion mới; giữ dữ liệu lịch sử |
| Kết nối lại | Cùng phòng nguồn/ngày dùng lại session; worker cũ không được ghi bằng token hết hiệu lực |
| Nhiều TikTok ID | Chọn đúng kênh; đổi kênh xóa feed/thống kê cũ trong lúc tải |
| Campaign cùng ngày | Khóa workspace/kênh/ngày `Asia/Ho_Chi_Minh`; nhiều phòng cùng ngày dùng chung campaign |
| STT liên tục | Chốt thật trên database tổng hợp qua hai session cùng campaign giữ số khách và giỏ, không ghi doanh thu/tiền |

Các trường hợp bổ sung: viewer chỉ đọc; staff không quản trị kênh/lease listener; token không xuất qua REST/Realtime; lease hết hạn; callback muộn; đổi workspace; heartbeat cũ không được hiển thị LIVE; vô hiệu hóa kênh; sửa username qua RPC cũ cũng bị chặn khi đã có yêu cầu kết nối. Manual/simulator vẫn qua các test UI và ingestion cũ.

Trong lần kiểm tra giao diện đã phát hiện nút SỬA đổi thành submit ngay trong cùng thao tác click. Đã tách key của nút và ngăn submit khi mở sửa; test thêm/sửa/chọn nhiều kênh PASS. Test phản hồi muộn được điều chỉnh để mở rõ chế độ thủ công sau khi đổi workspace; vẫn kiểm tra dữ liệu workspace cũ không ghi đè workspace mới. Ảnh 390px được kiểm tra trực tiếp: đã thu gọn phần trang trí để nút KẾT NỐI LIVE nằm hoàn toàn phía trên thanh điều hướng; thêm kiểm tra vị trí và đường vào Đổi TikTok ID. Sau thay đổi bố cục, 12 test TikTok và production build tiếp tục PASS.

## Bằng chứng database và vận hành

- `test-results/tiktok-channels.json`: 23 kiểm tra PostgreSQL cô lập qua PGlite, không dùng dữ liệu shop.
- `test-results/live-concurrency.json`: 18 ca native trên 001–011. Gồm CONNECT cùng/khác UUID, hai listener tranh lease, báo LIVE đồng thời, báo LIVE/ingest tranh với DISCONNECT, thay lease và các ca CHỐT/VOID/hàng cuối/in cũ. Ba ca mới: kết thúc đồng thời cùng UUID, kết thúc tranh với ngắt thủ công, kết thúc cũ tranh với CONNECT mới. Runner tạo cluster riêng trên loopback, kiểm đường dẫn sở hữu và dừng cluster sau chạy; không đọc `.env` hoặc dùng Supabase.
- `test-results/tiktok-lifecycle.json`: 19 ca migration 011, từ database tổng hợp, có kiểm bảo toàn dữ liệu khi nâng cấp từ 010.
- [verify_tiktok_channels.sql](../../supabase/verification/verify_tiktok_channels.sql): chạy bằng SQL Editor quản trị, chỉ đọc, trả một JSON metadata không có username, UUID nghiệp vụ, bình luận hoặc token. Kiểm bảng/FK/unique/RLS/RPC/guards, quyền lease và tất cả publications, đối chiếu mapping campaign/session. Các test cố ý làm sai metadata rồi rollback chứng minh verifier phát hiện lỗi.
- Migration 010 giữ nguyên product ID, ticket/cart/reservation/ledger và phiên lịch sử. Không suy ngày LIVE cho dữ liệu cũ; chỉ đặt mặc định khi có đúng một kênh hoạt động. Không sửa migrations 001–008.
- Token listener chỉ worker đang giữ lease được dùng. Ingestion quản lý qua RPC kiểm lease, revision, actor và session; không thể dùng RPC ingestion cũ để chèn bình luận mới vượt cơ chế này.

## Những phần chưa được nghiệm thu thực tế

Chưa chạy 009/010/011 trên Supabase của ChiDi trong phiên làm việc này; chưa xác nhận Auth/Realtime/publication của cloud bằng kết quả SQL Editor. Chưa phát LIVE bằng tài khoản TikTok thật, in giấy ZYWELL 822 USB/LAN, hoặc diễn tập backup/restore. A1/C7 không được đóng bằng fixture. Request kết thúc chờ retry hiện giữ trong bộ nhớ worker; tắt máy đột ngột trước ACK cần đối chiếu khi mở lại, không tuyên bố đã có terminal outbox bền vững phía worker.

Bằng chứng native concurrency 8 ca ngày 18/09 trước đây thuộc 007/008. Mốc mới ngày 24/09 đã chạy lại các ca đó cùng 7 ca kết nối 010 và 3 ca kết thúc 011 trên PostgreSQL 14.3. Đây là kiểm tra database tại máy; không thay thế kiểm tra publication/Realtime PostgreSQL 15+ hay provider thật.

Bước tiếp theo: theo [hướng dẫn TikTok](../TIKTOK_CHANNEL_SETUP.md), nếu đã cài 010 chỉ chạy 011; lưu kết quả verifier, khởi động lại listener và nghiệm thu offline → LIVE → TikTok kết thúc → tự ngắt trên môi trường thử.
