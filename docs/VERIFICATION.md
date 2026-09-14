# Kết quả kiểm tra ChiDi ERP V1.1

Mốc cập nhật: **11/09/2026**, project React/JavaScript tại thư mục người dùng chỉ định. **97 kiểm tra tự động trong các bộ dưới đây đạt**, gồm quy tắc, SQL, trình duyệt, script Excel và build; không dùng số test của workbook cũ để đại diện cho website. Kết nối cloud thật mới kiểm tra chỉ đọc, chưa nghiệm thu bằng tài khoản đăng nhập.

| Nhóm kiểm tra | Kết quả | Bằng chứng có thể chạy lại |
|---|---|---|
| Quy tắc tiền/ngày, import, post/đảo, bảo toàn dữ liệu demo | 10/10 đạt | `npm test`, `src/lib/domain.test.js` |
| Migration, RLS, quyền, workspace FK, ledger, import | 25/25 đạt | `npm run test:db`, `scripts/test-database.mjs` |
| Hành trình trình duyệt Edge | 5/5 đạt | `npm run test:e2e`, `tests/e2e/workflows.spec.js` |
| Quyền nhóm và báo cáo PostgreSQL V1.1 | 41/41 đạt | `npm run test:operations` |
| UI cloud qua API mô phỏng, không gửi tới cloud thật | 6/6 đạt | `npm run test:cloud-ui` |
| Bảo toàn input Excel / dòng thiếu mã / công thức / ngày ước tính | 5/5 đạt | `python scripts/test-export.py` |
| Build demo/cloud, chặn secret/service-role và khôi phục build cấu hình thật | 5/5 đạt | `npm run test:builds` |
| Dependency audit | Không có lỗ hổng được npm audit báo ở lần kiểm tra | `npm audit` và lockfile |
| Chuyển đổi Excel đọc-only | Số dòng/tổng và SHA-256 khớp snapshot | `scripts/export_excel.py`, JSON riêng trong `data/` |

## Những hành vi đã kiểm chứng

- Ngày lịch không tồn tại, số tiền lẻ VND, số không an toàn và tổng vượt giới hạn bị chặn.
- Nháp chưa tạo ledger. Ngày ước tính, SKU tạm, tài khoản chưa xác nhận số dư đầu không được ghi sổ.
- Gửi lại thao tác post tạo đúng một phát sinh. Chứng từ đã ghi không sửa số lượng/giá trực tiếp.
- Đảo giữ gốc, thêm phát sinh ngược; số ròng kho/tiền/nhóm chi đúng và kỳ trước ngày đảo giữ số cũ.
- Authenticated không ghi trực tiếp ledger/draft qua REST SQL grants; staff không ghi sổ hoặc chỉnh số dư đầu; anonymous không gọi RPC; workspace khác không đọc/sửa/tham chiếu chéo.
- Import giữ cờ nguồn ở provenance và luôn tạo nháp; nhập lại không trùng, đổi hash file không nhân bản legacy ID, đổi giá trị cũ được báo xung đột.
- Giao diện tạo NCC/SKU/phiếu, thu chi, xác nhận số dư, post, đảo và import hoạt động qua thao tác thực; 9 mục điều hướng mở được; modal đóng bằng Escape; mobile không tràn chiều ngang trang.
- Source workbook không bị ghi lại; dữ liệu shop nằm ở `data/`, không nhập vào bundle frontend.

PGlite chạy PostgreSQL engine với `auth.users`/`auth.uid` và role được tạo cho test. Đây không phải Supabase online và không có nhiều kết nối cạnh tranh. E2E demo chạy cổng 5199; test UI cloud chạy cổng 5201 với toàn bộ Auth/REST/RPC bị chặn và trả fixture. Những test này đã kiểm đăng nhập mô phỏng, đổi workspace khi tải muộn, đăng xuất khi đang refresh, quyền viewer, báo lỗi thiếu 002, team form và số lớn. Không dùng chúng để khẳng định Auth/REST cloud thật đã nghiệm thu.

V1.1 còn kiểm owner cuối cùng, tự thu hồi quyền, email xác nhận/chính xác, audit, quyền chéo workspace, ngày mở sổ giữa kỳ, ngày đảo, hai biên ngày, trên 1.000 dòng và số lớn hơn giới hạn Number. Migration 002 có thể chạy lại mà giữ nguyên chứng từ/membership/ledger trong test.

