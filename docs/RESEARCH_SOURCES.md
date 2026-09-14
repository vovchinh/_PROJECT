# Nguồn nghiên cứu cho ChiDi Online ERP

Ngày kiểm tra: **10/09/2026**. Chỉ dùng nguồn chính thức của sản phẩm hoặc tổ chức ban hành. Các dòng “Áp dụng cho ChiDi” là nhận định thiết kế của dự án, không phải tuyên bố của nhà cung cấp. Giá và hạn mức cần kiểm tra lại trước khi triển khai thực tế.

| Chủ đề | Nguồn chính thức | Điều đã kiểm tra | Áp dụng cho ChiDi |
|---|---|---|---|
| React | [Build a React app from scratch](https://react.dev/learn/build-a-react-app-from-scratch) | Có hướng xây SPA bằng công cụ như Vite; routing và lấy dữ liệu cần được thiết kế thêm | ERP nội bộ dùng React JavaScript/JSX; tổ chức riêng giao diện, nghiệp vụ và truy cập dữ liệu |
| Vite | [Getting started](https://vite.dev/guide/) | Có mẫu React và quy trình phát triển/build | Dùng công cụ build gọn; giữ package lock và khai báo Node tương thích |
| React + Supabase | [React quickstart](https://supabase.com/docs/guides/getting-started/quickstarts/reactjs) | Có SDK JavaScript kết nối React với Supabase | Dùng SDK chính thức, không tự viết cơ chế đăng nhập |
| PostgreSQL | [License](https://www.postgresql.org/about/licence/) | Giấy phép PostgreSQL cho phép sử dụng, sửa đổi và phân phối theo điều khoản của giấy phép | Chọn nền dữ liệu quan hệ có thể chuyển sang nơi lưu trữ khác |
| Giá Supabase | [Pricing](https://supabase.com/pricing) | Free: 500 MB database, 1 GB Storage, tối đa 2 project hoạt động; pause sau 1 tuần không hoạt động; không bao gồm automatic backups | Phù hợp khởi đầu và thử nghiệm; cần kế hoạch dung lượng, sao lưu và ngân sách vận hành |
| Sao lưu | [Database backups](https://supabase.com/docs/guides/platform/backups) | Free được khuyến nghị tự xuất dữ liệu; backup database không chứa nội dung tệp Storage | Sao lưu cơ sở dữ liệu và tệp đính kèm riêng; phải thử khôi phục |
| Phân quyền | [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security) | RLS kiểm soát quyền theo dòng; view và khóa đặc quyền cần được xử lý cẩn thận | RLS theo workspace và vai trò; kiểm thử truy cập trái quyền qua API |
| Nghiệp vụ máy chủ | [Database functions](https://supabase.com/docs/guides/database/functions) | Hàm database có thể gọi từ xa; cần giới hạn quyền execute và search_path khi dùng security definer | RPC ghi sổ là nơi kiểm tra và cập nhật nhiều bảng trong cùng giao dịch |
| An toàn ứng dụng | [OWASP ASVS](https://owasp.org/www-project-application-security-verification-standard/) | Khung yêu cầu kiểm chứng an toàn ứng dụng | Chọn yêu cầu phù hợp cho xác thực, quyền, đầu vào, nhật ký và quản lý bí mật; không tự nhận chứng nhận |
| Tích hợp tin cậy | [AWS transactional outbox](https://docs.aws.amazon.com/en_en/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html) | Mẫu xử lý tính nhất quán giữa giao dịch database và việc gửi sự kiện | Dành cho giai đoạn tích hợp sàn/vận chuyển; sự kiện được ghi cùng giao dịch, gửi sau và chống trùng |
| ERP mã nguồn mở | [ERPNext pricing](https://frappe.io/erpnext/pricing) | Phần mềm mã nguồn mở; hosting và triển khai là khoản công việc/chi phí riêng | Tham khảo cách chia phân hệ; quyết định hiện tại vẫn là tự xây theo nghiệp vụ ChiDi |
| Bộ ứng dụng ERP | [Odoo editions](https://www.odoo.com/page/editions) | Trang chính thức phân biệt Community mã nguồn mở và Enterprise có giấy phép; truy cập trực tiếp có lúc timeout, xác nhận được bằng kết quả chỉ mục chính thức | Tham khảo cách phân chia ứng dụng; không suy diễn tính năng miễn phí của từng module |
| Bán hàng đa kênh | [Haravan Omnichannel](https://www.haravan.com/omnichannel) | Trang sản phẩm giới thiệu đơn hàng, kho, thanh toán, vận chuyển, khách hàng và nhiều kênh bán | Lấy hành trình đơn hàng và thu tiền làm luồng xuyên suốt |
| Quản lý đa kênh | [Sapo Omnichannel](https://www.sapo.vn/omnichannel.html) | Trang sản phẩm giới thiệu hợp nhất đơn, kho, khách hàng, báo cáo và quyền vận hành | Thiết kế một mã đơn nội bộ và bảng ánh xạ mã bên ngoài |
| Bán lẻ thời trang | [KiotViet thời trang](https://www.kiotviet.vn/phan-mem-ban-hang-thoi-trang) | Trang chính thức cung cấp giải pháp quản lý bán hàng/kho theo ngành bán lẻ; URL có thể dẫn đến trang giải pháp chung | Thiết kế SKU theo biến thể và thao tác kho dễ dùng; không sao chép giao diện |
| Kế toán trực tuyến | [MISA AMIS Kế toán](https://amis.misa.vn/ld/amis-ke-toan) | Trang sản phẩm giới thiệu kế toán, đối chiếu, báo cáo và kết nối dịch vụ | Phân biệt báo cáo quản trị nội bộ với hệ thống kế toán và hóa đơn phải được kiểm chứng riêng |

Các trang thương mại mô tả khả năng do nhà cung cấp công bố. Dự án chưa thực hiện thử nghiệm đối chiếu từng sản phẩm, chưa chấm điểm thị phần, và không dùng lời giới thiệu của nhà cung cấp làm bằng chứng cho độ chính xác của ERP ChiDi.

## Nguồn nội bộ

- Workbook đang vận hành: `D:\ChiDi Manager\ChiDi_ERP\ChiDi_Online_Business_ERP.xlsx`.
- Snapshot đọc ngày 10/09/2026: `D:\ChiDi Manager\ChiDi_ERP\ChiDi_Online_ERP_Project\docs\architecture\CURRENT_SOURCE_SNAPSHOT.json`; SHA-256 workbook trong snapshot: `b85f3d515d392c38ca0a451717cd8eb2dd35f47a2e0cb0219b6fbe1cbe6785a4`.
- Báo cáo kiểm tra và báo cáo tháng 8 trong thư mục ERP cũ; dữ liệu cũ và dữ liệu được nhập thêm sau bàn giao phải được phân biệt.
- Người dùng xác nhận khai trương 18/08/2026, hai đợt đầu trước tháng 8, cho phép chọn ngày nhập ước tính; các khoản chi thiếu tài khoản vẫn chờ đối chiếu.

Snapshot chỉ đọc ô dữ liệu đầu vào, không ghi lại workbook và không xác nhận thay cho chứng từ gốc. Số lượng kiểm thử của bản Excel trước đây không được dùng làm kết quả kiểm thử cho website mới.
