# Tạo Supabase và kết nối ChiDi — hướng dẫn từng bước

> Cập nhật 11/09/2026: bạn đã thực hiện bước 1–6; kết nối chỉ đọc đã đạt và app đã chuyển sang cloud tại **http://localhost:2000**. Bước tiếp theo xem [hướng dẫn V1.1](THIET_LAP_VAN_HANH_V11.md): chạy migration 002 bổ sung, rồi đăng nhập/tạo workspace. Không chạy lại 001 trong project hiện có.

Tài liệu này giữ đầy đủ quy trình cài lần đầu để dùng khi cần tạo môi trường mới. Với project của bạn, URL/key đã có và app dùng cloud; tiếp tục bằng hướng dẫn V1.1 ở trên. Chế độ chạy thử vẫn mở được từ màn hình đăng nhập, không cần sửa mã React.

Hướng dẫn kiểm tra ngày 10/09/2026. Tên/vị trí menu có thể thay đổi nhẹ. Các bước dưới đây dành cho **một Supabase project mới, chưa chứa ứng dụng khác**.

## 1. Phân biệt ba loại tài khoản/thông tin

| Thành phần | Ý nghĩa | Nơi dùng |
|---|---|---|
| Tài khoản Supabase Dashboard | Chủ sở hữu hạ tầng database | Website quản trị Supabase |
| Tài khoản đăng nhập ChiDi | Người sử dụng ERP | Màn hình đăng ký/đăng nhập của ChiDi, quản lý bởi Supabase Auth |
| Mật khẩu database | Mật khẩu quản trị PostgreSQL | Công cụ quản trị/backup; không nhập vào React |

Cùng một email có thể dùng cho hai tài khoản đầu, nhưng mật khẩu/phiên đăng nhập không tự dùng chung. Project URL là địa chỉ API database, không phải địa chỉ website ERP đã được xuất bản.

## 2. Tạo tài khoản và project

