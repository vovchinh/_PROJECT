# V2 — trạng thái thực tế

**Chẩn đoán mới 25/09/2026:** [audit TikTok LIVE](../verification/TIKTOK_LIVE_CONNECTIVITY_AUDIT.md) đã tái hiện lỗi adapter đọc trường chat cũ trong khi dependency 2.5.0 phát protobuf v3; CONNECTING chưa có hạn chờ và viewer pipeline còn thiếu. Máy đang chạy Vite nhưng chưa có listener/cấu hình service. Kết quả local ngày 24/09 bên dưới không bao phủ hợp đồng sự kiện thật và không phải xác nhận sẵn sàng vận hành. Migrations vẫn 001–011.

**Mốc mới 24/09/2026 — migrations 001–011:** đã sửa khóa username sau CONNECT chưa tạo phiên, hỗ trợ lưu ID mới khi có lịch sử, thông báo **Vui lòng bật live** và kết thúc/ngắt kênh từ STREAM_END. CONNECT tự nhận bình luận qua listener đã cấu hình, không cần người duyệt. Bảo vệ lịch sử phiên khi lần kết nối tiếp theo lỗi; giữ nguyên ticket/STT/holds/ledger. Hồi quy **540 check + 57 UI + 77 service + 18 native concurrency PASS**, build PASS. [Hướng dẫn](../TIKTOK_CHANNEL_SETUP.md) và [verification](../verification/TIKTOK_CHANNEL_VERIFICATION.md). Các mốc 23/09 dưới đây là nền trước bản sửa; A1/C7 vẫn cần môi trường thật.

Cập nhật **23/09/2026**: phạm vi mới nhất chỉ đơn giản hóa **lưu TikTok ID → chọn kênh → kết nối**. Mã hiện tại gồm migrations 001–010; 010 bổ sung luồng kênh trên nền 009, dùng lại account, campaign, session, ticket và tồn kho hiện có. Đây không phải xác nhận hoàn thành toàn bộ prompt FLIVE hoặc toàn bộ nội dung mở rộng 009. Bằng chứng riêng tại [verification TikTok Channel](../verification/TIKTOK_CHANNEL_VERIFICATION.md).

Mốc **22/09/2026** dưới đây là lịch sử bàn giao UI trên migrations 001–008, với HEAD được ghi nhận lúc đó là `4f4d369` cùng thay đổi chưa commit. Commit `2b50410` và [223 kiểm tra Phase B](../verification/PHASE_B_VERIFICATION.md) là các mốc trước. **A1 và C7 vẫn chưa được đóng bằng kiểm thử local; Supabase thật, TikTok và máy in còn chờ nghiệm thu.**

Khi lập hồ sơ A1, bốn tài liệu persistent chưa tồn tại; hồ sơ được dựng từ mã và bằng chứng kiểm tra, không được coi là kế hoạch cũ đã nghiệm thu. File chỉ dẫn hiện tại là [AGENTS.md](../AGENTS.md), theo tên người dùng đã đổi. Thứ tự A1–A11 lấy từ [Phase A](../CODEX_PHASE_A_STABILIZE_VERIFY_V2.md).

## Kết quả trong phạm vi TikTok ngày 23/09/2026

- `TikTokChannels.jsx` là lối vào mặc định; người bán lưu username, chọn kênh mặc định hoặc kênh khác rồi gửi yêu cầu kết nối. Campaign/session/room không còn là dữ liệu bắt buộc người bán nhập ở luồng này; cách làm thủ công/mô phỏng vẫn tách riêng.
- 010 dùng lại `live_integration_accounts`, thêm cờ mặc định và thời điểm quan sát kết nối/LIVE. Bốn bảng `live_channel_*` lưu yêu cầu, outbox và ánh xạ kênh/ngày/phòng. Một account cũ duy nhất đang bật được đặt mặc định; thời điểm lịch sử chưa biết không được suy diễn.
- CONNECT chỉ tạo ý định. Listener nhận lease và kiểm tra provider; báo OFFLINE/ERROR không tạo campaign/session. Chỉ báo LIVE hợp lệ mới chọn campaign theo **kênh + ngày Việt Nam** và session theo phòng nguồn. Kết nối lại cùng phòng trong ngày dùng session cũ; phòng mới cùng ngày dùng campaign cũ nên khách đã chốt giữ nguyên STT/giỏ theo định danh nguồn.
- RPC kiểm role/workspace, actor lấy từ `auth.uid()`. Revision và lease chặn báo cáo/ingestion cũ sau ngắt hoặc kết nối lại; trigger bảo vệ cả đường sửa account cũ. Token listener không cấp SELECT cho client và không đưa vào publication. Bình luận chỉ vào qua listener hợp lệ; CHỐT/VOID/holds/ledger vẫn theo 008/006.
- `npm run check`: **521 PASS**, build PASS; demo **5/5 PASS**, service **68/68 PASS**, cloud UI fixture **53/53 PASS**. Suite kênh **23/23 PASS** gồm 12 tình huống yêu cầu và kiểm upgrade, quyền, token, verifier. Bổ sung ngày **24/09**: native PostgreSQL 001–010 **15/15 PASS**, gồm 7 ca tranh chấp kết nối mới; mobile 390px bảo đảm nút kết nối không bị thanh điều hướng che.

