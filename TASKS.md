# Các bước đã thực hiện và bước tiếp theo

Cập nhật **24/09/2026**. Không coi kiểm thử mô phỏng là đã nghiệm thu Supabase, TikTok hoặc máy in thật.

## TikTok ID và kết nối đơn giản

- [x] 011: sửa ID sau yêu cầu kết nối chưa tạo phiên; hủy quyền listener cũ, giữ lịch sử kênh đã có phiên và hỗ trợ lưu thành ID mới.
- [x] Chưa LIVE hiện **Vui lòng bật live**; listener tự nhận bình luận, không cần duyệt thêm.
- [x] Provider STREAM_END tự kết thúc phiên/ngắt kênh; retry có chống trùng, giữ bình luận chưa gửi và không coi mất mạng là kết thúc LIVE.

- [x] Dùng lại account theo workspace; username chuẩn hóa/duy nhất, một kênh mặc định và lịch sử kết nối.
- [x] Lưu TikTok ID → chọn ID → KẾT NỐI LIVE; trường kỹ thuật chuyển sang chế độ thủ công/quản trị.
- [x] 010: request/outbox/lease, provider xác nhận trước khi tạo campaign theo ngày Việt Nam và session theo phòng thực tế.
- [x] Bấm lặp/kết nối lại giữ session và STT; chặn kết quả/bình luận từ listener đã hết quyền.
- [x] Listener theo workspace, xác thực ERP local, giữ adapter và hàng đợi bền vững; manual/simulator còn dùng được.
- [ ] Áp dụng các migration mới chưa có và nghiệm thu kênh thật theo [hướng dẫn TikTok](docs/TIKTOK_CHANNEL_SETUP.md); lưu [bằng chứng](docs/verification/TIKTOK_CHANNEL_VERIFICATION.md).

Mốc Phase C 007/008 bên dưới được giữ làm lịch sử. Hạng mục FLIVE rộng hơn không mở tiếp trong thay đổi chỉ dành cho luồng kênh/kết nối này.

## Phase C — trạng thái hiện tại

- [x] 007: hồ sơ TikTok không chứa secret, chiến dịch/phiên, bình luận chuẩn hóa, chống trùng, claim 120 giây.
- [x] Parser xác định SKU/alias/thuộc tính rõ; ambiguity/review, không tự bán hoặc giữ hàng.
- [x] 008: chốt nguyên tử ticket/giỏ/STT/hold/print job/audit/outbox; replay, VOID và bảo vệ live hold.
- [x] UI Live · Chốt & In, setup tài khoản, realtime + polling, quyền/workspace và mobile.
- [x] Hàng đợi in có lease/attempt, in lại không bán lại; xác nhận giấy riêng với commit nghiệp vụ.
- [x] Worker NDJSON/TikTok và LAN bridge có spool; USB qua driver, raster chữ Việt, đăng nhập ERP local.
- [x] Kiểm thử database/UI/worker/bridge và cạnh tranh native; [hồ sơ bằng chứng](docs/verification/PHASE_C_VERIFICATION.md).
- [x] [Hướng dẫn nâng cấp/vận hành/rollback](docs/PHASE_C_LIVE_COMMERCE.md), ba tài liệu kiến trúc và portal.
- [ ] Xác nhận 006 thành công, áp dụng 007→008 một lần và chạy verify_phase_c.sql trên Supabase thử.
- [ ] Nghiệm thu tài khoản TikTok đang live, giấy ZYWELL thật và hai workspace Auth thật.
- [ ] Hoàn tất checklist thiết bị/hosting/backup trước vận hành làm hệ thống chính; chưa mở Phase D.

## Phase B — trạng thái hiện tại

- [x] Giữ SKU IDs/ledger, tạo styles/variants/aliases, resolver phát hiện mơ hồ (004).
- [x] Giữ khách cũ, thêm identities/addresses thủ công, snapshot đơn và payment plans không ghi tiền (005).
- [x] Giữ tồn dùng chung với FIFO V2, release/chuyển sang đơn nguyên tử và replay (006).
- [x] Nối RPC và màn hình Nền tảng thương mại, hiển thị snapshot trong chi tiết đơn.
- [x] Hồi quy 223 kiểm tra PASS, gồm 100 database Phase B, 12 UI mới và 7 native PostgreSQL concurrency; [nghiệm thu cuối](docs/verification/PHASE_B_VERIFICATION.md).
- [x] Viết [hướng dẫn nâng cấp/vận hành/rollback](docs/PHASE_B_COMMERCE_FOUNDATION.md), cập nhật ba tài liệu kiến trúc persistent.
- [ ] Áp dụng 004→005→006 một lần trên Supabase đã có 003 thành công; chạy verify_phase_b.sql.
- [ ] Nghiệm thu bằng tài khoản thực trong workspace thử, lưu metadata và kết quả hai workspace.
- [ ] Tiếp tục blocker A1, backup/restore và các action Phase A còn thiếu; Phase C được triển khai riêng theo yêu cầu mới ở trên.

