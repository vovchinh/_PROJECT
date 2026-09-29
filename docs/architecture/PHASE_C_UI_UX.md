# Phase C — giao diện theo ảnh tham chiếu Live Commerce

**Bổ sung 23/09/2026:** theo [ảnh thêm TikTok ID](<Live Commerce/add_TikTokID.jpg>) và [ảnh kết nối LIVE](<Live Commerce/ConnectTiktokLive.jpg>), màn hình mặc định chỉ còn lưu/chọn TikTok ID và **KẾT NỐI LIVE**. Các trường campaign/session/provider/room chuyển vào chế độ **Thủ công / mô phỏng**. Kết nối thật dùng migration 010 và listener xác minh nguồn; xem [hướng dẫn mới](../TIKTOK_CHANNEL_SETUP.md) và [verification](../verification/TIKTOK_CHANNEL_VERIFICATION.md). Phần bên dưới giữ mốc giao diện ngày 22/09.

Cập nhật 22/09/2026. Giao diện được bổ sung trên mã Phase C đang có, theo bảy ảnh trong `docs/architecture/Live Commerce`. Không sửa migration hoặc viết lại nghiệp vụ CHỐT & IN. Xem [hướng dẫn vận hành](../PHASE_C_LIVE_COMMERCE.md) và [kết quả kiểm thử](../verification/PHASE_C_VERIFICATION.md).

## Đối chiếu ảnh và màn hình triển khai

| Ảnh do người dùng cung cấp | Áp dụng trong Phase C |
|---|---|
| [Cài đặt máy in](<Live Commerce/1789975530951_1982917821607970620_7085640902494138349_638cad89acd3bd39b46de650667b0a29.jpg>) | Chọn USB/LAN/hàng đợi, mẫu phiếu 80 mm, nút in thử; token cầu nối chỉ trong bộ nhớ |
| [Báo cáo](<Live Commerce/1789975530976_1982917821607970620_7085640902494138349_066030849235dfcc0157dbe38b85ee01.jpg>) | Thẻ chỉ số, bộ lọc thời gian và biểu đồ xanh; số liệu thật từ phiếu còn hiệu lực của chiến dịch |
| [Chi tiết giỏ / phiếu](<Live Commerce/1789975530991_1982917821607970620_7085640902494138349_e48b1c8e6aa29129b4d9577f0eb754c0.jpg>) | Cửa sổ giỏ theo STT, các phiếu trong giỏ, giá/số lượng, VOID có lý do và mở hàng đợi của giỏ |
| [Thông tin khách](<Live Commerce/1789975531003_1982917821607970620_7085640902494138349_b25f9b0f33cb1af87b838e72c0741780.jpg>) | Tab thông tin chỉ đọc: định danh nguồn, liên kết ERP và điện thoại đã có; không suy danh tính từ tên |
| [Danh sách giỏ](<Live Commerce/1789975531014_1982917821607970620_7085640902494138349_edbebb3c8788609ca090763282ab5bb9.jpg>) | Thẻ khách nền trắng, STT xanh, dòng sản phẩm, tổng giá trị và hai thao tác rõ; tìm kiếm/lọc giỏ |
| [Lịch sử LIVE](<Live Commerce/1789975531023_1982917821607970620_7085640902494138349_90aa0fffb8e763d4d36971c5664cbe81.jpg>) | Nhóm phiên theo ngày tạo, lọc nguồn/trạng thái, tìm tên/mã/tài khoản và mở lại đúng phiên |
| [Trang LIVE](<Live Commerce/1789975531031_1982917821607970620_7085640902494138349_c7387190ffc4a42ae63a2584a2004316.jpg>) | Điểm nhấn vàng, chọn phiên, trạng thái nguồn, đường vào thiết lập và điều hướng dưới trên điện thoại |

Ảnh dùng để tham chiếu bố cục; không lấy tên khách, số điện thoại, avatar hoặc số tiền trong ảnh làm dữ liệu ứng dụng. Ảnh gốc giữ nguyên trong tài liệu, không được đưa vào bundle React như dữ liệu shop.

## Sáu khu vực thao tác

1. **Bàn live:** chọn phiên, nhận bình luận, tìm tên/ID/nội dung, lọc chưa chốt/đã chốt/VOID. Bộ lọc chỉ áp dụng trên trang bình luận đang tải; nút xem cũ hơn dùng con trỏ của server.
2. **Giỏ khách:** tìm STT, tên, SKU hoặc mã phiếu. Tìm kiếm chọn giỏ phù hợp nhưng tổng vẫn gồm các phiếu trong giỏ; không làm tổng thay đổi theo vài dòng khớp chữ. “Tất cả giỏ” giữ cả giỏ chỉ còn lịch sử VOID.
3. **Lịch sử phiên:** chọn lại phiên và chiến dịch tương ứng. Ngày hiển thị là **ngày tạo phiên**; schema hiện tại chưa có thời điểm bắt đầu/kết thúc thực tế nên không dựng thời lượng từ `created_at`.
4. **Hàng đợi in:** xem toàn chiến dịch hoặc lọc theo một giỏ. Chỉ nhận in từ job đã tạo; in lại/đối soát dùng luồng cũ, không chốt bán thêm lần nữa.
5. **Báo cáo live:** kỳ 7/30/180/365 ngày theo ngày nghiệp vụ. Tổng giá trị, phiếu, số lượng và giỏ còn hiệu lực đều loại VOID. Biểu đồ có bảng số liệu chính xác bên dưới, không có tăng trưởng hoặc doanh thu giả.
6. **Thiết lập:** tài khoản TikTok, chiến dịch, phiên, mã cấu hình worker, chọn cách in và mẫu phiếu. Cách bật worker nằm trong hướng dẫn riêng, không giả hiển thị kết nối thành công sau khi chỉ lưu username.

