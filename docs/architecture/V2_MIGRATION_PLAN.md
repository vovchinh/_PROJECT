# V2 — kế hoạch tiếp tục theo action

**Action chẩn đoán 25/09/2026:** ưu tiên [T0–T6 TikTok LIVE](../verification/TIKTOK_LIVE_CONNECTIVITY_AUDIT.md). T0 đã xác định lỗi chat v3, thời hạn CONNECT và thiếu viewer/listener health. Không coi việc áp dụng 011 đơn thuần là đủ để khắc phục tất cả. Chưa có migration mới hoặc thay đổi cloud trong action chẩn đoán; tuân thủ điều kiện dừng tại mục 36 của [prompt](../CODEX_TIKTOK_LIVE_CONNECTION_DIAGNOSE_COMPLETE.md).

**Action 24/09/2026 — 011: PASS local.** Sửa điều kiện khóa ID chưa có phiên và xử lý STREAM_END tự ngắt bằng RPC nguyên tử/idempotent. Hồi quy 540 check, 57 UI, 77 service, 18 native concurrency và build PASS. Nếu đã cài 010, bước triển khai kế tiếp chỉ là [011_tiktok_live_end.sql](../../supabase/migrations/011_tiktok_live_end.sql), [verifier 011](../../supabase/verification/verify_tiktok_lifecycle.sql), khởi động lại listener và nghiệm thu theo [hướng dẫn](../TIKTOK_CHANNEL_SETUP.md). Không chạy lại file cũ; không mở phase sau. Phần 009→010 bên dưới giữ bằng chứng mốc trước.

Cập nhật **23/09/2026**. Phạm vi action mới nhất: **luồng TikTok ID đơn giản**, dùng lại nền Phase C và bổ sung 010 sau 009. Không mở rộng toàn bộ prompt FLIVE/009 hoặc các phase sau. Chỉ dẫn hiện tại là [AGENTS.md](../AGENTS.md); A1 và nghiệm thu cloud/thiết bị vẫn riêng.

## Đường áp dụng hiện tại — 009 → 010

| Bước | Trạng thái local / nội dung | Điều kiện triển khai |
|---|---|---|
| Xác nhận nền 001–008 đã hoàn tất | Giữ ID, ledger, ticket, holds và RPC CHỐT/VOID cũ | Kiểm lịch sử migration project; không chạy lại file đã thành công; lỗi V1 → 003/55006 vẫn thuộc A1 |
| `009_live_operations.sql` | Nền control/review, dedupe/metadata và cấu hình in; checkpoint **10/10** | Là dependency của 010; không coi checkpoint này là nghiệm thu toàn bộ vận hành/in theo prompt FLIVE |
| `010_tiktok_channel_flow.sql` | Account cũ dùng lại; thêm default/thời điểm quan sát và bốn bảng kênh, lệnh, ánh xạ campaign/session | Chạy một lần sau 009; không backfill phiên hoặc kết nối giả; publication FOR ALL TABLES bị chặn để bảo vệ token |
| Listener và giao diện kênh | Lưu ID, chọn kênh, CONNECT; listener xác nhận LIVE rồi mới tạo/chọn campaign/session | Giữ secret/phiên worker ngoài frontend; kho mặc định `CHIDI-MAIN`, hoặc workspace chỉ có một kho hợp lệ |
| Verifier và regression | Suite kênh **23/23**, `npm run check` **521 PASS**, build PASS; demo **5/5**, service **68/68**, UI **53/53**; native 001–010 **15/15 PASS** ngày 24/09 | Chạy [verify_tiktok_channels.sql](../../supabase/verification/verify_tiktok_channels.sql) bằng quyền quản trị sau migration; local PASS không xác nhận cloud đã cài |
| C7 và A1 | **PENDING/BLOCKED theo phạm vi bằng chứng cũ** | Nghiệm thu Supabase/Auth, TikTok và giấy in thật; không mở action phase sau |

010 có RLS, FK workspace, write qua RPC, actor server và lease/revision cho listener. CONNECT/OFFLINE không tạo campaign/session; LIVE đã xác nhận chọn campaign theo kênh/ngày Việt Nam, phòng mới cùng ngày giữ campaign/STT. Ngắt kết nối chặn ingestion mới và báo cáo cũ; đổi username đã có yêu cầu kết nối bị chặn cả qua RPC account cũ. Xem [verification TikTok Channel](../verification/TIKTOK_CHANNEL_VERIFICATION.md).

