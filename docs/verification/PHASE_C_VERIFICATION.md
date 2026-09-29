# Verification Phase C — LIVE và CHỐT & IN

**Mốc mới 23/09/2026:** kết quả sau bổ sung 009/010 và luồng TikTok đơn giản được ghi tại [TikTok channel verification](TIKTOK_CHANNEL_VERIFICATION.md). Các số liệu bên dưới là bằng chứng lịch sử của 007/008 ngày 22/09, không phải tổng kiểm thử hiện tại.

Hồi quy cuối ứng dụng/database/UI ngày **22/09/2026**, sau khi hoàn thiện giao diện theo bảy ảnh Live Commerce. Native concurrency được kiểm ngày 18/09; service hoàn thiện và kiểm ngày 21/09, mã các phần này không thay đổi trong đợt UI. Phạm vi: 007/008, giao diện live, parser, print bridge và worker. Kiểm thử dùng database/fixtures tổng hợp và máy chủ cô lập. Không sửa Excel, nhập lại dữ liệu shop, thay credentials hoặc chạy migration trên Supabase thật.

**Mã ứng dụng và database đã qua hồi quy local. Nghiệm thu production chưa hoàn tất:** còn Supabase/Auth thật, tài khoản TikTok, máy ZYWELL 822, thiết bị di động/hosting và backup/restore. Các giới hạn này là điều kiện bàn giao vận hành, không được đánh dấu PASS từ mock.

## Kết quả chức năng Phase C

| Bộ kiểm tra | Kết quả | Lệnh / bằng chứng |
|---|---|---|
| Intake database | 25/25 PASS | `npm run test:live-intake`; `test-results/live-intake.json` |
| Ticket/cart/hold/print/VOID | 27/27 PASS | `npm run test:live-commerce`; `test-results/live-commerce.json` |
| SQL verification, cả healthy và cố ý sai | 14/14 PASS | `npm run test:live-verification`; `test-results/live-verification.json` |
| Parser và browser/bridge contract | 36/36 PASS | Vitest `src/lib/live-parser.test.js`, `print-bridge.test.js` |
| Tổng/lọc/nhóm dữ liệu chỉ đọc | 10/10 PASS | `src/lib/live-view.test.js`; BigInt, VOID, STT, khoảng ngày |
| UI Live với API giả | 23/23 PASS | 13 luồng cũ `tests/cloud/live.spec.js` + 10 luồng mới `live-ux.spec.js`; Edge trên port 5201 |
| Tranh chấp PostgreSQL native | 8/8 PASS | `npm run test:live-concurrency`; `test-results/live-concurrency.json` |
| Worker và LAN bridge | 27/27 PASS | `npm run test:live-services`; Auth/provider giả, raster bằng Edge thật |

Đã chạy các bộ liên quan trước khi chạy một vòng hồi quy tổng thể. Những bộ được chạy lại do sửa lỗi có bằng chứng không được cộng lặp vào số kiểm tra.

## Bằng chứng database và nghiệp vụ

