# V2 — khoảng cách với target

**Audit 25/09/2026:** adapter chat thực tế và timeout kết nối là **EXISTS_NEEDS_EXTENSION** (lỗi v3 đã tái hiện); viewer ingestion/storage/UI và listener health là **MISSING**. Phải kiểm chứng provider độc lập rồi simulator/DB/Realtime/UI theo [các gate T0–T6](../verification/TIKTOK_LIVE_CONNECTIVITY_AUDIT.md). Bằng chứng ngày 24/09 không đóng các khoảng thiếu này; không mở phase ngoài LIVE.

**Bổ sung 24/09/2026:** sửa ID sau CONNECT chưa tạo phiên và kết thúc LIVE tự động đã **EXISTS_AND_COMPATIBLE** qua 011, `finish_tiktok_live`, trigger bảo vệ lịch sử, listener STREAM_END và giao diện. Mã có 19 ca lifecycle, 16 luồng TikTok UI, tổng service 77 và native 18 PASS. Lỗi mạng vẫn retry; lịch sử nguồn không bị đổi tên. Chờ nghiệm thu Supabase/provider/thiết bị thật; không mở tính năng phase sau. Bảng dưới mô tả mốc nền 23/09.

**23/09/2026:** action mới nhất chỉ hoàn thiện luồng **TikTok ID → kết nối**, trên nền migrations 001–009 bằng migration bổ sung 010. So sánh [trạng thái thực tế](V2_CURRENT_STATE.md) với [target](../KIEN_TRUC_CHIDI_ERP_CHIDIPOS_V1_1_TARGET.md), theo [AGENTS.md](../AGENTS.md). Phân loại mã/schema không đồng nghĩa nghiệm thu cloud hoặc thiết bị; không mở Phase D trở đi và không tuyên bố toàn bộ prompt FLIVE/009 đã hoàn thành.

## Phần thay đổi trong phạm vi ngày 23/09/2026

| Phần | Bằng chứng | Phân loại | Khoảng còn thiếu |
|---|---|---|---|
| Thiết lập TikTok ID đơn giản | `TikTokChannels.jsx`, `save_tiktok_channel`, account 007 dùng lại | EXISTS_AND_COMPATIBLE | Default duy nhất theo workspace; UI 53/53 PASS, gồm 12 luồng TikTok; mobile 390px kiểm nút kết nối không bị che |
| Ý định kết nối và xác nhận nguồn | `live_channel_connections`, `live_channel_commands`, supervisor/adapter | EXISTS_NEEDS_EXTENSION | Local/service đã kiểm; phải nghiệm thu tài khoản và listener thực tế |
| Tự chọn campaign/session sau khi LIVE | `report_tiktok_connection`, mapping theo kênh/ngày Việt Nam/phòng nguồn | EXISTS_AND_COMPATIBLE | OFFLINE không tạo phiên; cùng ngày giữ campaign/STT; native 15/15 PASS trên 001–010 ngày 24/09, trong đó 7 ca tranh chấp kết nối |
| Quyền listener và bảo vệ account | Revision/lease, `ingest_tiktok_comments`, trigger account, RLS/FK | EXISTS_AND_COMPATIBLE | Kiểm thực tế Supabase/Auth và hai workspace còn thuộc A1/C7 |
| Kiểm tra triển khai chỉ đọc | `verify_tiktok_channels.sql`, 23 kiểm tra database/verifier | EXISTS_AND_COMPATIBLE | Chưa có kết quả từ project Supabase thật; kết quả metadata không chứng minh kết nối provider |
| Phần mở rộng vận hành 009 | Control/review, metadata/dedupe, printer profile schema | EXISTS_NEEDS_EXTENSION | Checkpoint local 10 nhóm; không coi toàn bộ yêu cầu FLIVE/in và vận hành thật đã nghiệm thu |

Bằng chứng local ngày 23/09: `npm run check` **521 PASS** và build PASS; demo **5/5**, service **68/68**, suite TikTok Channel **23/23 PASS**. Chưa chốt toàn bộ UI regression mới là PASS; theo dõi kết quả cuối tại [verification TikTok Channel](../verification/TIKTOK_CHANNEL_VERIFICATION.md). **A1/C7 Supabase, TikTok và ZYWELL thật vẫn còn chờ.**

## Lịch sử — bảng khoảng cách tại mốc 22/09/2026

Bảng và số liệu bên dưới phản ánh migrations 001–008 cùng [giao diện Phase C](PHASE_C_UI_UX.md) tại ngày 22/09; phần 23/09 ở trên cập nhật các thay đổi sau mốc này.

