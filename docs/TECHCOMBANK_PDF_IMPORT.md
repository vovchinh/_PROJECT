# Nhập sao kê Techcombank PDF vào Thu Chi

**Trạng thái 12/10/2026:** luồng PDF mới đã được kiểm thử cục bộ; chưa xác nhận migration `021` và `022` trên Supabase thật. Với PDF mẫu 8 trang, ứng dụng nhận 83 giao dịch TKTT hợp lệ ở trang 1–6 và **bỏ qua hoàn toàn** 12 dòng thuộc bảng CCTG ở trang 7–8 theo quyết định của ChiDi. Không có dữ liệu CCTG nào được đưa vào giao dịch Thu Chi; chỉ lưu số dòng đã loại trừ để người dùng thấy phạm vi nhập.

## Chuẩn bị

1. Đăng nhập workspace bằng tài khoản **owner** hoặc **manager**. Quyền này bắt buộc cho việc chuyển PDF vào hàng chờ, phân loại và ghi sổ. Chỉ dùng dữ liệu của đúng workspace.
2. Trên môi trường Supabase thử nghiệm, xác nhận các migration đến `020` đã chạy đúng thứ tự, rồi áp dụng lần lượt [`021_pdf_bank_statement_guard.sql`](../supabase/migrations/021_pdf_bank_statement_guard.sql) và [`022_pdf_bank_account_cctg_exclusion.sql`](../supabase/migrations/022_pdf_bank_account_cctg_exclusion.sql) nếu chưa áp dụng. **Không chạy lại** migration đã có; không tự động chạy trên production.
3. Cập nhật ứng dụng sau khi cài dependency từ `package.json` và build/deploy bản mới. Chuẩn bị **Tài khoản tiền** đã xác nhận số dư đầu/ngày mở sổ và **Nhóm thu chi** phù hợp. Nhóm chuyển khoản nội bộ/COD/tiền góp vốn không phải chi phí vận hành hoặc doanh thu bán hàng.

## Thao tác

1. Vào **Thu Chi → Nhập sao kê → Techcombank PDF**, chọn file `.pdf` tối đa 5 MB. PDF được đọc **trên thiết bị**; file gốc, tên file, số tài khoản đầy đủ và văn bản ngoài bảng giao dịch không được tải lên Supabase.
2. Xem số dòng TKTT hợp lệ, số dòng CCTG đã loại trừ, tổng tiền thu/chi TKTT, vị trí **trang/dòng** và cảnh báo trùng. Bản xem trước hiện 100 dòng đầu; parser kiểm tra toàn bộ dòng TKTT trước khi cho tiếp tục.
3. Nếu có trang **khác** chưa nhận diện, dòng TKTT không khớp số dư, hoặc dữ liệu lỗi, hệ thống chặn nhập. Với bảng CCTG đúng bố cục đã kiểm chứng, hệ thống chỉ đếm và bỏ qua, không giải nghĩa số tiền hoặc đưa vào phiếu.
4. Đối chiếu bản gốc, xác nhận các giao dịch TKTT dùng **VND**, đánh dấu xác nhận bỏ qua CCTG, rồi chọn **Tài khoản Thu Chi** có sẵn trong workspace. Trường “Tên tài khoản” của PDF mẫu trùng tên chủ tài khoản, nên hệ thống **không dùng nó để tự chọn tài khoản ERP** và không lưu tên/số tài khoản từ PDF.
5. Nhấn **Tiếp tục phân loại**. Lúc này chỉ dữ liệu giao dịch TKTT tối thiểu và UUID tài khoản ERP đã chọn được lưu vào lô nhập; **chưa phát sinh tiền**. Vào **Lịch sử nhập sao kê → Xem và xử lý** để mở lại lô. Tài khoản đã chọn được điền sẵn cho từng dòng và có thể đổi trước khi ghi sổ.
6. Với từng dòng chờ, chọn **Nhóm thu chi**, kiểm tra tài khoản, chiều Thu/Chi, ngày, nội dung, số tiền, vị trí nguồn và cảnh báo trùng, rồi nhấn **Lưu phân loại**. Nếu một giao dịch có thể trùng nhưng thực sự khác, ghi lý do đối chiếu cụ thể. Không ghi lại dòng đã có phiếu hoặc chứng từ thanh toán tương ứng.
7. Chọn từng dòng hoặc toàn bộ dòng chờ **trên trang đang xem** rồi nhấn **Ghi sổ dòng đã chọn**. Đọc hộp tác động và xác nhận. Mỗi dòng dùng phiếu Thu Chi và cash ledger hiện có; retry cùng yêu cầu không tạo phát sinh trùng. Giao dịch đã ghi chỉ sửa bằng nghiệp vụ **Đảo/Điều chỉnh** theo quyền.
8. Trong **Lịch sử nhập sao kê**, mở lại lô để đối chiếu số dòng chờ/đã ghi, tài khoản và phiếu nguồn. Lô giữ hash SHA-256, trang/dòng nguồn, số CCTG bỏ qua và liên kết phiếu; **không lưu PDF gốc**. Lịch sử hỗ trợ cả Excel và PDF, phân trang theo 20 lần nhập.

