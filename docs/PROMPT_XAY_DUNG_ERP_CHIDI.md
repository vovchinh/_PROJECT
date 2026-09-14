# Prompt triển khai và phát triển ChiDi ERP

> Cập nhật đầu vào 11/09/2026: project đang ở V1.1. Đã có bộ chọn workspace, team RPC/UI, report RPC/BigInt, `002_operations.sql` và kiểm thử mới. URL/key đã được người dùng điền, app cloud chạy localhost:2000. Đọc [TASKS](../TASKS.md) và [CHANGELOG](CHANGELOG.md) trước; không thực hiện lại phần đã làm hoặc chạy lại 001. Xác minh 002 đã được chủ project chạy và Auth thật trước khi coi cloud hoàn tất. Các mục “chưa có” ở mô tả V1 phía dưới là mốc nền, đối chiếu trạng thái mới này để chọn công việc tiếp theo.

Dùng prompt dưới đây để giao cho lập trình viên/coding agent. Đọc cùng kiến trúc và kết quả kiểm thử của project hiện có. Các phần mô tả giai đoạn tương lai là yêu cầu phát triển, không phải tuyên bố đã hoàn thành.

---

Bạn là kỹ sư phần mềm phụ trách ERP, hiểu quản trị tồn kho, công nợ, COD và kế toán quản trị. Hãy tiếp tục phát triển một sản phẩm chạy được cho ChiDi Shop, không dừng ở tư vấn hoặc tạo màn hình giả.

## A. Bối cảnh và ràng buộc không được thay đổi

Project nằm tại:

```text
D:\ChiDi Manager\ChiDi\_ERP\ChiDi\_Online\_ERP\_Project
```

ChiDi bán thời trang jeans/shorts, làm livestream, dùng FLive/Zalo trong hành trình đơn, giao hàng qua SPX/GHN/J&T và nhận COD. Khai trương ngày 18/08/2026. Tự xây theo nghiệp vụ ChiDi, ngôn ngữ dễ hiểu, dễ bảo trì. Stack: **JavaScript ES modules, React JSX, Vite, Supabase Auth + PostgreSQL + RLS + RPC**. Không tự chuyển sang TypeScript, Django, MongoDB hoặc dịch vụ trả phí bắt buộc.

Người dùng cho phép bổ sung tài khoản, Project URL và publishable key sau. Tiếp tục mọi việc có thể làm trên máy: code, schema, test, tài liệu, dữ liệu chuyển đổi. Không liên tục hỏi lại key hoặc mật khẩu. Khi chưa cấu hình cloud, chạy demo có nhãn rõ và dữ liệu riêng; không tự tải file shop lên mạng. Không tự tạo tài khoản/dịch vụ hoặc mua gói cho người dùng.

Đọc README, kiến trúc, hợp đồng database, hướng dẫn Supabase và verification trước. Kiểm tra trạng thái file hiện tại và giữ mọi chỉnh sửa của người dùng. Không ghi đè source Excel, không khôi phục một file cũ lên bản đang được dùng, không xóa thư mục để scaffold lại. Nếu cần nghiên cứu công nghệ/giá/hạn mức, dùng tài liệu chính thức hiện hành và ghi ngày kiểm tra.

## B. Những gì đã có và cách tiếp tục

V1 có dashboard, danh mục SKU/NCC/kho/tài khoản, phiếu nhập một SKU, thu chi, import có đối chiếu, sổ nhận hàng/sổ tiền, đảo và nhật ký. Có hai repository demo/cloud, migration SQL, test nghiệp vụ, test quyền bằng PostgreSQL PGlite và E2E. Chạy kiểm tra để biết thực trạng, không coi mô tả này thay cho đọc code.

Phần chưa triển khai gồm mời thành viên trong UI, báo cáo server nhất quán, đơn hàng/xuất/hoàn, FIFO bán, COD tự động, hóa đơn/AP/AR, sổ cái kép, khóa kỳ, backup tự động và tích hợp đối tác. Không tạo các menu chỉ có số minh họa rồi báo hoàn thành.

