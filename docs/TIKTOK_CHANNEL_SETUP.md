# TikTok ID → KẾT NỐI LIVE

**Lưu ý từ kiểm tra 25/09/2026:** mã hiện tại chưa được nghiệm thu TikTok thật. Đã tái hiện lỗi định dạng chat của connector 2.5.0 và phát hiện máy chưa chạy listener; viewer pipeline chưa có. Theo [audit](verification/TIKTOK_LIVE_CONNECTIVITY_AUDIT.md) và [runbook](runbooks/TIKTOK_LIVE_TROUBLESHOOTING.md) để xác định từng lỗi. Chỉ cài 011 hoặc mở web chưa giải quyết đủ những phần này.

Cập nhật **24/09/2026**. Đây là luồng vận hành đơn giản theo hai ảnh `add_TikTokID.jpg` và `ConnectTiktokLive.jpg`. Username là tên kênh công khai, không phải đăng nhập/OAuth TikTok.

## Sửa lỗi ID và tự ngắt khi kết thúc LIVE — bản 011

ID có số như **chidi.vibes2** được hỗ trợ. Lỗi `TIKTOK_CHANNEL_USED` từng xuất hiện vì bản 010 khóa sửa ngay sau một lần yêu cầu kết nối, kể cả chưa có phiên LIVE. [Migration 011](../supabase/migrations/011_tiktok_live_end.sql) cho phép sửa ID chưa có phiên: yêu cầu cũ bị hủy và listener cũ mất quyền ghi. Nếu đã có lịch sử phiên, chọn **LƯU THÀNH TIKTOK ID MỚI**; tên kênh và phiếu cũ được giữ nguyên.

Bấm **KẾT NỐI LIVE** không cần người khác phê duyệt. Listener đã cấu hình sẽ tự kiểm tra kênh và bắt bình luận. Chưa phát LIVE thì hiện đúng **Vui lòng bật live**. Khi TikTok báo phiên kết thúc, hệ thống tự ngắt, kết thúc phiên và giữ bình luận/phiếu/giỏ/STT; không tự nối lại phiên đã kết thúc. Mất mạng tạm thời vẫn theo cơ chế thử kết nối lại, không tự suy thành kết thúc LIVE.

Nếu đã cài 010, chỉ chạy 011 rồi khởi động lại listener bằng mã mới và tải lại web. Chạy thêm [verify_tiktok_lifecycle.sql](../supabase/verification/verify_tiktok_lifecycle.sql) để kiểm tra phần bổ sung. Không chạy lại migration cũ.

## Nhân viên bán hàng

1. Trong **Live · Chốt & In → Thiết lập**, chủ shop/quản lý nhập **TikTok ID**, ví dụ `@chidi.vibes2`, rồi **LƯU**. Có thể **THÊM TIKTOK ID** và chọn một kênh mặc định.
2. Trở lại **Bàn live**. Một kênh được hiển thị trực tiếp; nhiều kênh có danh sách chọn. **Đổi TikTok ID** mở phần thiết lập.
3. Bật LIVE trong ứng dụng TikTok, rồi nhấn **KẾT NỐI LIVE**. Nếu chưa phát LIVE, hệ thống báo rõ để bật và thử lại. Khi listener xác nhận phòng đang LIVE, bình luận bắt đầu xuất hiện.

Không cần tạo chiến dịch, phiên, nhập room ID hoặc cấu hình listener trên màn hình bán hàng. Chủ shop cài listener một lần trên máy vận hành theo phần dưới. Nếu listener chưa chạy, nút kết nối chỉ ghi nhận yêu cầu; hệ thống không giả báo đã LIVE.

**NGẮT KẾT NỐI** dừng nhận bình luận mới; giữ phiếu, giỏ và lịch sử. Kết nối lại cùng phòng TikTok trong cùng ngày dùng lại phiên, không cấp lại STT hoặc chốt lại bình luận. Một buổi LIVE mới có thể tạo phiên khác nhưng vẫn dùng chiến dịch của kênh trong ngày Việt Nam. Các kênh có chiến dịch/STT riêng.

Màn hình cho biết trạng thái kết nối, thời lượng kết nối được xác nhận, số bình luận, sản phẩm đã chốt, STT đã cấp và số tiếp theo. Chưa có dữ liệu thì hiển thị dấu **—**. Trạng thái máy in không thay thế việc kiểm giấy thực tế. Không có nút reset STT không giới hạn.

**Thủ công / mô phỏng** mở công cụ vận hành nâng cao hiện có. Các trường chiến dịch/phiên/provider và thông tin quản trị được giữ ở chế độ này để tương thích; không nằm trong luồng bán hàng TikTok thông thường. Các bước chốt/kiểm giấy/VOID vẫn theo [hướng dẫn Phase C](PHASE_C_LIVE_COMMERCE.md).

## Quản trị viên thiết lập một lần