- Cài rỗng 001–008 và upgrade từ V2/Phase B có khách, tiền, lô FIFO, manual hold, đơn confirmed/shipped và lịch sử. So các bảng cũ trước/sau: không thay SKU UUID, ledger, allocations hoặc audit cũ; đơn/giữ hàng cũ tiếp tục hoạt động.
- 007: normalized comment giữ nguyên text quan sát, ID nguồn dạng chuỗi, kiểm timestamp; duplicate giống hệt trả ID cũ, khác nội dung rollback cả batch. Bình luận/parser/claim không tạo sale hoặc reservation. Hồ sơ chỉ chứa handle công khai, khóa thay nguồn lịch sử, disable chặn nhận mới.
- Claim 120 giây kiểm actor/token/expiry; RPC chỉ trả token cho holder. Workspace khác, anonymous và viewer không được mutation. Owner cũng không ghi trực tiếp bảng hoặc gọi helper private.
- 008: chốt nguyên tử ticket/cart/item/reservation/print job/audit/outbox. Không đủ tồn thì rollback cả STT, request và audit; retry cùng UUID trả cùng entities, khác payload/actor bị chặn. Một bình luận không được bán lại sau VOID.
- STT theo campaign + provider + stable user ID; cùng tên không merge. Snapshot sản phẩm/giá/khách bất biến; identity TikTok rõ ràng xung đột với lựa chọn ERP thì từ chối. SKU provisional hoặc mapping chưa xác nhận không được commit.
- Live hold dùng cùng lots và availability 006; thủ công không được release/transfer/relink để bỏ qua ticket. Không tạo sales order, physical movement, doanh thu, COGS hoặc cash khi chốt/in/VOID.
- Một job/ticket; lease nhận in độc quyền, attempt riêng, replay không tự nhận lại attempt đã kết thúc. Xác nhận giấy tách khỏi hộp thoại/TCP. Hết hạn có thể finish bằng token còn hiện hành; requeue đổi fence nên kết quả token cũ bị từ chối.
- VOID giữ lịch sử, bỏ active cart item, release đúng một lần và hủy job; đang printing phải đối soát trước. Reprint không nhân đôi ticket/giỏ/tồn.

## Native concurrency

PostgreSQL **14.3** tại `C:\Program Files\PostgreSQL\14\bin`, cluster riêng `.tools/live-concurrency/run-*`, bind loopback và chọn cổng riêng; không dùng service/database/credentials đang có. Bảy cặp client `psql` độc lập được quan sát đồng thời chờ lock trước khi mở barrier. Không dùng PGlite hoặc lời gọi tuần tự để khẳng định cạnh tranh.

1. Hai nhân viên cùng claim một bình luận: một holder.
2. Cùng bình luận, hai UUID commit: chỉ một bộ business entities.
3. Hai lần retry cùng request: một ticket/cart item/hold/job/audit/outbox.
4. Hai bình luận tranh hàng cuối: một thành công, bên thua rollback toàn bộ.
5. Hai người nhận cùng job: một lease/attempt.
6. Hai lần requeue cạnh tranh: không tạo business effects mới.
7. Hai lần VOID cạnh tranh: release một lần, lịch sử còn nguyên.
8. Tổng thể không âm khả dụng, không phát sinh ERP order/cash/revenue hoặc thay physical stock.

Report có `simultaneous_sessions_tested=true`, 7 cặp chờ khóa và `own_cluster_stopped=true`. Cluster thử đã dừng và thư mục của lần chạy này được dọn. Native Phase B 7/7 cũng chạy lại PASS trong hồi quy. Các kết quả này không thay load test hoặc nghiệm thu Supabase thật.

## Metadata và đối chiếu bàn giao

[verify_phase_c.sql](../../supabase/verification/verify_phase_c.sql) chạy transaction read-only/repeatable-read và trả **một ô JSON `phase_c_verification`**. Chạy bằng SQL Editor/quyền quản trị; chạy dưới phiên bị RLS lọc sẽ báo FAIL để tránh kết quả sạch giả.

Script kiểm 12 bảng live, 20 routines public/private, 22 composite workspace links, uniqueness, triggers bất biến, quyền bảng/cột/RPC, RLS/policy và publication. Chỉ xuất metadata và số lượng sai lệch, không xuất bình luận, tên khách, business IDs, receipt hoặc token. So ticket ↔ cart item ↔ hold ↔ lot allocations ↔ print job/attempt ↔ outbox; timestamp so theo thời điểm tuyệt đối để không báo sai khi SQL Editor khác múi giờ.

Harness cố ý làm sai grants/RLS/FK/triggers/cart quantities/outbox/lots/publications để chứng minh verifier phát hiện lỗi. Một installation hợp lệ có publication tường minh và token được loại khỏi danh sách cột sẽ PASS. Publication khác hoặc thay đổi sau cài đặt có thể xuất `claim_token`, `lease_token` hoặc private request results; verifier quét mọi publication để phát hiện. Thiếu Realtime chỉ cảnh báo vì UI còn polling.

## Giao diện và services