Ưu tiên một phần việc xuyên suốt: schema → quy tắc → RPC/API → UI → test → tài liệu. Nếu chưa được chỉ định module mới, ưu tiên cứng hóa cloud và vận hành nhóm trước, sau đó đơn hàng/kho, COD/công nợ, kế toán rồi các phần mở rộng. Giữ ứng dụng chạy được sau mỗi lần giao.

## C. Tiêu chuẩn nghiệp vụ và dữ liệu

1. Mọi chứng từ có ID ổn định, workspace, ngày nghiệp vụ, thời điểm tạo/sửa, người thực hiện, trạng thái và căn cứ. Ngày nghiệp vụ dùng `date`; timestamp lưu timezone-aware; giao diện dùng Asia/Ho_Chi_Minh.
2. Tách nguồn nhập, chứng từ nháp và sổ phát sinh. `source_status` không tự trở thành trạng thái được phép ghi. Ngày ước tính không ghi sổ; không có số dư không biến thành số 0 đã xác nhận.
3. Số tiền VND là số nguyên chính xác. Không nhận giá trị bị cắt/làm tròn âm thầm; kiểm tràn cả dòng và tổng. Nếu thêm decimal/ngoại tệ phải có migration numeric, chuỗi decimal qua API và quy tắc làm tròn đã quyết định.
4. Số lượng V1 theo sản phẩm nguyên. SKU thật phân biệt mẫu/màu/size; SKU tạm không được tự coi là mã đã xác nhận. Thay giá tham khảo không đổi giá trên phiếu đã ghi.
5. Tất cả FK nghiệp vụ phải bảo vệ workspace, dùng composite FK hoặc cách có bằng chứng tương đương. Không chỉ tin workspace ID do trình duyệt gửi.
6. Chứng từ nháp sửa được theo quyền. Chứng từ đã ghi không sửa/xóa trực tiếp số kinh tế; sai thì đảo/điều chỉnh có tham chiếu và lý do. Ngày đảo không trước ngày gốc hoặc vào kỳ đã khóa.
7. Nhập kho, hóa đơn mua, trả tiền nhà cung cấp là ba nghiệp vụ riêng. Nhận COD, doanh thu và phí vận chuyển là ba số riêng. Góp vốn/rút vốn không tự là doanh thu/chi phí.
8. Nguồn thật chưa đủ để tính doanh thu/lợi nhuận phải hiển thị “chưa đủ dữ liệu”, ghi rõ phần chưa đủ. Không lấp bằng dữ liệu demo hoặc giả định 0.

## D. Database và quyền

Giữ một database PostgreSQL chia phân hệ. Dùng SQL migration theo thứ tự, thử migration lên database sạch và bản đã có dữ liệu; không chạy migration phá dữ liệu để chữa lỗi môi trường. Hướng dẫn rollback thực tế: backup trước, migration bổ sung/restore đã thử; không hứa rollback bằng `DROP TABLE`.

Đọc dữ liệu qua API có RLS; ghi dữ liệu kinh tế qua RPC có transaction. Với SECURITY DEFINER: kiểm auth.uid, kiểm role và workspace mỗi lệnh; search_path an toàn; tên bảng đầy đủ; revoke PUBLIC/anon; grant execute đúng người dùng. Helper private không được mở quyền rộng cho khách gọi trực tiếp.

Role nền: owner, manager, staff, viewer. Nhân viên chỉ lập nháp; manager/owner duyệt ghi; owner quản lý số dư đầu, nhập nguồn và đảo. Khi thêm HR/kế toán, bổ sung quyền theo module và tách dữ liệu nhạy cảm. Không dùng việc ẩn nút để chứng minh bảo mật. Kiểm thử API bằng người không có quyền, người cùng project nhưng khác workspace, người đã bị thu hồi quyền và người chưa đăng nhập.

Quản lý thành viên cần owner thao tác, đối chiếu danh tính, audit thay đổi quyền, không tự nâng quyền từ metadata do user sửa. Không cho chủ cuối cùng của workspace tự bị xóa khỏi vai trò owner. Không nhầm Supabase organization team với ERP workspace membership. Nếu triển khai lời mời qua email, secret chỉ nằm server và chỉ gửi sau thao tác được người dùng yêu cầu.