Khôi phục: nếu migration đang chạy lỗi, transaction rollback; không chạy lại file đã commit. Khi cần dừng luồng mới, ngắt yêu cầu kênh/dừng supervisor và ẩn entry point mới, giữ nguyên mapping, ticket, print attempts, audit và holds để đối chiếu. Sửa tiến bằng migration mới; không xóa 009/010 khỏi database, hạ hàm kho hoặc khôi phục đè dữ liệu đã phát sinh.

## Lịch sử — Phase C bàn giao ngày 22/09/2026

Bảng dưới ghi kết quả tại migrations 001–008. Các số liệu và chỉ dẫn “tiếp theo” tại mốc này không thay thế đường 009 → 010 ở trên.

| Action | Đã xây dựng | Bằng chứng / nghiệm thu |
|---|---|---|
| C0 | Kiểm schema 001–006, RPC kho/FIFO/role, dependency và ranh giới | [Kế hoạch trước thay đổi](PHASE_C_IMPLEMENTATION_PLAN.md); Phase B local PASS |
| C1 | 007: account TikTok, campaigns/sessions, normalized comments, ingestion dedupe, claim lease | 25 kiểm tra database; không tạo sale/stock khi ingest |
| C2 | 008: STT/cart/ticket snapshots, atomic commit, live holds, print job/attempt, outbox, VOID | 27 kiểm tra database; clean + upgrade populated V2/Phase B |
| C3 | Parser SKU/alias/thuộc tính rõ, review SKU chưa chắc, ambiguity; helper tổng/lọc/nhóm Live | Parser không thực hiện mutation; helper read model **10/10 unit tests PASS** về BigInt, VOID, ngày và STT |
| C4 | Sáu khu vực theo tham chiếu: bàn live/giỏ/lịch sử/queue/báo cáo/setup; role guards, realtime + polling, mobile và in thử | **23/23 UI tests PASS** = 13 luồng cũ + 10 UX mới, API mô phỏng; [hồ sơ UI/UX](PHASE_C_UI_UX.md); không phải cloud acceptance |
| C5 | Worker NDJSON/TikTok, interactive ERP login, browser/USB và local LAN raster bridge; shutdown drain và deadline in | **27/27 service tests PASS**; [Service README](../../services/live-bridge/README.md); simulator/dry-run và Edge local; giấy/TikTok thật còn chờ |
| C6 | Native concurrency, hồi quy, metadata/reconciliation và tài liệu | [Verification Phase C](../verification/PHASE_C_VERIFICATION.md), gồm 8 native PostgreSQL checks |
| C7 | Áp dụng 007→008, nghiệm thu cloud, tài khoản TikTok và máy ZYWELL của ChiDi | PENDING — theo [hướng dẫn Phase C](../PHASE_C_LIVE_COMMERCE.md) |

Hồi quy cuối ngày **22/09/2026 trên mã đã đóng băng**: `npm run check` **288 PASS** = 56 unit + 25 core DB + 41 operations + 40 catalog + 36 customers + 24 inventory + 25 intake + 27 commerce + 14 verification; build PASS. Toàn bộ cloud UI với API mô phỏng **41/41 PASS**, demo **5/5 PASS**. Thay đổi UI không cần migration mới: giữ nguyên schema 007/008, STT, ticket snapshots và luật CHỐT/VOID/in lại; giá trị báo cáo Live không phải doanh thu hoặc tiền đã thu.

Migration lịch sử 001–006 giữ nguyên; 007/008 không backfill chứng từ cũ thành live ticket. Live hold dùng bảng/lots hiện tại và được bảo vệ khỏi release/transfer ngoài VOID; availability/FIFO cũ không có nguồn tồn song song. Không chạy DDL cloud trong phiên phát triển.

**Action tiếp theo tại mốc 22/09: C7**, xác nhận 006 đã hoàn tất rồi áp dụng 007/008 một lần trong môi trường thử, chạy `verify_phase_c.sql` và checklist thực tế. Hệ thống hiện tại cần thêm 009/010 theo phần đầu. Không mở Phase D; giữ ticket/holds/attempts khi cần dừng và sửa tiến.