| Phần | Bằng chứng hiện tại | Phân loại | Khoảng thiếu / action |
|---|---|---|---|
| React JS / Supabase | App, repository, useErpSession | EXISTS_AND_COMPATIBLE | Giữ ứng dụng hiện tại |
| Workspace / RLS / roles | 001/002/003, bốn role, FK workspace | EXISTS_NEEDS_EXTENSION | A1 xác minh schema và phiên cloud; A4 test bán theo quyền |
| Audit | audit_events và RPC cloud; demo thiếu audit chung | EXISTS_NEEDS_EXTENSION | A9 đồng nhất contract trong phạm vi an toàn |
| Catalog / SKU | products giữ nguyên, 004 tạo variant 1:1 và parent styles | EXISTS_AND_COMPATIBLE | Không đổi product ID; thuộc tính chưa rõ chờ đối chiếu |
| Variants / aliases | 004, 5 RPC, UI catalog, uniqueness + resolver ambiguous | EXISTS_AND_COMPATIBLE | Parser/ticket dùng SKU cũ và mapping đã xác nhận; alias mơ hồ vẫn phải chọn rõ |
| Kho | warehouses | EXISTS_AND_COMPATIBLE | Giữ workspace FK |
| Stock / FIFO | stock_movements + lots/allocations/events | EXISTS_NEEDS_EXTENSION | Đã có native concurrency local B/C; lỗi upgrade 003 và nghiệm thu cloud vẫn riêng |
| Reservations | 006 manual holds + V2 allocations; 008 live hold | EXISTS_NEEDS_EXTENSION | Ticket dùng chung lots/lock, VOID giải phóng; chưa expiry hoặc chuyển cart sang order |
| Customers | customers + save_customer giữ nguyên | EXISTS_AND_COMPATIBLE | Dùng ID cũ với identities/addresses mới |
| Identities / merge history | 005 explicit channel IDs + manual verification | EXISTS_NEEDS_EXTENSION | Không auto-merge; merge history/tags chưa có |
| Customer addresses / snapshot | 005 addresses + snapshot trigger; UI Sales Detail | EXISTS_AND_COMPATIBLE | Đơn cũ legacy_unavailable; không backfill lịch sử giả |
| Orders / price snapshot | sales_orders/lines + shipping_address/customer_snapshot | EXISTS_NEEDS_EXTENSION | Giữ giá/discount; cart/khách tự xác nhận nằm ở phase sau |
| Customer confirmation | confirm hiện là nhân viên giữ tồn | MISSING | Không được coi là khách đã xác nhận đơn |
| Payments / deposit / refund | 005 payment_intents planned/void và UI | EXISTS_NEEDS_EXTENSION | Có khung kế hoạch; chưa posting tiền, bank matching, paid/refund/settlement |
| Campaign / session / STT | 007 campaigns/sessions, 008 campaign customers | EXISTS_AND_COMPATIBLE | STT theo provider + stable external ID xuyên phiên; cần nghiệm thu cloud |
| Normalized comments / parser / claim lock | 007 dedupe/claim, live-parser.js | EXISTS_AND_COMPATIBLE | Không auto-commit; token chỉ holder đọc, claim không giữ tồn |
| Live Sale Ticket / VOID | 008 ticket snapshots và RPC VOID | EXISTS_AND_COMPATIBLE | Không hard-delete; không tạo sales_order ngầm |
| Basket number / Customer Cart | 008 carts/items | EXISTS_AND_COMPATIBLE | Cart từ ticket active, chưa finalize/cart conversion |
| Giao diện Live theo ảnh tham chiếu | LiveCommerce, LiveInsights, LivePrinterPreview và CSS riêng | EXISTS_AND_COMPATIBLE | Sáu khu vực; tìm/lọc bình luận, chi tiết giỏ/STT/VOID, lịch sử, báo cáo và mẫu in; 23/23 UI tests PASS với API mô phỏng |
| CHỐT & IN | 008 commit_live_sale_ticket | EXISTS_AND_COMPATIBLE | Atomic/idempotent ticket + cart + reservation + print job + audit + outbox |
| Print job / attempts / reprint | 008 lease/token, print-bridge.js | EXISTS_AND_COMPATIBLE | In sau commit; một business job; mất phản hồi cần đối chiếu giấy |
| Mobile printing | Điều hướng dưới, mặc định queue-only; USB/browser và LAN bridge | EXISTS_NEEDS_EXTENSION | Mobile chốt để desktop nhận queue; in thử mẫu 0 đ không tạo chứng từ; còn nghiệm thu thiết bị thật/HTTPS hosting |
| Realtime | workspace subscriptions + polling/focus/manual refresh | EXISTS_AND_COMPATIBLE | Event nhắc đọc lại; DB quyết định; publication bỏ token |
| TikTok LIVE provider | services/live-bridge, NDJSON và optional connector; 27/27 service tests PASS | EXISTS_NEEDS_EXTENSION | Đã kiểm shutdown/drain và retry local; chưa nghiệm thu tài khoản TikTok thật |
| TikTok Shop API | Chưa có | DEFER | Tách khỏi LIVE provider |
| Zalo manual claim/link | Chưa có | MISSING | Xác minh, hạn dùng và chống dò mã trước liên kết identity |
| Zalo OA automation | Chưa có | DEFER | Manual flow phải dùng được độc lập |
| Fulfillment / shipment / package | ship cả đơn, carrier/tracking nhập tay | EXISTS_NEEDS_EXTENSION | Chưa chia kiện, xuất từng phần hoặc shipping label |
| Shipping label | Chưa có | MISSING | Tách document vận chuyển với live ticket |
| Returns / damaged | Có hoàn bán lại được | EXISTS_NEEDS_EXTENSION | Chưa có damaged/quarantine/kiện thiếu |
| COD settlement | Giao không tạo cash | MISSING | Giữ DELIVERED != COD_SETTLED; settlement không thêm doanh thu |
| Webhook inbox / outbox / retry / dead-letter | 008 live outbox, service durable queue/print spool | EXISTS_NEEDS_EXTENSION | Chưa webhook nền tảng/dispatcher tổng quát; không tự phát external mutation từ outbox |
| Reconciliation | Import nguồn và báo cáo tiền | EXISTS_NEEDS_EXTENSION | Thiếu đối soát hãng/COD/kho đa nguồn |
| Commerce reporting | Lũy kế net sales/COGS/gross profit/transit; báo cáo giá trị Live theo campaign/ngày nghiệp vụ | EXISTS_NEEDS_EXTENSION | Live có kỳ 7/30/180/365 ngày, BigInt và loại VOID; chưa phải báo cáo doanh thu/thu tiền theo kênh; get_sales_state chưa phân trang |
| Migration upgrade | 003 clean PASS, populated FAIL; metadata comparator local đã có | EXISTS_CONFLICTS | A1 blocker 55006; chưa nhận JSON cloud; giữ nguyên lịch sử migration |
| Future-date contract | Docs có; server/demo chưa đủ | EXISTS_CONFLICTS | A3; không sửa chỉ ở UI |
| Demo history contract | date/payload.reason khác UI | EXISTS_CONFLICTS | A2 sau A1 |
| Version / docs | App V2.0, package 1.1.0 | EXISTS_CONFLICTS | A7; không hạ V2 về V1.1 |
| CI / monitoring / deploy | Local launcher/build/worker có; chưa CI/hosting production | EXISTS_NEEDS_EXTENSION | Health/connection status có, chưa vận hành giám sát/deploy production |
| Backup/restore drill | Chưa có kết quả restore | MISSING | A11 riêng; không gọi backup verified |
| Microservices / SaaS | Không cần để chạy hiện tại | DEFER | Giữ modular monolith |