Khi nhiều người cùng thao tác, khóa tài nguyên cần cập nhật, lấy khóa theo thứ tự ổn định, constraint bảo vệ sau cùng. `request_id` ổn định cho một lần người dùng gửi và retry; cùng request ID khác payload/action phải bị chặn. Các lệnh tạo mới có thể tạo trùng nếu mạng timeout sau commit: bổ sung khóa idempotency cho save/create khi cứng hóa, không chỉ khóa post.

V1 post idempotent theo trạng thái chứng từ và unique ledger. Không coi test replay tuần tự trên PGlite là chứng minh concurrency. Viết test với nhiều kết nối PostgreSQL thực khi thêm giữ tồn, nhiều dòng phiếu hoặc tài nguyên dùng chung.

## E. Phân hệ phải phát triển

### E1. Quản trị và danh mục

Workspace, thành viên, quyền theo module; sản phẩm/style/variant, đơn vị, SKU/barcode, NCC, khách, kho/vị trí, tài khoản tiền, kênh bán, đơn vị giao hàng, phân loại thu chi. Có tìm kiếm, bộ lọc, phân trang, xuất CSV an toàn và audit. Không xóa cứng danh mục đang được chứng từ tham chiếu; thiết kế ngừng dùng rõ ràng.

### E2. Nhập hàng và kho

PO header/lines, nhận từng phần, phiếu nhiều dòng, phí nhập phân bổ, hàng chờ kiểm, chuyển kho, kiểm kê, điều chỉnh có duyệt, tồn thực/tồn giữ/tồn khả dụng/đang đi, lô giá vốn. Ghi sổ cả phiếu trong một transaction, lỗi một dòng rollback toàn phiếu. Không tính bản nháp vào tồn. Quy tắc âm tồn cấu hình và chặn ở server.

### E3. Bán hàng và giao nhận

Khách, đơn/chi tiết, chiết khấu dòng/đơn, giữ tồn, hủy nhả tồn, đóng gói, bàn giao, giao một phần, hoàn một phần, đổi hàng và hoàn tiền. Trạng thái thanh toán độc lập giao nhận. Giữ một order ID nội bộ và unique external IDs theo nguồn/workspace. Không nhập một đơn từ hai kênh thành hai doanh thu.

### E4. COD và đối soát

Nhập CSV đối soát theo mapping cấu hình, giữ file/hash/dòng nguồn, xem trước, xác minh vận đơn, tổng COD, phí, thuế/phụ phí theo chứng từ, tiền ngân hàng, thiếu/thừa. Có khớp từng phần, nhiều đợt thanh toán cho một đơn nếu nghiệp vụ cho phép, ghi rõ unresolved. COD về ngân hàng chỉ thu hồi khoản phải thu; không thêm doanh thu. Tiền mua hàng cũng phải phân bổ vào hóa đơn/khoản ứng, không tính chi phí trùng.

### E5. Kế toán quản trị

Hóa đơn NCC, hàng nhận chưa hóa đơn, AP/AR, ứng trước, phân bổ thanh toán, danh mục tài khoản, journal header/lines, số dư đầu, kỳ kế toán, khóa kỳ, mở kỳ có lý do. Ghi sổ Nợ/Có phải cân trong transaction; đối chiếu stock/cash/AP/AR với GL. P&L theo dồn tích cần doanh thu/giá vốn/phí đúng kỳ; bảng cân đối và lưu chuyển tiền có định nghĩa rõ. Không tự hardcode thuế, hệ thống tài khoản pháp định hoặc tuyên bố tuân thủ khi chưa được kiểm chứng.

### E6. Các phân hệ sau

CRM/livestream theo phiên, hiệu quả marketing, chính sách khuyến mãi, lương/phải trả nhân viên, tài sản/khấu hao và phân bổ chi phí trả trước. Cấu hình quy tắc và ngày hiệu lực; lịch sử báo cáo không đổi khi sửa tham số tương lai. Trước mỗi phần, xác định nguồn dữ liệu và ai được xem. Chưa có dữ liệu thì để trạng thái chờ tích hợp rõ ràng.

## F. Tích hợp và vận hành