## Điều chỉnh để vận hành trên điện thoại

- Thanh điều hướng sáu mục nằm dưới, có vùng an toàn cho màn hình điện thoại; vẫn dùng được trên desktop trong layout ERP hiện tại.
- Màu vàng làm điểm nhấn, chữ tối giữ dễ đọc; nút chính đủ lớn, bảng dài cuộn trong vùng riêng.
- Khối “Thống kê & kết nối” mặc định thu gọn ở màn hình nhỏ để bình luận xuất hiện sớm hơn. Người vận hành có thể mở lại bất cứ lúc nào.
- Điện thoại mặc định **chỉ xếp hàng đợi**. CHỐT & IN vẫn tạo print job cùng transaction nhưng không tự nhận job hoặc mở popup trên điện thoại. Máy tính cùng workspace chọn USB/LAN để nhận và in.
- Cửa sổ giỏ có hai tab **Thông tin / Phiếu đã chốt**, đóng bằng nút hoặc Escape, giữ focus trong modal; đổi workspace được khóa khi đang thao tác.
- Tìm kiếm/lịch sử/báo cáo không gọi RPC ghi nghiệp vụ. Viewer chỉ xem; staff được chốt/in; owner/manager quản lý nguồn và VOID.

## Đúng nghĩa dữ liệu

“Giá trị phiếu” là tiền hàng đã chốt và còn hiệu lực, chưa phải doanh thu/thu tiền. Tổng dùng `BigInt`, kể cả vượt phạm vi số nguyên an toàn của JavaScript. VOID được loại theo trạng thái hiện tại; báo cáo là ảnh chụp các phiếu còn hiệu lực trong kỳ ngày chốt, không phải sổ biến động kế toán theo ngày VOID.

Giỏ và STT lấy nguyên từ RPC, không đặt lại số hoặc gộp khách theo tên. Liên kết ERP/điện thoại chỉ hiển thị khi có dữ liệu đã liên kết; snapshot phiếu vẫn giữ giá/thông tin tại lúc chốt. Phiên đổi chiến dịch phải tải snapshot commerce tương ứng, không giữ kết quả muộn của workspace trước.

Phần cọc, tổng đơn cuối, Zalo, vận đơn, Facebook/minigame và reset STT trong ảnh không nằm trong Phase C hiện tại. Giao diện chỉ đưa thao tác đã có nghiệp vụ phía server; không tạo nút giả hoặc triển khai trước Phase D/E/F.

## Máy in và mẫu thử

Mẫu giấy mang mã **IN-THU**, tên **IN THỬ — KHÔNG PHẢI PHIẾU BÁN**, giá trị 0 đ và chữ Việt để kiểm tra font/lề. Component mẫu không có quyền truy cập repository; in thử không gọi RPC tạo ticket/hold/job. USB mở hộp thoại trình duyệt, LAN gửi mẫu vào spool local bằng attempt ID mới. “Đã gửi”/dry-run không tự xác nhận giấy đã ra.

Không tự dò IP LAN hoặc mở kết nối từ điện thoại vào máy tính. Địa chỉ máy in cấu hình cố định trong bridge; frontend chỉ ghép với loopback/token đã có. Các bước nghiệm thu phần cứng ở [hướng dẫn Phase C](../PHASE_C_LIVE_COMMERCE.md).

## Tổ chức mã và kiểm thử

- `LiveCommerce.jsx`: state/workspace, các RPC, claim/commit/VOID và điều phối in hiện có.
- `LiveInsights.jsx`: thống kê, lịch sử, báo cáo và giỏ/chi tiết giỏ; nhận dữ liệu từ parent.
- `LivePrinterPreview.jsx`: mẫu giấy và in thử độc lập với nghiệp vụ.
- `live-commerce.css`: style riêng Phase C, không đổi diện mạo các module ERP khác.
- `live-view.js`: tính tổng/lọc/nhóm chỉ đọc, 10 unit tests về BigInt, VOID, khoảng ngày, STT và dữ liệu chưa rõ.
- `tests/cloud/live-ux.spec.js`: 10 kiểm tra theo tham chiếu, ảnh chụp mobile 390px và desktop 1280px; fixture chung cho 13 luồng live cũ.

Ảnh giao diện được tạo từ fixture kiểm thử tại `test-results/live-ux-mobile.png` và `test-results/live-ux-desktop.png`. Không dùng ảnh chụp mock để chứng nhận cloud hoặc phần cứng. Hồi quy và giới hạn cuối xem [verification](../verification/PHASE_C_VERIFICATION.md).

Thay đổi UI này không cần migration mới. Nếu cần quay lại layout trước, giữ nguyên RPC/migrations 007/008 và dữ liệu ticket/holds; chỉ thay phần trình bày. Không hạ hàm kho hoặc bỏ print attempts để đổi giao diện.