## Phase B — triển khai và bàn giao

| Thứ tự | Action | Kết quả hiện tại | Migration / bằng chứng |
|---|---|---|---|
| B0 | Kiểm schema V2 thực trong repo, ID/FK, ledger, role và dependency | PASS local | 001/002/003 nguyên trạng; baseline và fixture V2 có dữ liệu |
| B1 | SKU tương thích, parent styles, variants, aliases, ambiguity | Đã triển khai; 40 kiểm tra database PASS | 004_catalog_variants_aliases.sql |
| B2 | Customer identities/addresses, snapshot đơn, kế hoạch thanh toán | Đã triển khai; 36 kiểm tra database PASS | 005_customer_order_foundation.sql |
| B3 | Manual holds cùng FIFO cũ; release/transfer/replay, RLS/audit | PASS local, 24/24 kiểm tra | 006_inventory_reservations.sql |
| B4 | Repository/UI 5 tab, Sales Detail snapshot, role/workspace/error guards | 12 kiểm thử UI mới PASS với API mô phỏng | CommerceFoundation.jsx, repository.js, Sales.jsx |
| B5 | Hồi quy, tranh chấp tồn, documentation và bàn giao | PASS local: 223 kiểm tra, gồm 7 native concurrency; build PASS | [PHASE_B_VERIFICATION.md](../verification/PHASE_B_VERIFICATION.md) |
| B6 | Áp dụng 004→005→006 và nghiệm thu workspace Supabase thử | PENDING — chưa có bằng chứng cloud thực | [Hướng dẫn Phase B](../PHASE_B_COMMERCE_FOUNDATION.md) |

Dependency cho B1 là 003 **đã hoàn tất**; B2 sau 004; B3 sau 005. Cài rỗng 001→006 và nâng cấp V2 có dữ liệu được kiểm thử riêng. Đường V1 có dữ liệu → 003 lỗi `55006` không nằm trong đường nâng cấp đã thông qua và chưa được chữa bằng Phase B.

Không có thay đổi ID sản phẩm, không reimport Excel hoặc ghi lại doanh thu. 004 tạo variant chờ đối chiếu; 005 không dựng lại snapshot cũ; 006 không chuyển allocations cũ sang bảng mới. Tám bảng mới có RLS/workspace FK, chỉ ghi qua RPC, audit actor và uniqueness server. Chỉ hai RPC kho của 003 được thay thế **trong file 006** để cộng/trừ manual holds; arithmetic/state/ledger gốc giữ nguyên.

Khôi phục: dừng entry point mới và sửa tiến bằng migration kế tiếp. Không xóa reservation hoặc khôi phục hàm cũ bỏ qua hàng đang giữ. Không chạy lại migration đã thành công. Chi tiết test, đối chiếu và rollback theo [hướng dẫn](../PHASE_B_COMMERCE_FOUNDATION.md).

**Bước cloud sau bàn giao Phase B:** áp dụng và nghiệm thu Phase B trong workspace Supabase thử theo hướng dẫn; tiếp tục đối chiếu metadata A1. Phase C đã được bổ sung ở phần đầu tài liệu; không mở rộng sang D/E/F/G.

## Hồ sơ A1 trước khi người dùng mở rộng phạm vi

File kế hoạch này chưa tồn tại lúc bắt đầu phiên. Thứ tự dưới đây được khôi phục từ [CODEX_PHASE_A_STABILIZE_VERIFY_V2.md](../CODEX_PHASE_A_STABILIZE_VERIFY_V2.md); không suy đoán rằng các action đã chạy xong. Mã V2 hiện có được giữ nguyên.

## Phụ thuộc trước khi thực hiện A1

| Phụ thuộc cho kiểm tra A1 | Trạng thái | Bằng chứng |
|---|---|---|
| Có repository hiện tại và chỉ dẫn Phase A | PASS | App/repository/sales code, [AGENTS.md](../AGENTS.md), Phase A prompt |
| Có migration 001/002/003 nguyên trạng để kiểm tra | PASS | SHA-256 được ghi trong baseline; git diff lịch sử trống |
| Có runtime kiểm tra cô lập | PASS | Node 24.21.0, npm 11.19.0, PGlite/Playwright đã cài |
| Có quyền làm kiểm tra đọc và ghi tài liệu local | PASS | Yêu cầu hiện tại; không cần DDL cloud |