1. Mở [Supabase Dashboard](https://supabase.com/dashboard). Chọn đăng ký bằng email hoặc GitHub theo lựa chọn màn hình; hoàn tất xác nhận nếu được yêu cầu.
2. Tạo **Organization** cá nhân, tên gợi ý `ChiDi`. Organization là nơi quản lý project và gói dịch vụ, không phải workspace trong ERP.
3. Chọn **New project**. Chọn organization vừa tạo và gói **Free** nếu màn hình yêu cầu chọn gói.
4. Đặt tên project, ví dụ `chidi-erp-dev`. Dùng project thử nghiệm để nghiệm thu trước dữ liệu vận hành.
5. Tạo mật khẩu database mạnh, lưu trong trình quản lý mật khẩu. Không dán mật khẩu này vào `.env.local` của frontend. 
6. Chọn region gần Việt Nam, chẳng hạn Singapore nếu tài khoản đang cung cấp. Chờ project hoàn tất khởi tạo.
7. Ghi lại tên project để tránh chạy SQL nhầm project sau này.

Supabase có hướng dẫn khởi tạo project và kết nối React bằng SDK chính thức. [React quickstart](https://supabase.com/docs/guides/getting-started/quickstarts/reactjs).

## 3. Tạo các bảng và quy tắc nghiệp vụ

1. Trong project mới, mở **SQL Editor → New query**.
2. Mở file [001_core.sql](../supabase/migrations/001_core.sql) trong project ChiDi. Sao chép **toàn bộ** nội dung.
3. Dán vào SQL Editor, nhìn lại tên project rồi nhấn **Run**.
4. Khi thành công, Table Editor/schema `public` có các bảng như `workspaces`, `products`, `purchase_receipts`, `cash_transactions`, `stock_movements`, `cash_movements`.
5. Ban đầu chưa có sản phẩm/chứng từ. Chưa cần nhập tay các dòng trong Table Editor. Ứng dụng sẽ tạo workspace và danh mục nền khi bạn đăng nhập.

Migration được bọc trong giao dịch `begin/commit`. Chạy một lần. Nếu báo `relation already exists`, có thể migration đã chạy hoặc project có dữ liệu trước đó; không xóa bảng để cố chạy lại. Kiểm tra project, lưu nguyên lỗi và dùng migration bổ sung nếu đã vận hành.

File SQL cấp quyền đọc theo workspace và chỉ cho phép ghi qua hàm nghiệp vụ RPC. Không bật quyền đọc/ghi công khai để chữa lỗi giao diện. [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security).

## 4. Cấu hình đăng nhập và email

Trong **Authentication → URL Configuration**:

| Trường | Giá trị lúc chạy trên máy |
|---|---|
| Site URL | `http://localhost:2000` |
| Redirect URLs | Thêm `https://chidivibes.vn` và `https://chidivibes.vn/` nếu dùng tên miền này |
| Nếu cũng dùng localhost | Thêm `http://localhost:2000` và `http://localhost:2000/` |

URL xác nhận email và đặt lại mật khẩu phải khớp danh sách cho phép. Khi xuất bản website, thay Site URL bằng tên miền HTTPS thật và thêm chính xác URL đó. Không dùng wildcard rộng cho website thật. [Cấu hình redirect](https://supabase.com/docs/guides/auth/redirect-urls).

Trong phần nhà cung cấp đăng nhập, kiểm tra **Email** được bật; giữ xác nhận email. Lần thử đầu, dùng email của chính tài khoản quản trị organization.

**Email mặc định có giới hạn:** SMTP thử nghiệm của Supabase chỉ gửi tới địa chỉ thuộc team của project, hạn mức hiện công bố là 2 email/giờ. Để nhân viên/khách đăng ký bằng email khác, cấu hình **Custom SMTP** trong phần Authentication theo dịch vụ gửi mail của bạn. Không cấp quyền quản trị organization cho mọi nhân viên chỉ để nhận email. Việc mời nhân viên vào ERP và quyền quản trị Supabase là hai việc khác nhau. [Hướng dẫn SMTP chính thức](https://supabase.com/docs/guides/auth/auth-smtp).

## 5. Lấy Project URL và publishable key

1. Mở nút **Connect** của project. Chọn hướng dẫn React/JavaScript nếu có.
2. Sao chép **Project URL**, dạng `https://ma-project.supabase.co`.
3. Sao chép **Publishable key**, dạng `sb_publishable_...`. Có thể xem/tạo key tại **Settings → API Keys**.
4. Key này được dùng trong trình duyệt; quyền người dùng vẫn được kiểm tra bằng Auth + RLS. Không chọn `sb_secret_...`, `service_role`, JWT đăng nhập cá nhân hoặc mật khẩu PostgreSQL.

Ưu tiên publishable key mới. Legacy `anon` còn được SDK hỗ trợ để tương thích, nhưng không phải lựa chọn hướng dẫn chính cho project mới. [API keys](https://supabase.com/docs/guides/getting-started/api-keys).

## 6. Điền vào project ChiDi

Trong thư mục project, sao chép `.env.example` thành `.env.local` bằng Explorer/VS Code. Đừng đổi tên thành `.env.local.txt`.

```dotenv
VITE_SUPABASE_URL=https://ma-project-cua-ban.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_gia_tri_cua_ban
VITE_DEMO_MODE=false
```

Không thêm dấu ngoặc nhọn hoặc dấu chấm ba chấm vào giá trị thật. `.env.local` đã nằm trong `.gitignore`. Code có kiểm tra để chặn secret/service-role key bị đặt nhầm vào biến frontend, nhưng bạn vẫn cần chọn đúng key.


Nếu ứng dụng đang chạy: tại cửa sổ lệnh nhấn `Ctrl+C`, rồi mở lại **START_CHIDI.cmd**. Vite cần khởi động lại để nhận biến môi trường. Khi deploy một bản build, phải build lại với cấu hình cloud; không thể chỉ sửa `.env.local` sau khi đã upload `dist/`.

Muốn quay lại thử nghiệm trên máy, đặt `VITE_DEMO_MODE=true` và khởi động lại. Hai nơi lưu dữ liệu độc lập. Không có tự chuyển dữ liệu demo sang cloud.

## 7. Đăng ký và tạo workspace

1. Mở `http://localhost:2000`. Bạn sẽ thấy màn hình đăng nhập thay vì dashboard demo.
2. Chọn **Tạo tài khoản**, dùng email của bạn và mật khẩu mới cho ERP, tối thiểu 8 ký tự.
3. Mở email xác nhận trong cùng trình duyệt đang chạy ChiDi. Trở lại đăng nhập nếu cần.
4. Chọn **Tạo workspace ChiDi**. Người tạo có vai trò `owner`.
5. Hệ thống tạo kho chính và các tài khoản tiền nền; số dư/ngày mở sổ vẫn chưa được xác nhận.
6. Kiểm tra góc trên có **Supabase online**. Nếu báo lỗi database, xử lý lỗi thay vì tiếp tục dùng bản chạy thử để tưởng dữ liệu đã online.

V1.1 đã có bộ chọn workspace và màn hình cấp quyền cho thành viên đã đăng ký/xác nhận email, sau khi cài migration 002. Thành viên mới không tự thấy dữ liệu shop; owner vào **Thiết lập → Thành viên và quyền** để cấp quyền. Không tự gửi thư mời và không chia sẻ một tài khoản chủ shop cho cả nhóm. Xem [vận hành V1.1](THIET_LAP_VAN_HANH_V11.md).

## 8. Nhập dữ liệu Excel đã chuyển đổi

1. Mở **Đối chiếu dữ liệu → Chọn file dữ liệu ChiDi**.
2. Chọn `data/chidi-import-2026-09-11-validated.json` trong project.
3. Xem trước: 17 SKU, 17 dòng phiếu nhập và 12 thu chi; đối chiếu với snapshot đang bàn giao.
4. Nhấn **Nhập vào workspace hiện tại**. Việc này gửi dữ liệu đã chọn tới project cloud đang cấu hình.
5. Xem lịch sử nhập. Nhập lại cùng file không tạo thêm bản ghi. Nếu file Excel đổi và xuất lại, dòng có mã cũ thay đổi được báo xung đột, không tự ghi đè.
6. Xác nhận danh mục SKU, ngày thực tế, tài khoản và số dư đầu. Chỉ ghi sổ từng chứng từ đã có căn cứ. Những khoản bạn đã trả lời “chưa xác định” tiếp tục để nháp.

Tất cả chứng từ nhập từ Excel ở trạng thái chờ, kể cả nguồn đánh dấu “Có”. Việc cho phép chọn ngày random trong lịch cũ không biến ngày đó thành ngày đã kiểm chứng.

## 9. Kiểm tra cloud trước dùng làm dữ liệu chính

Thực hiện trên project thử nghiệm, dùng dữ liệu minh họa tự tạo:

- Đăng nhập, đăng xuất, xác nhận email và đặt lại mật khẩu hoạt động đúng URL.
- Tạo phiếu nháp: kho chưa tăng. Xác nhận SKU/ngày rồi ghi sổ: kho tăng đúng một lần. Nhấn lại/tải lại không tăng thêm.
- Thu chi thiếu số dư đầu không ghi được; thu chi đủ căn cứ làm thay đổi đúng tài khoản.
- Chủ shop đảo chứng từ: bản gốc giữ lại, phát sinh ngược chiều có lý do.
- Với tài khoản thứ hai và workspace khác, đọc REST/RPC không được xem hoặc sửa dữ liệu workspace thứ nhất. Vai trò nhân viên không ghi sổ được. Kiểm tra bằng API, không chỉ nhìn nút bị ẩn.
- So số lượng/tổng nhập giữa JSON và database; chứng từ chờ không lọt vào báo cáo đã ghi.
- Xuất backup và thử khôi phục sang project thử nghiệm khác; kiểm tra người dùng, membership, chứng từ và tổng sổ sau khôi phục.

Các kiểm tra SQL trên máy đã được tự động hóa. Các bước Auth, API thật, email, cloud concurrency và khôi phục trên tài khoản của bạn **chưa được thực hiện**, do bạn chọn bổ sung kết nối sau.

## 10. Hạn mức, sao lưu và vận hành

Free hiện có 500 MB database, 1 GB Storage, tối đa 2 project hoạt động; có thể pause sau một tuần không hoạt động và không gồm automatic backups. Đây là điểm khởi đầu phù hợp thử nghiệm; khi tăng dữ liệu/độ phụ thuộc cần đánh giá gói và ngân sách mới. [Supabase Pricing](https://supabase.com/pricing).

Thiết lập lịch xuất PostgreSQL bằng Supabase CLI hoặc `pg_dump`, lưu ngoài máy vận hành và ngoài cùng project. File CSV của một bảng hoặc bản sao demo không thay thế backup cloud. Database backup không chứa nội dung tệp Storage: nếu sau này dùng tệp đính kèm, sao lưu cả tệp và metadata. Bảo vệ bản sao như dữ liệu gốc và thử khôi phục định kỳ. [Database backups](https://supabase.com/docs/guides/platform/backups).

Khi chọn quy trình backup hằng ngày, mục tiêu mất dữ liệu tối đa về thiết kế có thể tới 24 giờ; chỉ coi đạt sau khi tự động chạy và thử khôi phục thành công. V1 không tự cung cấp backup scheduler hoặc cam kết thời gian phục hồi.

## 11. Xử lý lỗi thường gặp

| Hiện tượng | Kiểm tra |
|---|---|
| Vẫn vào demo | `VITE_DEMO_MODE=false`, đúng `.env.local`, khởi động lại server |
| URL/key không hợp lệ | Copy lại từ đúng project; không dùng Dashboard URL hoặc secret key |
| `relation does not exist` / RPC không tìm thấy | Migration đã chạy thành công trong cùng project chưa |
| `permission denied` khi ghi trực tiếp bảng | Đây là thiết kế; dùng thao tác trên ứng dụng/RPC, không nới quyền công khai |
| `Email address not authorized` | Dùng email quản trị team cho thử nghiệm hoặc cấu hình SMTP riêng |
| Không nhận email / `rate limit` | Kiểm tra spam, giới hạn gửi và cấu hình SMTP; tránh bấm liên tục |
| Xác nhận email về sai địa chỉ | Site URL và Redirect URLs phải khớp địa chỉ đang mở |
| Project bị pause | Mở Dashboard, resume project và chờ trạng thái sẵn sàng |
| Import báo dòng thay đổi | Mở nguồn để đối chiếu, giữ bản đã nhập; không đổi mã dòng để né cảnh báo |
| Không biết tài khoản/ngày | Giữ chứng từ nháp, chưa ghi sổ |
| Cổng 5173 đang dùng | Mở ứng dụng đang chạy hoặc dừng đúng server cũ bằng Ctrl+C |

Bạn không cần gửi mật khẩu database hoặc secret key để cấu hình frontend. Project URL và publishable key là hai giá trị cần điền; việc tạo tài khoản/xác nhận email do bạn thực hiện trong tài khoản của mình.