## Cách hiểu tiền và lợi nhuận

Sao kê chứng minh **dòng tiền**, chưa chứng minh doanh thu hoặc chi phí. Tiền khách chuyển, COD, góp vốn, hoàn tiền, vay, mua hàng và lương có thể có cách hạch toán khác nhau. Chọn Nhóm thu chi theo chứng từ đã đối chiếu; đừng ép mọi tiền vào thành doanh thu hoặc mọi tiền ra thành chi phí. Ghi sổ PDF hiện tạo **phiếu Thu Chi mới**; nếu khoản đã có phiếu, không ghi lại.

## Khi bị chặn

| Thông báo/tình huống | Cách xử lý |
|---|---|
| Có bảng CCTG đã nhận diện | Xác nhận loại trừ bảng này trước khi tiếp tục. Các dòng CCTG không được nhập hoặc xử lý trong Thu Chi. |
| Trang lạ sau CCTG hoặc bố cục không đúng | Dừng nhập; lấy sao kê đúng định dạng và đối chiếu. Hệ thống không coi trang lạ là CCTG để bỏ qua. |
| PDF scan, bố cục lạ, ngày/tiền không chắc, số dư không khớp | Không ghi nhận. Lấy file Excel do ngân hàng xuất hoặc đối chiếu nguồn trước. Không gửi PDF tới OCR/cloud tự động. |
| Chưa xác nhận VND | Đối chiếu bản gốc; chỉ đánh dấu nếu đúng VND. Hệ thống Thu Chi hiện là VND. |
| Thiếu RPC `stage_pdf_bank_statement_verified` | Kiểm tra đã áp dụng `021` rồi `022` trên môi trường đang dùng, rồi tải lại ứng dụng. |
| Không thấy tài khoản/nhóm hoặc không ghi sổ được | Kiểm tra workspace, quyền, trạng thái hoạt động, ngày mở sổ tài khoản, chiều Thu/Chi của nhóm và lý do cảnh báo trùng. |
| Bấm lại sau lỗi mạng | Chọn lại lô đã lưu và xem trạng thái trước khi thao tác. Hệ thống có request ID và kiểm tra file trùng; không tạo lô/phát sinh tiền trùng khi retry đúng yêu cầu. |

## Giới hạn hiện tại

- Parser PDF hỗ trợ **bố cục TKTT và vùng CCTG đã kiểm chứng** trong mẫu, PDF có lớp chữ, tối đa 50 trang/5.000 dòng TKTT. Không nhận mọi mẫu Techcombank, không OCR, không tự nhận diện tiền tệ. CCTG chỉ được nhận diện để loại trừ, không được đọc thành giao dịch.
- Màn hình phân loại sau khi lưu chỉ sửa **tài khoản, nhóm, lý do trùng**. Ngày, chiều, số tiền, nội dung không được sửa ở đây; nếu sai, dừng, đối chiếu nguồn và dùng quy trình phù hợp. Chưa có thao tác **gắn phiếu đã tồn tại** hoặc **bỏ qua dòng** trong lô PDF; không ghi sổ dòng đã có phiếu.
- Test PGlite và parser cục bộ không thay thế kiểm thử Supabase thật. Chưa xác minh quyền/RLS và ghi sổ trên project cloud của ChiDi; cần smoke test ở workspace thử nghiệm trước khi sử dụng dữ liệu thật.

## Kiểm thử cho người phát triển

Các lệnh có trong dự án hoặc script kiểm thử hiện hữu:

```powershell
npm run test -- src/lib/techcombank-pdf.test.js src/features/bank-import-pdf-payload.test.js
node scripts/test-pdf-bank-statement-security.mjs
node scripts/test-pdf-bank-account-cctg-exclusion.mjs
npm run test:bank-statement
npm run check
```

Không đưa file sao kê thật vào Git hoặc fixture tự động. Các file `docs/SaoKeTK*` đã được Git bỏ qua; test mẫu riêng chỉ đọc cục bộ và không in nội dung giao dịch.