Chỉ triển khai API từ tài liệu chính thức/tài khoản được cấp. Bí mật để trong Supabase Edge Function hoặc backend JavaScript, không trong React hoặc `VITE_*`. Webhook kiểm chữ ký, thời gian, event ID, chống replay, xử lý sự kiện lặp/sai thứ tự và ghi audit. Outbox lưu cùng giao dịch nghiệp vụ, worker retry sau commit, có dead-letter/nhật ký lỗi để xử lý. Không tuyên bố exactly-once delivery qua mạng.

Báo cáo phải aggregate trên server theo một snapshot nhất quán khi triển khai đa người/dữ liệu lớn; không tải mọi bảng về trình duyệt vô hạn. Index theo workspace, ngày và khóa tra cứu. Xác định mục tiêu tải bằng dữ liệu đo được, không tự ghi SLA chưa thử. Không dùng Realtime thay cho giao dịch hoặc làm nguồn chứng cứ đã commit.

Free database không đồng nghĩa free mọi thứ. Ghi hạn mức và phương án nâng cấp/di chuyển; không tự mua gói. Tệp riêng tư, URL có thời hạn, kiểm loại/dung lượng, backup metadata và object riêng. Lập lịch backup ngoài hệ thống, bảo vệ/mã hóa theo môi trường, thử restore và ghi kết quả. RPO/RTO phải phù hợp cơ chế đã chạy; không cam kết 15 phút khi chỉ có dump hằng ngày.

## G. Chuyển dữ liệu Excel hiện có

Nguồn chính nằm trong `D:\ChiDi Manager\ChiDi_ERP\ChiDi_Online_Business_ERP.xlsx`. Kiểm tra lại file hiện tại trước khi chuyển; số snapshot ngày 10/09/2026 là 17 dòng nhập, 1.566 sản phẩm, 79.043.000 đ và 12 thu chi. Bản cũ 15 dòng không được ghi đè lên dữ liệu 17 dòng. Đơn bán trong snapshot là 0; không tự tạo doanh thu cho khớp COD.

Ngày khai trương được xác nhận, hai đợt đầu trước tháng 8 được xác nhận; ngày random theo tuần chỉ là ước tính. Các tài khoản chưa biết vẫn null/chờ đối chiếu. Những dòng nguồn đã đánh dấu ghi không tự được cấp trạng thái posted khi nhập sang ERP.

Dùng script read-only xuất JSON mới, SHA-256 file, legacy ID ổn định, nguồn sheet/dòng, giá trị và ghi chú gốc. Nhập lại file không trùng; file đổi hash nhưng cùng legacy ID không sinh bản mới. Nếu cùng ID có nội dung thay đổi, trả conflict có chi tiết, giữ dữ liệu hiện có. Không đổi ID nguồn để né kiểm tra. Thư mục dữ liệu thật gitignored và không nhập vào frontend bundle.

Chuyển số dư đầu kho/tiền/công nợ là bước riêng, cần thời điểm cutover và đối chiếu. Không vừa chuyển toàn bộ lịch sử vừa cộng số dư đầu cùng giai đoạn để làm tăng kép.

## H. Giao diện và khả năng sử dụng

Tiếng Việt dễ hiểu, font phổ biến, màu xanh trầm/kem, bố cục rõ, dùng được ở 390 px và desktop. Số tiền căn phải, có đơn vị và dấu nghìn; ngày hiển thị theo địa phương và ghi chú ngày ước tính. Form có label, trạng thái loading/empty/error/success, chống double submit, giữ nhập liệu khi lỗi, thông báo nguyên nhân cụ thể.

Lưu nháp và ghi sổ là hai thao tác riêng. Ghi sổ hiển thị chứng từ/số tiền và xác nhận; đảo yêu cầu lý do. Modal dùng keyboard/focus trap/Escape; nút icon có nhãn. Không bật dialog hỏi xác nhận cho mọi thay đổi nhỏ. Bộ lọc báo cáo phải ghi rõ kỳ và phạm vi; số dư tại ngày chọn không dùng ngày hôm nay ngầm.

Demo luôn có nhãn, dùng số giả có ghi chú; cloud lỗi không tự thay bằng demo. Không gọi các nhóm thanh toán là lợi nhuận hoặc công nợ phải trả khi chưa có nghiệp vụ đối ứng. Không đưa thông tin xây dựng app, secret, tên bảng kỹ thuật vào luồng của nhân viên trừ phần thiết lập quản trị cần thiết.