Những phụ thuộc này cho phép kiểm tra A1. **Không đồng nghĩa A1 đã PASS.** Xác minh cloud/schema là kết quả cần thu thập của A1, không được điền PASS từ lời mô tả trong target.

## A1 — kết quả và blocker còn giữ

| Việc A1 | Trạng thái | Kết quả / còn thiếu |
|---|---|---|
| Khôi phục bốn tài liệu persistent từ mã và kiểm tra | PASS | current state, gap, plan, baseline verification |
| Xác định app/package/schema local | PASS | App V2.0, package 1.1.0, có 003 |
| Clean install 001→002→003 | PASS local | PGlite, không có dữ liệu business trước 003 |
| Upgrade 003 từ hai phiếu nhập đã ghi | FAIL | SQLSTATE 55006; pending trigger events khi bật RLS inventory_lots |
| RLS/khách hàng/actor/đọc chéo workspace local | PASS giới hạn | Diagnostic A1; chưa bao phủ toàn bộ bán hàng |
| Chạy regression hiện có một lượt | Xem baseline | Không dùng regression V1.1 làm chứng nhận đầy đủ V2 |
| Xác nhận V2 objects có trên API cloud | PASS giới hạn | 6 bảng + get_sales_state trả 401/42501 với anonymous |
| Công cụ nhận và so metadata SQL Editor | PASS local | Một ô JSON; comparator 7/7; phát hiện grant theo cột và RPC search_path sai |
| Đối chiếu schema/RPC/grants/policy cloud với local | BLOCKED | Chưa có metadata SQL Editor của project thực |
| Xác minh đọc/phân quyền bằng phiên đăng nhập thực | BLOCKED | Chưa có bằng chứng hai workspace bằng phiên người dùng |

### Bước tiếp theo trong A1

Người dùng đã xác nhận chạy [verify_v2_baseline.sql](../../supabase/verification/verify_v2_baseline.sql), nhưng chưa cung cấp kết quả. Bản hiện tại trả **một ô JSON `v2_baseline`**, gồm tables/routines/policies/columns/constraints, để tránh mất result set trong SQL Editor. Đây là script `READ ONLY`, không phải migration và không đọc dòng bán hàng. Không chạy lại 001/002/003 để kiểm tra chúng có tồn tại hay không.

Sau khi có JSON thực, lưu tại `.tools/a1/cloud-v2-baseline.json` rồi chạy `node scripts/compare-v2-baseline.mjs .tools/a1/cloud-v2-baseline.json`. Baseline local do `node scripts/audit-v2-baseline.mjs` tạo tại `.tools/a1/v2-baseline.json`, không bị E2E xóa. Công cụ chỉ đọc file; không cần database URL hoặc token.

Kết quả mong đợi: đủ 8 bảng; 6 bảng public RLS bật; anonymous không có quyền; authenticated chỉ SELECT public tables và không có grant ghi theo cột; đủ 6 RPC public và 4 hàm private; RPC public có SECURITY DEFINER/search_path rỗng; private không cho client EXECUTE. So cả tên/thứ tự argument, kiểu trả về, volatility, policy, columns, constraints và function body hash. Metadata dùng `search_path=pg_catalog`; hash thân hàm chuẩn hóa CRLF→LF, không sửa chữ/SQL literal. Tên constraint tự sinh và thứ tự result row không quyết định khác biệt; nội dung, cờ và số lượng constraint vẫn được so.

**PASS comparator chỉ áp dụng cho phạm vi đã lấy metadata**, không xác nhận mọi hàm helper/overload, phiên đăng nhập hoặc toàn bộ deployment. Khác major PostgreSQL có cảnh báo riêng; khác metadata vẫn BLOCKED, không tự bỏ qua. A1 tiếp tục BLOCKED dù metadata sau này khớp nếu lỗi upgrade hoặc bằng chứng runtime chưa được xử lý.