13 UI tests cũ tiếp tục PASS: setup account không secret, session liên kết đúng, ingest không chốt, parser gợi ý, cùng UUID sau mất phản hồi, popup bị chặn, in lại không bán lại, claim conflict, thiếu hàng, viewer/staff, mobile 390px, keyset pagination, response muộn sau đổi workspace, thiếu migration, lỗi catalog không bị lần refresh che mất và polling khi realtime mất kết nối.

10 UI tests mới kiểm tìm/lọc bình luận không ghi nghiệp vụ; chế độ chỉ xếp hàng đợi chốt một lần và không nhận in; giỏ cùng tên giữ STT riêng/lịch sử VOID; VOID đúng phiếu; hàng đợi đúng giỏ; lịch sử mở đúng phiên/chiến dịch; báo cáo loại VOID và cộng chính xác số tiền vượt giới hạn Number; mobile 390px và desktop 1280px không tràn ngang; xem/in mẫu tiếng Việt 0 đ không gọi RPC bán hoặc giữ hàng. Bộ 10 unit tests mới kiểm riêng hàm tính tổng/lọc/nhóm, ngày Việt Nam và dữ liệu chưa rõ.

Đã xem ảnh [mobile](../../test-results/live-ux-mobile.png) và [desktop](../../test-results/live-ux-desktop.png) tạo trong lần hồi quy cuối. Sáu tab, màu vàng/biểu đồ xanh và bố cục giỏ được đối chiếu với [hồ sơ UI/UX](../architecture/PHASE_C_UI_UX.md). Ảnh và API đều dùng fixture, không chứa dữ liệu shop.

Services có dependency và lockfile riêng, không đưa connector TikTok vào frontend. **27/27 PASS**, gồm spool chống gửi lại sau restart, hai job được gửi tuần tự, khóa một worker cho mỗi workspace/phiên, shutdown chờ ghi/ACK hoàn tất, khởi động bị ngắt không để heartbeat chạy lại và timeout không gửi giấy muộn. Thời hạn 15 giây của bridge gồm chờ hàng đợi/raster/gửi; kiểm tra render chậm và job chờ quá hạn không phát lệnh sau khi frontend timeout. Test dùng Auth/provider giả, socket gửi giả và Edge thật để raster chữ Việt; không kết nối TikTok/Supabase hoặc máy in vật lý. Lệnh và cách tái tạo nằm ở [README](../../services/live-bridge/README.md).

## Hồi quy ứng dụng

| Lệnh | Kết quả cuối, 22/09/2026 trừ khi ghi riêng |
|---|---|
| `npm run check` | **288 PASS** = 56 unit + 25 core DB + 41 operations + 40 catalog + 36 customers + 24 inventory + 25 intake + 27 commerce + 14 verification; Vite build PASS |
| `node scripts/test-v2-metadata.mjs` | 7/7 PASS; kiểm comparator, không phải metadata cloud thật |
| `npm run test:e2e` | 5/5 PASS; demo, port 5199 |
| `npm run test:cloud-ui` | 41/41 PASS = 6 Auth/workspace + 12 Phase B + 23 Phase C; API giả |
| `python scripts/test-export.py` | 5/5 PASS; fixture riêng, không sửa nguồn |
| `npm run test:builds` | 5/5 PASS; cloud/demo, chặn secret/service-role, khôi phục configured build |
| `npm run test:concurrency` | 7/7 PASS; native Phase B, 18/09 |
| `npm run test:live-concurrency` | 8/8 PASS; native Phase C, 18/09 |
| `npm run test:live-services` | 27/27 PASS; worker/bridge, 21/09 |

Tổng **393 kiểm tra PASS** trong hồ sơ trên, không cộng lặp các lần chạy targeted. Main bundle khoảng **552,43 kB**, Vite còn cảnh báo ngưỡng 500 kB; module LiveCommerce lazy load khoảng **66,88 kB JS + 16,19 kB CSS**. Build không lỗi. Không tuyên bố đã xử lý toàn bộ technical debt/version/lint Phase A.