1. Xác nhận các migration đã cài thành công. Nếu project mới đến 008, chạy [009_live_operations.sql](../supabase/migrations/009_live_operations.sql) trước, rồi [010_tiktok_channel_flow.sql](../supabase/migrations/010_tiktok_channel_flow.sql), sau đó [011_tiktok_live_end.sql](../supabase/migrations/011_tiktok_live_end.sql). Chỉ chạy các file còn thiếu, mỗi file một lần; không chạy lại file đã thành công.
2. Kiểm tra trong môi trường thử trước dùng dữ liệu vận hành. Chạy [verify_tiktok_channels.sql](../supabase/verification/verify_tiktok_channels.sql) bằng SQL Editor và lưu JSON metadata; không gửi token/mật khẩu. Kiểm tra lịch sử migration riêng, không dùng giao diện trống làm bằng chứng cài xong.
3. Kho tự động dùng kho hiện có mã `CHIDI-MAIN` được bootstrap tạo. Nếu không còn mã này và có nhiều kho, quản lý cần xác định lại kho chính; hệ thống sẽ báo lỗi rõ thay vì tự chọn kho ngẫu nhiên.
4. Trên máy chạy listener, cài dependency trong `services/live-bridge` bằng `npm --prefix services/live-bridge ci --include=optional`. Cấu hình `.env` riêng của service gồm `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `LIVE_WORKSPACE_ID`. Không cần `LIVE_SESSION_ID` cho luồng kênh tự động.
5. Chạy `npm --prefix services/live-bridge run worker:channels:login`. Đăng nhập bằng tài khoản ERP owner/manager tại terminal; mật khẩu được che, token giữ trong bộ nhớ. Đây là đăng nhập **ERP cho listener**, không phải TikTok Login.
6. Giữ listener chạy, mở ERP và làm ba bước của nhân viên ở trên. Một listener theo workspace quản lý các kênh đang được yêu cầu kết nối. Không chạy đồng thời listener cũ cho cùng phiên tự động.

Máy vận hành giữ credentials. Frontend chỉ lưu username và sử dụng phiên ERP hiện có. Adapter TikTok là thư viện bên thứ ba, không phải API TikTok chính thức; phải nghiệm thu với kênh ChiDi đang phát LIVE. Thử nghiệm mô phỏng không xác nhận kết nối TikTok thật đã thành công.

## Khi có sự cố

| Hiển thị | Cách xử lý |
|---|---|
| Vui lòng bật live | Bật phát LIVE trên đúng kênh rồi nhấn kết nối lại |
| Phiên TikTok đã kết thúc | Hệ thống đã tự ngắt; bật buổi LIVE mới rồi nhấn kết nối khi sẵn sàng |
| Đang kết nối quá lâu | Kiểm tra listener đã chạy/đăng nhập đúng workspace; ngắt và thử lại khi listener sẵn sàng |
| Đang kết nối lại | Chờ listener kiểm tra nguồn; bình luận đã lưu và ticket vẫn giữ nguyên |
| Lỗi kết nối | Kiểm tra mạng/quyền ERP/adapter; không nhập cookie hoặc mật khẩu TikTok vào web |
| Không sửa được username | Cài 011 nếu chỉ mới yêu cầu kết nối; nếu đã có phiên, chọn LƯU THÀNH TIKTOK ID MỚI |
| Chưa có migration 010 | Quản lý hoàn thành bước database; không nhập lại Excel hoặc chạy lại migration cũ |

Mất phản hồi rồi thử lại giữ request ID của lần bấm; server chống ghi trùng. Listener có lease và revision: kết quả/ingestion của lượt cũ không được ghi sau khi ngắt hoặc đổi yêu cầu. Các source IDs là chuỗi để không bị làm tròn. Sau sự cố nguồn hoặc hàng đợi cần đối chiếu trước khi xóa bất kỳ file spool nào.

## Phạm vi và khôi phục

Thay đổi này chỉ đơn giản hóa thiết lập kênh và kết nối LIVE. Không thêm Zalo, shipping, COD, Facebook hoặc minigame; không thay cơ chế CHỐT & IN, tồn kho hoặc tài chính.

010 dùng lại account/campaign/session đã có; bổ sung metadata, mapping ngày/kênh và outbox/lease kết nối. 011 bổ sung kết thúc phiên từ provider và sửa ID trước khi có lịch sử. Không tự gộp campaign cũ hoặc dựng ngày phát LIVE trong lịch sử. Quyền tạo/sửa kênh dành cho owner/manager, nhân viên được yêu cầu kết nối, viewer chỉ xem. Actor ghi nhận từ phiên Auth phía server.

Muốn tạm dừng: ngắt kênh, dừng listener, đối chiếu bình luận chờ và phiếu/in. Giữ dữ liệu, sửa tiến bằng migration mới; không xóa session/ticket/hold hoặc hạ hàm tồn. Chi tiết bằng chứng và giới hạn: [verification luồng TikTok](verification/TIKTOK_CHANNEL_VERIFICATION.md).
