# V2 — khoảng cách với target

15/09/2026, hồ sơ A1. So sánh [trạng thái thực tế](V2_CURRENT_STATE.md) với [target đã có](../KIEN_TRUC_CHIDI_ERP_CHIDIPOS_V1_1_TARGET.md). Phân loại mô tả mã/schema; không tự mang nghĩa đã nghiệm thu cloud. Không triển khai các mục tương lai trong phiên này.

| Phần | Bằng chứng hiện tại | Phân loại | Khoảng thiếu / action |
|---|---|---|---|
| React JS / Supabase | App, repository, useErpSession | EXISTS_AND_COMPATIBLE | Giữ ứng dụng hiện tại |
| Workspace / RLS / roles | 001/002/003, bốn role, FK workspace | EXISTS_NEEDS_EXTENSION | A1 xác minh schema và phiên cloud; A4 test bán theo quyền |
| Audit | audit_events và RPC cloud; demo thiếu audit chung | EXISTS_NEEDS_EXTENSION | A9 đồng nhất contract trong phạm vi an toàn |
| Catalog / SKU | products đã là SKU được ledger tham chiếu | EXISTS_NEEDS_EXTENSION | Giữ product ID khi mở rộng kiểu dáng/variant |
| Variants / aliases | Chưa có bảng và resolver | MISSING | Phase B; không đổi nghĩa SKU hiện tại |
| Kho | warehouses | EXISTS_AND_COMPATIBLE | Giữ workspace FK |
| Stock / FIFO | stock_movements + lots/allocations/events | EXISTS_NEEDS_EXTENSION | Lỗi upgrade 003; chưa có test cạnh tranh; A1/A4/A5 |
| Reservations | sales_allocations.status=reserved | EXISTS_NEEDS_EXTENSION | Hiện bắt buộc order/line; chưa dùng trực tiếp cho ticket trước đơn |
| Customers | customers + save_customer | EXISTS_NEEDS_EXTENSION | Liên hệ cơ bản; thiếu xác minh identity |
| Identities / merge history | Chưa có | MISSING | TikTok LIVE, Shop, Zalo, phone cần identity riêng |
| Customer addresses / snapshot | customers.address mutable | MISSING | Không có địa chỉ/tên snapshot trên đơn; A10 ghi rủi ro, Phase B2 mới xây |
| Orders / price snapshot | sales_orders/lines | EXISTS_NEEDS_EXTENSION | Có giá/discount; thiếu nguồn cart, xác nhận khách và snapshot nhận hàng |
| Customer confirmation | confirm hiện là nhân viên giữ tồn | MISSING | Không được coi là khách đã xác nhận đơn |
| Payments / deposit / refund | cash_transactions chưa gắn order | MISSING | Cần chứng từ và liên kết thanh toán riêng |
| Campaign / session / STT | Chưa có | MISSING | Sau Phase A và nền tảng commerce |
| Normalized comments / parser / claim lock | Chưa có | MISSING | Comment và gợi ý parser không tạo bán/giữ tồn |
| Live Sale Ticket / VOID | Chưa có | MISSING | Không dùng sales_order thay ticket một cách ngầm định |
| Basket number / Customer Cart | Chưa có | MISSING | Cart từ ticket active, không từ raw comments |
| CHỐT & IN | Chưa có commit_live_sale_ticket | MISSING | Atomic/idempotent ticket + cart + reservation + print job + audit + outbox |
| Print job / attempts / reprint | Chưa có | MISSING | In sau commit; retry không tạo bán lần hai |
| Mobile printing | Responsive CSS, chưa có bridge | MISSING | Thiết bị/máy in thực tế cần kiểm chứng ở phase phù hợp |
| Realtime | Hiện tải lại dữ liệu | MISSING | Chỉ phục vụ UX; DB tiếp tục là nguồn quyết định |
| TikTok LIVE provider | Chưa có adapter | MISSING | Bắt đầu bằng contract/simulator sau nền tảng; chưa xây lúc này |
| TikTok Shop API | Chưa có | DEFER | Tách khỏi LIVE provider |
| Zalo manual claim/link | Chưa có | MISSING | Xác minh, hạn dùng và chống dò mã trước liên kết identity |
| Zalo OA automation | Chưa có | DEFER | Manual flow phải dùng được độc lập |
| Fulfillment / shipment / package | ship cả đơn, carrier/tracking nhập tay | EXISTS_NEEDS_EXTENSION | Chưa chia kiện, xuất từng phần hoặc shipping label |
| Shipping label | Chưa có | MISSING | Tách document vận chuyển với live ticket |
| Returns / damaged | Có hoàn bán lại được | EXISTS_NEEDS_EXTENSION | Chưa có damaged/quarantine/kiện thiếu |
| COD settlement | Giao không tạo cash | MISSING | Giữ DELIVERED != COD_SETTLED; settlement không thêm doanh thu |
| Webhook inbox / outbox / retry / dead-letter | Chưa có | MISSING | Phải có trước khi bật side effect tích hợp; không chờ đến cuối hardening |
| Reconciliation | Import nguồn và báo cáo tiền | EXISTS_NEEDS_EXTENSION | Thiếu đối soát hãng/COD/kho đa nguồn |
| Commerce reporting | Lũy kế net sales/COGS/gross profit/transit | EXISTS_NEEDS_EXTENSION | Chưa phân kỳ/kênh/campaign; get_sales_state chưa phân trang |
| Migration upgrade | 003 clean PASS, populated FAIL; metadata comparator local đã có | EXISTS_CONFLICTS | A1 blocker 55006; chưa nhận JSON cloud; giữ nguyên lịch sử migration |
| Future-date contract | Docs có; server/demo chưa đủ | EXISTS_CONFLICTS | A3; không sửa chỉ ở UI |
| Demo history contract | date/payload.reason khác UI | EXISTS_CONFLICTS | A2 sau A1 |
| Version / docs | App V2.0, package 1.1.0 | EXISTS_CONFLICTS | A7; không hạ V2 về V1.1 |
| CI / monitoring / deploy | Local launcher/build có; chưa có CI/worker | MISSING | Ghi nhận giới hạn; không mở rộng hạ tầng trong A1 |
| Backup/restore drill | Chưa có kết quả restore | MISSING | A11 riêng; không gọi backup verified |
| Microservices / SaaS | Không cần để chạy hiện tại | DEFER | Giữ modular monolith |

## Kiểm soát migration cho các khoảng thiếu

Các thay đổi schema sau 003 phải nằm trong migration **mới**, được đối chiếu với schema thực tế trước. Chưa tạo migration nào ở A1. Mỗi action có schema delta cần ghi bảng/hàm, FK workspace, RLS, role RPC, chỉ mục, backfill, đối chiếu, kiểm thử và rollback trong kế hoạch tương ứng.

Rủi ro lớn nhất hiện tại là đường nâng cấp từ dữ liệu có sẵn, không phải thiếu màn hình. Không đổi ledger cũ để khớp sơ đồ; không tạo kho khả dụng độc lập bỏ qua reservations cũ. Rollback ưu tiên dừng entry path mới và sửa tiến; không xóa lot/allocations hoặc phục hồi đè lên giao dịch mới.

Các kiểm thử LIVE, printer, cart conversion, webhook và COD chỉ bắt buộc khi chức năng đó được triển khai. A1 chỉ kiểm nền hiện có; không dùng test mock để kết luận cloud hoặc thiết bị thực đã PASS.