## Migration lịch sử giữ nguyên

SHA-256 kiểm lại sau triển khai:

| File | SHA-256 |
|---|---|
| 001_core.sql | `6755f58cb4022be6c681221b35fdfdc0fa1cfc64026882a757800b5c79e0a9cb` |
| 002_operations.sql | `ebecdb235ff9125b40108e52eb903ebb317ad8fe1155484036e5238119103633` |
| 003_sales_inventory.sql | `b3c93e7ba0194a59fc7cc8256d04c20eecc64959863e67a725bf07b731c32aa3` |
| 004_catalog_variants_aliases.sql | `a28883dcf387d7dccfc9893330291ecb9c7aadcee27b49f25f6d4369ca8ed6b5` |
| 005_customer_order_foundation.sql | `8266fac7e0635ced75cca640a42e455b86eeed5acbe72094136422cc1e53bd7f` |
| 006_inventory_reservations.sql | `933379a8c15cada098234bc65d65720dbce2cd1dd811e271373838fc7ea04f0e` |

Lỗi A1 `003/55006` trên V1 có dữ liệu vẫn chưa sửa, không nằm trong đường upgrade Phase C đã kiểm. A1 metadata/Auth/backup vẫn có giới hạn được giữ tại [baseline](V2_BASELINE_VERIFICATION.md); không đổi FAIL cũ thành PASS hoặc dùng comparator 003 để bắt thân hàm 006 phải giống nguyên bản.

## Bàn giao và rollback

Action tiếp theo là nghiệm thu C7 theo [hướng dẫn Phase C](../PHASE_C_LIVE_COMMERCE.md), gồm 007→008, verifier, hai workspace thật, worker TikTok và giấy ZYWELL USB/LAN. Không triển khai Phase D/Zalo/cart-to-order/thu cọc/COD trong lần này.

Nếu cần dừng: dừng worker/chốt mới, đối chiếu print attempts và active holds; giữ ticket/audit và sửa tiến bằng migration mới. Không hạ availability về hàm bỏ qua holds, không xóa history hoặc tự restore đè giao dịch mới.

## File bàn giao Phase C

- `supabase/migrations/007_live_intake.sql`, `008_live_tickets_print.sql`, `supabase/verification/verify_phase_c.sql`
- `src/features/LiveCommerce.jsx`, `src/lib/live-parser.js`, `live-parser.test.js`, `print-bridge.js`, `print-bridge.test.js`
- `src/features/LiveInsights.jsx`, `LivePrinterPreview.jsx`, `live-commerce.css`, `src/lib/live-view.js`, `live-view.test.js`
- `src/App.jsx`, `src/features/CommerceFoundation.jsx`, `src/lib/repository.js`, `src/styles.css`
- `services/live-bridge/`: worker, login helper, printer server, raster, storage, fixtures, tests, README, `.env.example`, `.gitignore`, package/lockfile
- `scripts/test-live-intake.mjs`, `test-live-commerce.mjs`, `test-live-verification.mjs`, `test-live-concurrency.mjs`, `tests/cloud/live.spec.js`, `package.json`
- `tests/cloud/live-ux.spec.js`, `tests/cloud/helpers/live-fixture.js`
- `docs/PHASE_C_LIVE_COMMERCE.md`, `docs/verification/PHASE_C_VERIFICATION.md`, `docs/architecture/PHASE_C_IMPLEMENTATION_PLAN.md`
- `docs/architecture/PHASE_C_UI_UX.md`
- `docs/architecture/V2_CURRENT_STATE.md`, `V2_TARGET_GAP_ANALYSIS.md`, `V2_MIGRATION_PLAN.md`
- `README.md`, `TASKS.md`, `docs/USER_GUIDE.md`, `VERIFICATION.md`, `CHANGELOG.md`, `scripts/build_docs.py`, `docs/index.html`

Những thay đổi Phase B chưa commit và ảnh kiến trúc do người dùng thêm được giữ nguyên. Không tự commit/push hoặc triển khai hosting trong phiên này.