009 đã có nền điều khiển phiên, review bình luận, dedupe TikTok và cấu hình in. Checkpoint 009 kiểm 10 nhóm local; không dùng con số này để tuyên bố mọi yêu cầu vận hành/in trong prompt FLIVE đã hoàn tất. Bằng chứng native 010 dùng các process PostgreSQL độc lập với lock contention được quan sát; không suy kết quả cloud/provider từ các ca tại máy.

## Phạm vi đang có

| Phần | Bằng chứng hiện tại | Giới hạn |
|---|---|---|
| React JavaScript / Vite | `src/App.jsx`, `src/main.jsx`, `vite.config.js` | App hiển thị V2.0, package vẫn 1.1.0; ghi nhận cho A7 |
| Dữ liệu demo/cloud | `src/lib/repository.js`, `sales-demo.js` | Demo localStorage riêng; cloud qua RLS/RPC; không đồng bộ ngầm |
| Auth / workspace | `src/lib/useErpSession.js`, migrations 001/002 | Guard phiên và response muộn; owner/manager/staff/viewer |
| Thành viên | `src/features/Operations.jsx`, migration 002 | Owner quản lý tài khoản đã đăng ký/xác nhận email |
| Danh mục / nhập / thu chi | `src/pages.jsx`, `src/forms.jsx`, migration 001 | Phiếu nháp → ghi → đảo; provenance, legacy ID, mở sổ tiền |
| SKU / catalog | `product_styles`, `product_variants`, `product_aliases`, migration 004 | Giữ products là SKU; backfill 1:1 chưa rõ cần đối chiếu; resolver phát hiện mơ hồ |
| Khách hàng | `customers`, `customer_identities`, `customer_addresses`, migration 005 | Liên kết và xác minh thủ công; chưa merge hay tích hợp nền tảng |
| Đơn bán | `sales_orders`, `sales_order_lines`, `save_sales_order` | Nhiều dòng, lưu giá/giảm giá; chỉ sửa nháp |
| Luồng bán | `transition_sales_order` | Giữ → xuất cả đơn → giao; hủy trước xuất; hoàn bán lại được |
| Tồn/FIFO | `inventory_lots`, `sales_allocations`, `sales_events`, migration 006 | Thêm manual holds trong cùng availability; giữ arithmetic FIFO/returns; bằng chứng cạnh tranh xem verification Phase B |
| Reservations | `inventory_reservations`, `reservation_lots` và private request ledger | Giữ/giải phóng/chuyển đủ vào đơn nháp; UUID replay; không tự hết hạn, không tách dòng một phần |
| Snapshot / kế hoạch tiền | `sales_orders.customer_snapshot`, `payment_intents`, migration 005 | Snapshot bất biến sau confirm; đơn cũ NULL rõ nguồn; kế hoạch chưa ghi tiền/doanh thu |
| Giao diện Phase B | `CommerceFoundation.jsx`, repository RPC, Sales Detail | Chỉ cloud; demo cũ giữ nguyên; 5 tab, viewer đọc, staff chọn địa chỉ nháp |
| TikTok account / campaign / session | 007 + 009/010, `TikTokChannels.jsx`, `channel-supervisor.mjs` | Dùng lại account; listener xác nhận LIVE rồi mới chọn campaign/session; seller không nhập room thủ công ở luồng mặc định |
| Normalized comments / parser / claim | 007/009/010, `live-parser.js` | Dedupe cũ theo session; 009 thêm registry TikTok theo workspace/provider/message, xung đột cũ chờ đối chiếu; parser chỉ gợi ý, claim không giữ tồn |
| Live ticket / giỏ / STT | 008, `commit_live_sale_ticket`, `void_live_sale_ticket` | Chốt nguyên tử, UUID replay, một bình luận một ticket; VOID có audit, chưa Final Order |
| Giữ tồn live | 008 mở rộng `inventory_reservations.live_ticket_id` | Cùng lots/FIFO/availability 006; bảo vệ khỏi release/transfer thủ công; không movement/doanh thu |
| Print jobs / attempts | 008, `print-bridge.js` | Một job/ticket, lease/token, requeue không bán lại; người vận hành xác nhận giấy |
| Worker / printer bridge | `services/live-bridge/` | NDJSON và adapter TikTok tùy chọn, spool bền vững; USB qua driver, LAN loopback/raster; chưa nghiệm thu thiết bị thật |
| Giao diện Live theo tham chiếu | `LiveCommerce.jsx`, `LiveInsights.jsx`, `TikTokChannels.jsx`, CSS riêng | Giữ bàn live/giỏ/lịch sử/in/báo cáo/setup; 010 đổi lối vào kết nối. Số 23/23 UI tests ở phần dưới thuộc mốc lịch sử 22/09 |
| Tính tổng / lịch sử / lọc Live | `live-view.js`, 10/10 unit tests | BigInt, ngày nghiệp vụ và loại VOID; giữ STT gốc; ngày tạo phiên không được suy thành thời lượng live |
| Mẫu phiếu và in thử | `LivePrinterPreview.jsx` | Mẫu IN-THU giá trị 0 đ; preview có chữ Việt, in thử không gọi RPC tạo ticket/hold/job |
| Realtime / mobile | repository `watchLive`, `LiveCommerce.jsx`, responsive CSS | Event nhắc đọc lại, polling 10 giây; thanh điều hướng dưới và mặc định chỉ xếp hàng đợi trên mobile; máy tính nhận in |
| Nhật ký | `audit_events`, `sales_events` | Cloud có audit; demo sales chưa đồng nhất với nhật ký chung |
| Báo cáo | `get_workspace_report`, `get_sales_state` | 002 là sổ nhập/tiền; V2 là tồn và số bán quản trị lũy kế; không thay thế nhau |
| Triển khai local | `START_CHIDI.cmd`, `scripts/start.ps1` | `localhost:2000`; build `dist/`, preview `127.0.0.1:4173` |
| Kiểm thử | Vitest, PGlite, Playwright, Python export, build guards + suite Phase B | Có coverage FIFO/sales/holds/snapshots/RLS mới; bằng chứng theo từng suite, không thay cloud Auth |

