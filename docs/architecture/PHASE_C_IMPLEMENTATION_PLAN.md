# Phase C — kế hoạch triển khai trên nền V2 + Phase B

**Ưu tiên 25/09/2026:** [audit kết nối](../verification/TIKTOK_LIVE_CONNECTIVITY_AUDIT.md) đã chứng minh thiếu listener tại máy, lỗi đọc chat v3 và CONNECTING không có thời hạn; viewer pipeline chưa có. Cần hoàn thành gate T1–T6 trong prompt chẩn đoán trước nghiệm thu vận hành. Kết quả local 24/09 dưới đây giữ làm baseline, không bao phủ sự kiện TikTok thật.

**Action 24/09 hoàn tất local:** 011 giải quyết `TIKTOK_CHANNEL_USED` khi chưa có phiên, tự ngắt từ STREAM_END và thông báo offline theo yêu cầu. Listener nhận bình luận sau CONNECT không qua phê duyệt. 540 check, 57 UI, 77 service, 18 native concurrency và build PASS; [verification](../verification/TIKTOK_CHANNEL_VERIFICATION.md). Bước còn lại trong action là triển khai/nghiệm thu môi trường thật theo [hướng dẫn](../TIKTOK_CHANNEL_SETUP.md), không tiếp tục Phase D/E/F.

Kế hoạch gốc ngày 17/09/2026; cập nhật **23/09/2026** theo phạm vi mới nhất: chỉ đơn giản hóa **thiết lập TikTok ID và kết nối LIVE**. Nội dung Phase C rộng hơn và bàn giao UI ngày 22/09 được giữ làm lịch sử. Theo [AGENTS.md](../AGENTS.md), không đánh dấu cloud Phase B/A1 đã nghiệm thu và không mở Phase D/E/F.

## Phần đã thực hiện trong phạm vi ngày 23/09/2026

| Việc | Kết quả / giới hạn |
|---|---|
| Tái sử dụng nền | Account 007, ticket/cart/STT 008, kho/holds 006 và dependency 009 giữ nguyên; không tạo app hoặc hệ thống tồn riêng |
| Luồng người bán | Màn TikTok ID/default/kết nối là mặc định; không buộc nhập campaign/session/room. Thủ công/mô phỏng vẫn có lối vào riêng |
| Ý định và xác nhận kết nối | 010 lưu revision/outbox; supervisor nhận lease rồi kiểm provider. OFFLINE/ERROR không tạo phiên; LIVE hợp lệ mới chọn campaign ngày Việt Nam/session phòng nguồn |
| Tính liên tục | Cùng kênh/phòng/ngày kết nối lại dùng session cũ; phòng mới cùng ngày giữ campaign và STT/giỏ của cùng khách nguồn |
| Bảo vệ phía server | RLS/FK theo workspace, actor từ Auth, token riêng, chặn ingestion/báo cáo cũ sau disconnect/reconnect, chặn sửa username đã có yêu cầu qua cả đường account cũ |
| Bằng chứng | Suite kênh **23/23 PASS** gồm 12 tình huống yêu cầu và verifier chỉ đọc/corruption rollback; `npm run check` **521 PASS**, build PASS, demo **5/5**, service **68/68** |
| Kiểm tra bổ sung ngày 24/09 | UI **53/53 PASS**; thu gọn mobile để nút kết nối không bị che, 12 luồng TikTok và build PASS sau chỉnh bố cục. Native **15/15 PASS** với migrations 001–010, gồm 7 ca kết nối mới |
| Chưa kết luận | Supabase/Auth, TikTok và ZYWELL thật vẫn thuộc C7, A1 giữ nguyên; không coi mọi phần mở rộng FLIVE/009 đã nghiệm thu |

Phần mở rộng 009 đã cung cấp schema/control cần cho 010; checkpoint local 10 nhóm không chứng minh hoàn thành mọi yêu cầu FLIVE, printer settings hoặc vận hành thực. Phạm vi bàn giao này chỉ kết luận cho luồng kênh nói trên. Chi tiết tại [verification TikTok Channel](../verification/TIKTOK_CHANNEL_VERIFICATION.md), đường áp dụng/khôi phục tại [migration plan](V2_MIGRATION_PLAN.md).

