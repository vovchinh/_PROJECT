# Phase C — đối chiếu prompt FLIVE với V2

**Cập nhật 23/09/2026 — phạm vi hiện tại đã thu hẹp:** hoàn thành riêng luồng **TikTok ID → KẾT NỐI LIVE** bằng migration 010 trên nền 009. Kênh mặc định/nhiều kênh, xác minh LIVE phía listener, campaign tự động theo ngày Việt Nam, session theo phòng nguồn, STT liên tục và ngắt/kết nối lại đã có kiểm thử local. Xem [hướng dẫn](../TIKTOK_CHANNEL_SETUP.md) và [verification mới](../verification/TIKTOK_CHANNEL_VERIFICATION.md).

Bảng dưới là đối chiếu prompt rộng ngày 22/09, không phải danh sách tất cả đã hoàn thành. 009 có nền operations, registry bình luận, timestamp và cấu hình in; phần UI quản trị máy in/preview/bỏ qua bình luận còn cần action riêng nếu được yêu cầu. Không mở rộng chúng trong đợt chỉnh luồng TikTok. Nghiệm thu Supabase, TikTok và ZYWELL thật vẫn chờ.

Ngày 22/09/2026. Nguồn yêu cầu: [CODEX_PHASE_C_FLIVE_LIVE_COMMERCE.md](CODEX_PHASE_C_FLIVE_LIVE_COMMERCE.md), [AGENTS](../AGENTS.md). Baseline trước thay đổi: 288 kiểm tra lõi/database + 41 UI + 5 demo PASS; native concurrency và service đã có bằng chứng riêng. Đây là mở rộng Phase C đang hoạt động, không tạo ứng dụng song song.

| Nhóm | Phân loại | Quyết định tương thích |
|---|---|---|
| CHỐT & IN, claim, ticket/cart/STT, holds, VOID, retry, attempts | EXISTS_AND_COMPATIBLE | Giữ RPC 007/008 và ID/SKU/lots/FIFO; không viết lại commit |
| Feed/parser | EXISTS_NEEDS_EXTENSION | Bổ sung dữ liệu nguồn tùy chọn, bỏ qua/khôi phục có audit, preview tồn; thêm ít nhất 100 ca tiếng Việt |
| Trạng thái PARSED/READY/AMBIGUOUS/OUT_OF_STOCK | EXISTS_CONFLICTS | Là kết quả gợi ý/preview có thể thay đổi, tách khỏi trạng thái bán authoritative `new/committed/voided`; không đồng nhất parser với sale |
| Dedupe | EXISTS_NEEDS_EXTENSION | Giữ khóa lịch sử theo session; thêm registry cho ID nguồn TikTok mới theo workspace/provider. Xung đột lịch sử được báo để đối chiếu, không xóa/gộp bình luận cũ |
| Kết nối từ web | EXISTS_NEEDS_EXTENSION | Desired state + sự kiện outbox có request ID; supervisor local đọc yêu cầu và chạy/dừng adapter. Chỉ heartbeat worker chứng minh có kết nối |
| Thời lượng/lịch sử | EXISTS_NEEDS_EXTENSION | Thêm thời điểm bắt đầu/kết thúc server cho hoạt động mới; cũ giữ NULL. Thêm thống kê server theo phiên và bộ lọc ngày |
| Reset STT | EXISTS_CONFLICTS | STT hiện lấy max đã cấp + 1. Chỉ xác nhận khởi đầu #001 khi campaign nháp chưa bắt đầu/chưa cấp số; không đổi số đã cấp |
| Printer devices/profiles/templates | MISSING | Migration mới lưu cấu hình không secret, giới hạn driver có thể chạy; mẫu cấu hình chụp vào job mới, job cũ dùng mặc định |
| Template/test print/health | EXISTS_NEEDS_EXTENSION | USB/system và ESC/POS LAN, tùy chọn hiển thị/khổ/cỡ chữ; test/probe không ghi sale. Bluetooth/TSPL chưa hỗ trợ runtime được ghi rõ |
| Cart summary | EXISTS_AND_COMPATIBLE | Tổng giỏ chỉ đọc từ tickets; không tạo Final Order/cọc/Zalo |
| Tính năng D/E/F, Facebook/minigame | DEFER | Giữ ngoài Phase C theo prompt |

Migration kế tiếp: `009_live_operations.sql`, chỉ thêm schema/trigger/RPC tương thích sau 008. Không sửa 001–008; không backfill username, avatar, thời lượng hoặc người xác nhận từ suy đoán. Mọi bảng mới có RLS, FK workspace và quyền ghi RPC; actor lấy `auth.uid()`.

Thứ tự: (1) schema và kiểm thử upgrade/RLS; (2) supervisor và runtime in; (3) nối UI thao tác/preview/lịch sử; (4) targeted tests rồi hồi quy cuối; (5) cập nhật tài liệu, verifier và hướng dẫn cài 009. Mã frontend cũ vẫn đọc/ghi được sau migration, các chức năng mới báo rõ khi thiếu 009.

Khôi phục: dừng supervisor và thao tác mới, giữ ticket/hold/attempt; sửa tiến bằng migration mới. Không hạ hàm kho hoặc xóa dữ liệu để quay lại giao diện. Nghiệm thu Supabase/TikTok/ZYWELL thật và backup vẫn là bước vận hành cần bằng chứng thực tế.