Chưa có `supabase/functions`, CI/CD hoặc cấu hình hosting production. Phase C đã thêm worker local và hàng đợi in; TikTok adapter chưa được thử bằng tài khoản thật. Zalo, cart-to-order, shipping API và COD settlement vẫn thuộc các phase sau.

## Lịch sử — bằng chứng bàn giao giao diện ngày 22/09/2026

- `npm run check`: **288 PASS** = 56 unit + 25 core DB + 41 operations + 40 catalog + 36 customers + 24 inventory + 25 intake + 27 commerce + 14 verification; build PASS.
- Cloud UI dùng API mô phỏng: **41/41 PASS**, gồm **23/23 Phase C** (13 luồng cũ và 10 kiểm tra UI mới). Demo: **5/5 PASS**. Đây là kết quả chạy trên mã đã đóng băng, tách khỏi các lần thử có hot reload trong quá trình chỉnh giao diện.
- C3: **10/10 helper tests** cho read model Live, ngoài parser hiện có. C5: **27/27 service tests PASS**, gồm dừng worker khi RPC đang chờ, dừng lặp lại, kết nối hoàn tất muộn, hạn 15 giây của spool và raster tiếng Việt qua Edge local.
- Đã kiểm tra ảnh giao diện fixture ở 390px và 1280px; tìm kiếm/lịch sử/báo cáo không ghi nghiệp vụ, queue-only không tự nhận in, mẫu thử không tạo chứng từ. Chi tiết tại [PHASE_C_UI_UX.md](PHASE_C_UI_UX.md).