Bằng chứng **lịch sử 22/09**: C3 helper read model **10/10**, C4 Live UI **23/23**, C5 service **27/27 PASS**; `npm run check` **288 PASS** và build PASS; toàn bộ cloud UI mô phỏng **41/41**, demo **5/5**. Không cộng lặp các suite thành chứng nhận production. Xem [UI/UX](PHASE_C_UI_UX.md) và [verification](../verification/PHASE_C_VERIFICATION.md).

## Kiểm soát migration cho các khoảng thiếu

Các thay đổi schema sau 003 nằm trong migration **mới** 004/005/006. 004 backfill variant 1:1, 005 đánh dấu lịch sử thiếu snapshot, 006 không backfill reservation hoặc movement. Tám bảng public mới có workspace FK, RLS SELECT và write qua RPC; helper/request ledger private. Bằng chứng và rollback ở [Phase B](../PHASE_B_COMMERCE_FOUNDATION.md), [verification](../verification/PHASE_B_VERIFICATION.md). Schema/migration cũ không sửa.

Rủi ro lớn nhất hiện tại là đường nâng cấp từ dữ liệu có sẵn, không phải thiếu màn hình. Không đổi ledger cũ để khớp sơ đồ; không tạo kho khả dụng độc lập bỏ qua reservations cũ. Rollback ưu tiên dừng entry path mới và sửa tiến; không xóa lot/allocations hoặc phục hồi đè lên giao dịch mới.

Phase C ban đầu thêm 007/008; phạm vi hiện tại bổ sung 009 rồi 010, không sửa migration lịch sử hoặc backfill ticket/giữ tồn/doanh thu. 009 giữ nguyên bình luận trùng cũ và đánh dấu cần đối chiếu; 010 chỉ gán default cho trường hợp account cũ duy nhất đang bật, không dựng thời điểm kết nối lịch sử. Chi tiết đường áp dụng và khôi phục tại [migration plan](V2_MIGRATION_PLAN.md) và [verification TikTok Channel](../verification/TIKTOK_CHANNEL_VERIFICATION.md). Cart conversion/Zalo/shipping/COD vẫn ngoài phạm vi; A1/C7 chưa được đóng bằng mock hoặc kiểm thử local.