## Lịch sử — kết quả bàn giao ngày 22/09/2026

Đã hoàn thiện [giao diện theo ảnh tham chiếu](PHASE_C_UI_UX.md): bàn live có tìm/lọc bình luận, giỏ và chi tiết theo STT gốc, lịch sử phiên, hàng đợi theo giỏ, báo cáo theo ngày nghiệp vụ và thiết lập/mẫu in thử. Mobile có điều hướng dưới, thu gọn thống kê/kết nối và mặc định chỉ xếp hàng đợi để máy tính nhận in. Không lấy khách/số tiền trong ảnh làm dữ liệu shop, không suy ngày tạo phiên thành thời lượng, không coi giá trị phiếu là doanh thu.

| Action | Kết quả local cuối |
|---|---|
| C3 | Parser giữ vai trò gợi ý; helper read model Live **10/10 unit tests PASS** về BigInt, VOID, khoảng ngày, STT và giá trị chưa rõ |
| C4 | **23/23 Live UI tests PASS** = 13 luồng cũ + 10 UX mới; fixture API, screenshot 390px/1280px, queue-only và mẫu IN-THU 0 đ không ghi nghiệp vụ |
| C5 | **27/27 service tests PASS**; dừng worker chờ ghi queue/RPC, dừng lặp lại và startup muộn, deadline spool 15 giây, render tiếng Việt bằng Edge local |
| C7 | **PENDING** — áp dụng/nghiệm thu Supabase/Auth, tài khoản TikTok và máy ZYWELL thật; không đóng bằng kết quả fixture |

Hồi quy trên mã đã đóng băng: `npm run check` **288 PASS** = 56 unit + 25 core DB + 41 operations + 40 catalog + 36 customers + 24 inventory + 25 intake + 27 commerce + 14 verification; build PASS. Toàn bộ cloud UI mô phỏng **41/41**, demo **5/5 PASS**. [Verification Phase C](../verification/PHASE_C_VERIFICATION.md) ghi phạm vi bằng chứng; **A1 giữ nguyên trạng thái**, không sửa lịch sử 001–006 và không mở Phase D trở đi. UI mới không cần migration bổ sung.

## Dependency đã kiểm tra khi lập kế hoạch ngày 17/09/2026

Repository có migrations 001–006, catalog/alias resolver, identities/addresses, FIFO, reservations và order/payment skeleton. Phase B có 223 kiểm tra PASS local, gồm 7 native concurrency. ID SKU/ledger cũ không thay đổi. Chưa có ingestion worker, campaign/session, ticket/cart hoặc print bridge. Code cloud dùng RLS, RPC, Auth/workspace; React JavaScript và Supabase giữ nguyên.

Cloud migrations/metadata và backup thật còn chờ bằng chứng. Đường Phase C yêu cầu 006 thành công; không chạy lại migration lịch sử. Lỗi 003/55006 khi nâng cấp V1 có dữ liệu vẫn thuộc A1; không thể sửa bằng file chạy sau 003. Không sửa 001–006.

## Phân chia công việc

| Action | Thay đổi | Nghiệm thu bắt buộc |
|---|---|---|
| C1 | 007: account TikTok không chứa secret, campaigns/sessions, normalized comments, ingestion dedupe, claim lease | Upgrade/clean, role/RLS, FK workspace, duplicate/conflict, hai người claim, không có stock/sale khi ingest |
| C2 | 008: ticket/cart/STT, reservation, print job/attempt và outbox; commit/VOID/reprint | Transaction rollback toàn bộ, replay UUID, một comment một ticket, giữ tồn chung, bảo vệ live hold khỏi thao tác manual, ledger không đổi |
| C3 | Parser xác định bằng SKU/alias/thuộc tính rõ; chỉ gợi ý | Unicode, số lượng, alias mơ hồ, SKU tạm, token không rõ, không tạo bán/giữ tồn |
| C4 | UI chiến dịch/live board/giỏ/hàng đợi in/setup; realtime và polling phục hồi | Chọn workspace, response muộn, quyền, popup/lỗi in, retry, mobile, không auto-commit bình luận |
| C5 | Browser print + local bridge ZYWELL LAN, USB qua driver; worker TikTok có adapter/simulator | Escape dữ liệu phiếu, không suy afterprint thành đã in, FIFO queue/retry, token/origin bridge, không lộ secret frontend |
| C6 | Native PostgreSQL concurrency, hồi quy, metadata verification và tài liệu | Cùng comment/hàng cuối chỉ một commit; reprint không nhân đôi ticket/cart/reservation; cloud/thiết bị thật báo đúng mức bằng chứng |