Thay đổi giao diện này không cần migration mới và không đổi nghĩa ticket/holds/FIFO. Báo cáo Live tính giá trị phiếu còn hiệu lực trong kỳ, **chưa phải doanh thu hay tiền đã thu**. **C7 vẫn PENDING** đối với Supabase/Auth, TikTok và ZYWELL thật; kết quả A1 ở dưới giữ nguyên.

## Database V2 được khai báo trong 003

- Sáu bảng public: `customers`, `sales_orders`, `sales_order_lines`, `sales_events`, `inventory_lots`, `sales_allocations`.
- Hai bảng private: `app_private.inventory_timeline`, `app_private.sales_requests`.
- Bốn RPC mới: `save_customer(uuid,jsonb)`, `save_sales_order(uuid,jsonb)`, `transition_sales_order(uuid,uuid,text,jsonb,uuid)`, `get_sales_state(uuid)`.
- Giữ chữ ký `post_purchase(uuid,uuid)` và `reverse_document(text,uuid,uuid,date,text)` bằng wrapper; thân V1 chuyển vào `app_private`.
- Các bảng public V2 bật RLS, có `member_read`, authenticated chỉ SELECT trực tiếp. RPC kiểm role; các thao tác kho khóa workspace. Actor lấy từ `auth.uid()`.
- Nguồn nhập cũ backfill thành lot; không thêm lại phiếu thu hoặc doanh thu. Phiếu đã dùng giữ/xuất không được đảo như hàng chưa sử dụng.

Các đặc điểm trên đã đọc trong SQL local. Diagnostic A1 kiểm được clean install, quyền bảng, khách hàng chéo workspace và actor trên PGlite; chưa chứng minh mọi RPC bán trên Supabase thật.

## Trạng thái môi trường và phát hiện A1

1. Người dùng đã xác nhận hoàn thành 002/Auth/workspace. Không yêu cầu làm lại bước đó.
2. Probe cloud GET ngày 15/09 trả `401 / 42501` cho sáu bảng V2 và `get_sales_state`: các đối tượng có trong API và anonymous bị từ chối. Không xác nhận được checksum, toàn bộ schema, policy hoặc hành vi có đăng nhập bằng probe này.
3. Cài 001→002→003 trên database business rỗng PASS. Nâng cấp 003 sau hai phiếu nhập đã ghi FAIL `55006`: không ALTER TABLE `inventory_lots` khi còn pending trigger events. Rollback test giữ nguyên ledger V1.
4. Demo history trả `date`/`payload.reason`, UI đọc `event_date`/`reason`. Quy tắc chặn ngày tương lai đã được viết trong docs nhưng chưa có đủ enforcement. Chỉ ghi nhận; chưa sửa A2/A3.
5. Trước Phase B chưa có snapshot tên/địa chỉ. Migration 005 chỉ chụp khi đơn nháp xác nhận sau nâng cấp; các đơn lịch sử vẫn không được suy diễn từ master hiện tại. Giá/giảm giá dòng đơn giữ nguyên.
6. Người dùng xác nhận đã chạy SQL kiểm metadata, chưa có kết quả để đối chiếu. A1 hiện có script xuất một ô JSON và comparator offline; tests comparator 7/7, diagnostic 7 PASS/1 FAIL. Không nâng bằng chứng cloud lên PASS từ xác nhận thao tác.

## Quyết định tiếp tục

Người dùng đã mở phạm vi từ Phase B sang **Phase C**, rồi thu hẹp action mới nhất về luồng TikTok ID đơn giản. Phần bổ sung là **009 → 010** sau khi 001–008 đã thành công; không đánh dấu A1 PASS và không triển khai Phase D/E/F/G. Đường upgrade này khác đường V1 có dữ liệu → 003 đang lỗi.

Xem [hướng dẫn Phase C](../PHASE_C_LIVE_COMMERCE.md) và [migration plan](V2_MIGRATION_PLAN.md). Chưa chạy migrations mới trên Supabase thật, chưa nhận metadata cloud để đối chiếu; không tái chạy migration lịch sử. 001–006 và file/ledger Excel nguồn không thay đổi.