Sau đối chiếu metadata, xác minh `get_sales_state` bằng phiên đã đăng nhập trong hai workspace thử sẵn có: thành viên đọc workspace của mình; người ngoài bị từ chối; không đọc/sửa dữ liệu shop khác. Không gửi mật khẩu, JWT hoặc Authorization header vào tài liệu. Chỉ lưu kết quả, thời điểm và nhãn môi trường đã che thông tin riêng.

### Xử lý blocker nâng cấp

Lỗi được tạo lại bằng [audit-v2-baseline.mjs](../../scripts/audit-v2-baseline.mjs), không chỉnh 003. Backfill ở 003 có thể tạo deferred trigger events trước câu ALTER TABLE bật RLS. Database rỗng không chạy nhánh dữ liệu này nên PASS clean install chưa đủ.

Một file 004 chỉ chạy sau 003 **không tự chữa được 003 đang thất bại trước đó**. Cần đối chiếu trạng thái cloud trước để thiết kế đường nâng cấp tương thích mới cho từng trạng thái; nếu cần bootstrap runner riêng phải trình bày và kiểm chứng, không sửa ngầm SQL lịch sử. Chưa tạo/chạy bản sửa ở A1. Cloud đang có objects không chứng minh lỗi upgrade local không tồn tại.

### Điều kiện đóng A1

- Có kết quả schema cloud, phạm vi Auth và quyền được ghi đúng mức bằng chứng.
- Lỗi upgrade đã được giải quyết qua action sửa phù hợp và đường nâng cấp được kiểm chứng; không đổi 001/002/003.
- Kiểm tra baseline liên quan PASS; các giới hạn còn lại được gắn đúng action, không bị đánh dấu hoàn tất.
- Cập nhật [baseline verification](../verification/V2_BASELINE_VERIFICATION.md), rồi mới chọn action kế tiếp.

### Tác động và rollback của thay đổi A1

- Thay đổi: tài liệu, diagnostic Node chạy DB tạm, SQL xuất metadata JSON, comparator/test chỉ đọc file.
- Migration/schema/backfill/RLS/RPC/UI/integration thay đổi: **không có**.
- Không ghi Supabase, không thay nguồn Excel, cấu hình hoặc dữ liệu localStorage.
- Rollback: bỏ các artifact A1 nếu cần; không có database rollback. Trong diagnostic, transaction 003 thất bại đã rollback và ledger gốc được so sánh giữ nguyên.

## Các action sau — chưa thực hiện

| Thứ tự | Action trong Phase A | Trạng thái | Schema dự kiến |
|---|---|---|---|
| A2 | Đồng nhất event history demo/UI | NOT STARTED | Không dự kiến schema |
| A3 | Chặn ngày tương lai đúng giờ Việt Nam | NOT STARTED | Migration mới; không sửa 001/002/003 |
| A4 | Coverage bán hàng SQL/domain/UI | NOT STARTED | Chỉ thêm schema fix mới nếu test chứng minh cần |
| A5 | Test tồn kho bằng hai kết nối PostgreSQL | PARTIAL — Phase B có 7 native checks | Không tự đóng toàn bộ baseline/cloud/load-test action |
| A6 | Mở rộng cloud probe dùng lâu dài | NOT STARTED | Không DDL cloud từ probe |
| A7 | Version/docs/portal thống nhất | NOT STARTED | Không schema |
| A8 | Làm rõ sổ nhập và tồn V2 | NOT STARTED | Giữ nguyên nghĩa báo cáo 002 |
| A9 | Audit parity demo/cloud | NOT STARTED | Không giả lập quyền cloud là đã kiểm chứng |
| A10 | Ghi rủi ro snapshot lịch sử | NOT STARTED | Chưa xây identity; không backfill thành sự thật lịch sử |
| A11 | Backup/restore có bằng chứng | NOT STARTED | Restore vào đích thử riêng |

Phase B/C đã được người dùng yêu cầu riêng và triển khai ở phần đầu tài liệu. Các action Phase A còn thiếu vẫn giữ đúng trạng thái; không đánh dấu hoàn tất A2–A11 vì có tính năng mới. Đọc [gap analysis](V2_TARGET_GAP_ANALYSIS.md) khi cần bối cảnh; không tự mở rộng sang Phase D/E/F/G.