## I. Tiêu chí nghiệm thu bắt buộc

| Tình huống | Kết quả mong đợi |
|---|---|
| Nhập 3 × 85.000 + 5.000 | Tổng 260.000 chính xác, draft chưa tăng kho |
| Ngày 30/02 hoặc tiền 1,5 VND | Bị từ chối rõ ràng, không làm tròn âm thầm |
| SKU tạm/ngày ước tính/tài khoản chưa rõ | Không ghi sổ; nháp vẫn giữ để đối chiếu |
| Replay post, mất response sau commit | Một hiệu ứng ledger, audit có thể truy nguồn |
| Hai người bán sản phẩm cuối cùng | Không cấp tồn vượt chính sách; thử bằng hai kết nối thật |
| Đảo ngày sau ngày gốc | Trước ngày đảo thấy gốc, sau ngày đảo thấy ròng; không xóa nguồn |
| Workspace B biết UUID A | Không đọc, sửa hoặc tham chiếu FK trái workspace |
| Staff/viewer gọi RPC trực tiếp | Bị chặn theo quyền dù bypass giao diện |
| Import lại/cùng ID khác file hash | Không trùng; thay đổi nội dung báo conflict và không ghi đè |
| Hai bảng Excel cùng khoản trả tiền | Nhận diện một sự kiện, không cộng kép chi phí/kho |
| FIFO lô 5 × 80k + 5 × 90k, bán 7 | Giá vốn 580k, còn 270k; truy nguyên lô |
| Bán 300k, COD chuyển 275k, phí25k | Doanh thu theo chính sách 300k một lần, xóa phải thu 300k |
| Góp vốn/rút vốn/trả công nợ | Tiền đổi đúng, không tự đổi doanh thu/lợi nhuận |
| Sổ kế toán kép | Nợ = Có từng journal và đối chiếu subledger, chặn journal lệch |
| Kỳ đã đóng | Không ghi lùi/sửa vào kỳ, mở lại có quyền và audit |
| Report >1.000 dòng | Không bị cắt bởi mặc định API; paging/snapshot được kiểm tra |
| Backup restore | Khôi phục thử thành công, kiểm ID/quyền/tổng, ghi thời gian đo |

Chỉ áp dụng test cho nghiệp vụ đã triển khai trong giai đoạn; những tiêu chí chưa triển khai ghi rõ backlog. Không đổi tên/bỏ test sai để báo xanh. Không viết hàng loạt test chỉ lặp lại tên hàm; ưu tiên bất biến tài chính, quyền, lỗi và giao dịch thất bại không để nửa dữ liệu.

## J. Cách làm việc và đầu ra

Đầu lượt, đọc repo và chạy kiểm tra liên quan. Phân chia việc độc lập nếu tiết kiệm thời gian, giữ quyền sở hữu file rõ. Sửa lỗi, viết migration bổ sung, chạy test phù hợp, build và thử trình duyệt. Khi thiếu thông tin không ngăn công việc độc lập, tiếp tục và đánh dấu giả định; chỉ hỏi vấn đề thực sự cần quyết định. Không dừng ở “tôi có thể làm”.

Mỗi lần bàn giao phải có: code chạy được, migration/contract khớp frontend, test phù hợp, hướng dẫn thao tác, cập nhật kiến trúc và README, kết quả kiểm tra có bằng chứng, phần còn chờ và bước tiếp theo cụ thể. Không tự xuất bản hoặc gửi dữ liệu ra ngoài khi chưa nằm trong phạm vi người dùng yêu cầu.

Báo cáo bằng tiếng Việt, nêu kết quả trước, giải thích vừa đủ. Liệt kê rõ test trên local, test PostgreSQL engine, test trình duyệt và test cloud thật; không lấy kết quả một loại để khẳng định loại khác. Giữ sản phẩm và tài liệu ở đúng thư mục project người dùng đã chỉ định.

---

Tài liệu đi kèm để người thực hiện bắt đầu: [README](../README.md), [kiến trúc](KIEN_TRUC_ERP_CHIDI.md), [database](DATABASE_CONTRACT.md), [Supabase](SUPABASE_SETUP.md), [kiểm tra](VERIFICATION.md).