Người dùng đã xác nhận hoàn thành 002/Auth/workspace. Phần dưới là nhật ký **11/09/2026**, không phải yêu cầu chạy lại 002 hoặc đăng ký lại tài khoản.

## Đã thực hiện

- [x] Tạo project JavaScript/React tại đúng thư mục yêu cầu; có Node LTS riêng, launcher, build và lockfile.
- [x] Xây danh mục, nhập hàng, thu chi, ghi sổ, đảo, import đối chiếu, sổ phát sinh và nhật ký.
- [x] Thiết kế kiến trúc ERP đầy đủ, sơ đồ, hướng dẫn sử dụng và prompt phát triển.
- [x] Người dùng đã thực hiện Supabase setup bước 1–6.
- [x] Đọc cấu hình trên máy; giữ nguyên URL/publishable key, chuyển `VITE_DEMO_MODE=false`.
- [x] Kiểm tra cloud chỉ đọc: Auth phản hồi, ba bảng nền tồn tại, anonymous bị chặn đọc.
- [x] Đồng bộ địa chỉ ứng dụng với `http://localhost:2000` theo cấu hình người dùng chọn.
- [x] Thêm selector nhiều workspace; xử lý dữ liệu trả về muộn sau đổi workspace/đăng xuất.
- [x] Thêm UI và RPC quản lý thành viên đã đăng ký/xác nhận email; kiểm owner và bảo vệ chủ shop cuối cùng.
- [x] Thêm báo cáo cloud trong cùng snapshot PostgreSQL, tiền lớn chính xác bằng chuỗi/BigInt, đối chiếu số dư và đảo theo kỳ.
- [x] Thêm migration `002_operations.sql`, chạy và kiểm thử trên PostgreSQL cục bộ, bảo toàn dữ liệu V1.
- [x] Kiểm tra browser với cloud API mô phỏng, tách khỏi Supabase thật và máy chủ người dùng.
- [x] Chặn mất dòng Excel thiếu mã; chặn công thức ở input; giữ cờ ngày ước tính và dấu vết trong CSV.
- [x] Xuất lại dữ liệu 11/09: 17 nhập hàng, 1.566 sản phẩm, 79.043.000 đ tiền hàng, 12 thu chi; SHA-256 nguồn vẫn khớp bản 10/09.

## Checklist tại mốc V1.1 — lịch sử

1. **Chạy [002_operations.sql](supabase/migrations/002_operations.sql)** trong SQL Editor của project hiện có. Không chạy lại `001_core.sql`. Kiểm tra chỉ đọc hiện chưa tìm thấy RPC của bản nâng cấp.
2. Mở **START_CHIDI.cmd**, vào **http://localhost:2000**, đăng ký/xác nhận email rồi đăng nhập. Nếu đã có tài khoản thì dùng tài khoản đó. Không gửi mật khẩu qua chat.
3. Tạo/chọn workspace ChiDi; nhập file **`data/chidi-import-2026-09-11-validated.json`** qua màn hình Đối chiếu dữ liệu. Mọi dòng vẫn nháp.
4. Xác nhận SKU, ngày và số dư đầu bằng chứng từ thật; thử ghi/đảo bằng dữ liệu kiểm thử trước khi chọn dữ liệu chính.
5. Làm kiểm tra cloud hai tài khoản và khôi phục backup theo [hướng dẫn V1.1](docs/THIET_LAP_VAN_HANH_V11.md).

Tôi chỉ có publishable key của frontend, không có phiên quản trị database. Vì vậy không thể chạy migration DDL thay bạn bằng key này. File nâng cấp đã được làm thành kết quả cụ thể, có kiểm thử và hướng dẫn để bạn chạy trong SQL Editor; không cần cung cấp secret key.

## Những phân hệ ERP còn trong lộ trình

| Phần | Tình trạng |
|---|---|
| Vận hành nhóm, báo cáo server | Mã V1.1 đã có; migration cloud và nghiệm thu phiên thật còn chờ |
| Bán hàng / giữ tồn / xuất / hoàn | Chưa triển khai |
| FIFO giá vốn bán | Chưa triển khai |
| Đối soát COD theo vận đơn / tích hợp vận chuyển | Chưa triển khai |
| Hóa đơn, AP/AR, sổ cái kép, khóa kỳ | Chưa triển khai |
| Backup tự động, khôi phục diễn tập, public hosting | Chưa thực hiện |
| CRM/livestream, lương, tài sản | Có kiến trúc và prompt, chưa có phân hệ chạy |

Chi tiết kết quả: [VERIFICATION.md](docs/VERIFICATION.md). Nhật ký phiên bản: [CHANGELOG.md](docs/CHANGELOG.md). Không dùng V1.1 như một hệ thống kế toán/ERP doanh nghiệp đã hoàn chỉnh mọi phân hệ.