## Quyết định và ranh giới

- `COMMENT != SALE`. Ingest, parser và claim không giữ hàng. Chỉ RPC CHỐT & IN được tạo ticket, cart item, reservation, print job, audit và outbox trong một transaction.
- Claim có lease; owner của claim và token được kiểm phía server. Cùng UUID nhưng khác payload bị từ chối. Một comment đã chốt hoặc VOID không được chốt lại bằng request mới.
- STT khách cố định trong campaign, xuyên session theo provider + stable external user ID; tên hiển thị không phải định danh. Khách chưa liên kết ERP giữ customer_id NULL, không tự dựng sự thật danh tính.
- Ticket giữ snapshot SKU/giá/khách. Cart dựa trên active committed items; chưa convert sang order, chưa gửi Zalo/thu cọc/COD (Phase D/F).
- Inventory dùng lại `inventory_reservations` và lots của 006. Live hold có ràng buộc riêng để không bị release/transfer thủ công bỏ qua ticket. VOID là thao tác giải phóng hợp lệ; không hard-delete.
- Một business print job cho mỗi ticket; retry/reprint tạo attempt trên cùng job. Lease/token ngăn hai máy cùng nhận job. Không đảm bảo exactly-once giấy khi mất phản hồi mạng; trạng thái chưa rõ phải được người vận hành đối chiếu trước khi in lại.
- Web setup lưu tên hồ sơ, TikTok handle và trạng thái kết nối; không lưu password/cookie/API secret trong public table hoặc VITE variables. Worker giữ credentials ở môi trường server/local riêng.
- TikTok connector là adapter thay thế được, có simulator/import để vận hành thử độc lập. Không hứa kết nối chính thức hoặc đã nghiệm thu tài khoản nếu chưa kết nối thật.
- ZYWELL USB dùng driver và hộp thoại in hệ điều hành. LAN bridge dùng địa chỉ máy in cấu hình cố định, loopback auth/origin check; dữ liệu phiếu đi sau DB commit. Nghiệm thu giấy, khổ giấy và font Việt cần thiết bị thật.
- Realtime chỉ kích hoạt đọc lại; polling/manual refresh khôi phục khi mất sự kiện. Workspace RLS vẫn quyết định dữ liệu.

## Rủi ro và khôi phục

Không migration business data cũ vào tickets. Nếu triển khai thất bại, rollback transaction của file đang chạy; không chạy lại file đã thành công. Sau khi phát sinh live holds, ngừng ingestion/commit mới và sửa tiến bằng migration mới; không hạ hàm tồn bỏ qua reservations. Giữ ticket/attempt/audit để đối chiếu giấy và dữ liệu; không xóa dữ liệu thử trên cloud tự động.

## Nguồn kỹ thuật

- [Supabase Postgres Changes](https://supabase.com/docs/guides/realtime/subscribing-to-database-changes): publication và subscription; cần RLS và cleanup theo workspace.
- [MDN afterprint](https://developer.mozilla.org/en-US/docs/Web/API/Window/afterprint_event): đóng chế độ xem/in không chứng minh giấy đã ra; cần xác nhận riêng.
- [TikTok Live Connector](https://github.com/zerodytrash/TikTok-Live-Connector): adapter bên thứ ba, không coi là API chính thức hoặc mặc định production-ready. Chi tiết dependency/cách vận hành ghi ở service README khi triển khai.

Phần dependency/phân chia công việc giữ bối cảnh kế hoạch gốc. Kết quả 22/09 và [verification Phase C](../verification/PHASE_C_VERIFICATION.md) là bằng chứng lịch sử; phần TikTok ngày 23/09 ở đầu tài liệu mô tả phạm vi mới nhất. C7 vẫn cần bằng chứng môi trường thật, không đánh dấu PASS chỉ vì có code hoặc fixture local.
