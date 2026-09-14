# ChiDi Online ERP V1.1 · React JavaScript + Supabase

**Supabase đã được cấu hình; ứng dụng hiện dùng chế độ online.** Bản V1.1 thêm chọn workspace, quản lý thành viên và báo cáo PostgreSQL vào nền danh mục, nhập hàng, thu chi, đối chiếu và nhật ký. Kết nối chỉ đọc tới project thật đã kiểm tra; bạn cần chạy migration bổ sung và hoàn tất đăng nhập để nghiệm thu luồng cloud. Đơn hàng, COD tự động, sổ cái kép và lợi nhuận đầy đủ còn trong lộ trình.

Xem trước [các bước đã làm và việc tiếp theo](TASKS.md), [hướng dẫn nâng cấp V1.1](docs/THIET_LAP_VAN_HANH_V11.md) và [nhật ký thay đổi](docs/CHANGELOG.md).

## Mở ứng dụng

1. Nhấp đúp [START_CHIDI.cmd](START_CHIDI.cmd).
2. Giữ cửa sổ lệnh đang chạy. Mở **http://localhost:2000** trong Edge/Chrome.
3. Đăng ký/xác nhận email và đăng nhập; tạo hoặc chọn workspace. Tài khoản đăng nhập ERP tách khỏi tài khoản Supabase Dashboard.
4. Chạy [002_operations.sql](supabase/migrations/002_operations.sql) theo hướng dẫn nâng cấp, rồi vào Đối chiếu dữ liệu để chọn JSON riêng của shop. Không chạy lại migration 001 đã có.
5. Muốn thực hành demo, nhấn **Mở bản chạy thử trên máy này** ở màn hình đăng nhập. Dữ liệu này tách riêng cloud.

Máy hiện tại đã có Node LTS riêng tại `.tools/`; không cần cài lại Node toàn máy. Sang máy khác: cài Node 24 LTS rồi chạy `npm ci`, `npm run dev`. Nếu cổng 2000 đang được ứng dụng này sử dụng, mở địa chỉ đang chạy, không khởi động thêm một bản.

## Tài liệu nên đọc

| Tài liệu | Dùng khi |
|---|---|
| [Cổng tài liệu HTML](docs/index.html) | Xem kiến trúc, sơ đồ và hướng dẫn dễ đọc trên trình duyệt |
| [Tạo tài khoản / project Supabase](docs/SUPABASE_SETUP.md) | Chuyển từ chạy thử sang dữ liệu online |
| [Kiến trúc và phân tích nghiệp vụ](docs/KIEN_TRUC_ERP_CHIDI.md) | Hiểu thiết kế, thị trường, dữ liệu cũ và lộ trình ERP đầy đủ |
| [Prompt triển khai hoàn chỉnh](docs/PROMPT_XAY_DUNG_ERP_CHIDI.md) | Giao việc tiếp cho lập trình viên hoặc coding agent |
| [Hợp đồng database](docs/DATABASE_CONTRACT.md) | Xem bảng, RPC, quyền và quy tắc ghi sổ |
| [Hướng dẫn thao tác](docs/USER_GUIDE.md) | Nhập hàng, thu chi, ghi sổ, đảo, nhập dữ liệu |
| [Kết quả kiểm tra](docs/VERIFICATION.md) | Phân biệt đã kiểm tra trên máy và phần chờ cloud |
| [Nguồn nghiên cứu](docs/RESEARCH_SOURCES.md) | Đối chiếu tài liệu chính thức |

## Dữ liệu riêng của shop

File chuyển đổi mới nhất: `data/chidi-import-2026-09-11-validated.json`. Có **17 dòng nhập hàng, 1.566 sản phẩm, 79.043.000 đ tiền hàng; 12 dòng thu chi**. SHA-256 nguồn vẫn khớp bản 10/09. Đây là số liệu đầu vào cần đối chiếu, không phải tồn kho hay chi phí đã được xác minh. Có dữ liệu tháng 9 trong workbook, nên không gán toàn bộ vào tháng 8.

Thư mục `data/` và các bản sao chạy thử không được đưa lên Git hoặc hosting. Ứng dụng không tự tải dữ liệu này lên Supabase. Chỉ khi chủ shop chọn file và nhấn nhập, dữ liệu mới được ghi vào workspace đang mở; mọi dòng vẫn là bản nháp. Ngày ước tính, SKU tạm, tài khoản chưa rõ tiếp tục chờ xác nhận. File Excel gốc không bị ghi lại.

## Cấu trúc

```text
src/                 React, form, trang nghiệp vụ, repository và quy tắc
supabase/migrations/ Schema PostgreSQL, RLS, RPC giao dịch
scripts/             Khởi động, xuất Excel, kiểm tra database, dựng tài liệu
tests/e2e/           Kịch bản thao tác thật bằng Playwright
docs/                Kiến trúc, hướng dẫn, prompt, nguồn và kết quả kiểm tra
data/                JSON riêng của shop, gitignored
.env.example         Mẫu cấu hình; sao chép thành .env.local khi sẵn sàng
```

## Lệnh cho lập trình viên

```powershell
npm ci
npm run dev
npm run check
npm run test:e2e
npm run test:cloud-ui
npm run test:builds
npm run check:cloud
npm run build
npm run preview
```

`check` chạy kiểm thử JavaScript, migration/quyền PostgreSQL V1 + V1.1 bằng PGlite và build. E2E demo ở cổng 5199; cloud UI dùng API giả lập hoàn toàn ở cổng 5201, tách khỏi Supabase thật. `check:cloud` chỉ đọc kiểm tra cấu hình và dịch vụ, không ghi dữ liệu. E2E dùng Edge nếu có; máy khác chạy `npx playwright install chromium` trước. Các kiểm thử này chưa thay thế nghiệm thu Auth/REST với tài khoản thật, thử nhiều kết nối hoặc khôi phục backup.

Chế độ demo lưu trong localStorage của đúng trình duyệt và địa chỉ đang dùng. Không đồng bộ đa máy, không có bảo mật phân vai thật và chưa có chức năng nhập lại bản sao demo. Hãy dùng demo cho thực hành; dùng cloud sau khi hoàn tất kiểm tra trong hướng dẫn.