Kiểm tra cloud thật chỉ đọc: URL/key publishable hợp lệ, app đã ở cloud mode; Auth phản hồi 200, email signup bật và cần xác nhận; ba bảng nền trả 42501 với anonymous. RPC báo cáo V1.1 hiện chưa được tìm thấy, nên migration 002 còn chờ chạy trong SQL Editor. Không ghi chứng từ, không tạo người dùng và không gửi email trong kiểm tra này.

## Snapshot dữ liệu thực

Nguồn `D:\ChiDi Manager\ChiDi_ERP\ChiDi_Online_Business_ERP.xlsx` có SHA-256:

```text
b85f3d515d392c38ca0a451717cd8eb2dd35f47a2e0cb0219b6fbe1cbe6785a4
```

JSON mới nhất `data/chidi-import-2026-09-11-validated.json`: 3 NCC, 17 SKU, 17 dòng nhập; 1.566 đơn vị, 79.043.000 đ tiền hàng; 12 thu chi. Chuyển lại bằng script đã bổ sung chặn công thức/dòng thiếu mã cho cùng số liệu và SHA-256 với snapshot 10/09. Chỉ cần chọn file mới nhất, không nhập nhiều bản cùng nguồn.

Đây là tổng dữ liệu nguồn, chưa xác nhận hàng đã nhận thật, còn tồn, đã thanh toán, công nợ hoặc chi phí kỳ. Giữ nháp cho tới khi đối chiếu. Dữ liệu tháng 9 không bị đưa ngược vào lịch ước tính tháng 8.

## Phần còn chờ trước dùng online làm dữ liệu chính

1. Project/URL/publishable key đã có; chủ project chạy thêm migration 002, không chạy lại 001.
2. Kiểm Auth email/redirect/reset, tạo workspace, gọi API/RPC bằng phiên thật.
3. Kiểm hai tài khoản, role và hai workspace trên cloud; thêm membership có kiểm soát nếu dùng nhóm.
4. Kiểm nhiều kết nối đồng thời, số liệu sau refresh và báo cáo; chuyển aggregate server khi cần nhất quán đa người.
5. Thiết lập backup thật và khôi phục thử; hoàn thiện số dư đầu, SKU, ngày và chứng từ nguồn.

Hiện chưa triển khai public hosting, chưa liên kết hãng vận chuyển, chưa có kế toán kép/khóa kỳ/bán-xuất-hoàn/FIFO bán. Các phần này được mô tả thành lộ trình và tiêu chí trong kiến trúc/prompt. Không tuyên bố V1.1 đã là toàn bộ ERP doanh nghiệp hoặc báo cáo kế toán được kiểm toán. Bundle cloud hiện khoảng 530 kB trước gzip; Vite có cảnh báo kích thước, build vẫn thành công. Tách tải theo phân hệ là bước tối ưu tiếp theo, không nới ngưỡng cảnh báo để che kết quả.

## Cách tự kiểm tra

Kiểm tra bàn giao bổ sung: 13 file bắt buộc và 53 liên kết tài liệu local hợp lệ; bundle không chứa hash/mã giao dịch nguồn hoặc cấu hình cloud placeholder. Trình duyệt mới mở được màn hình đăng nhập tại `http://localhost:2000`; trang HTML độc lập chuyển mục và sao chép prompt được, không có page error. Những bước này không thực hiện đăng nhập thật hoặc ghi dữ liệu cloud.

```powershell
npm run check
npm run test:e2e
node scripts/verify-builds.mjs
npm run test:cloud-ui
python scripts/test-export.py
npm run check:cloud
npm audit
```

Sau E2E, ảnh minh họa desktop/mobile nằm trong `test-results/screenshots/`. Chúng chỉ có dữ liệu giả dùng cho hướng dẫn. Các lần chạy có thể tạo lại thư mục test-results; tài liệu này giữ kết luận và phạm vi kiểm tra, không hứa thư mục tạm tồn tại mãi.

Để dựng lại trang tài liệu: cài `requirements-docs.txt`, chạy `python scripts/build_docs.py`. HTML/SVG hoạt động trực tiếp trên máy, không dùng CDN và không nhúng JSON dữ liệu shop.
