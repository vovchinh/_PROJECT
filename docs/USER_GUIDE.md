# Hướng dẫn sử dụng V1

Mở **START_CHIDI.cmd**, sau đó vào `http://localhost:2000`. Nếu chưa điền Supabase, nhãn góc trên là **Chạy thử · lưu trên máy**. Đổi trình duyệt hoặc đổi từ `127.0.0.1` sang `localhost` sẽ dùng vùng dữ liệu thử khác.

## Thực hành lần đầu

Tại Tổng quan nhấn **Nạp dữ liệu minh họa**. Các SKU, phiếu nhập và thu chi này chỉ để tập thao tác. Mọi chứng từ đều chờ xác nhận, nên kho/dòng tiền đã ghi bằng 0 là đúng. Mở Danh mục để xem mã hàng, mở Nhập hàng/Thu chi để xem các phiếu.

## Nhập hàng

1. Trong Danh mục, thêm nhà cung cấp rồi thêm sản phẩm. Mã giữ cố định; tên và giá tham khảo được sửa theo quyền.
2. Chỉ bỏ cờ **SKU tạm** sau khi xác nhận mẫu, màu, size thực tế.
3. Trong Nhập hàng, chọn **Tạo phiếu nhập**, chọn SKU/NCC/kho, điền ngày, số lượng, đơn giá và phí có căn cứ.
4. Nếu ngày chưa chắc, bật **Ngày đang ước tính**. Nhấn **Lưu chờ xác nhận**.
5. So phiếu với chứng từ gốc. Nhấn **Ghi sổ**, đọc giá trị, xác nhận. Phiếu thiếu ngày thật/SKU thật/NCC/kho sẽ bị chặn.
6. Xem Kho hàng. Đây là tổng nhận và đảo đã ghi; chưa trừ bán hàng vì V1 chưa có xuất bán.

Một phiếu V1 có một SKU. Nếu cùng chuyến nhập nhiều SKU, tạo các dòng riêng và ghi chung số chứng từ/đợt vào ghi chú. Không gọi các phiếu này là công nợ đã xác nhận.

## Thu chi

Chủ shop mở Danh mục → Tài khoản tiền để đối chiếu số dư đầu và ngày mở sổ. Không biết thì giữ trạng thái chưa xác nhận. Khi đã có phát sinh ghi sổ, ứng dụng khóa ba trường này để tránh làm lệch toàn bộ lịch sử số dư.

Tạo thu chi với chiều Thu/Chi, nội dung, ngày thực tế, tài khoản, nhóm và số tiền. Tiền COD cũ chọn **COD cũ chờ đối soát**; tiền mua hàng chọn **Tiền mua hàng chờ gắn PO**. Không chọn doanh thu/chi phí để ép báo cáo khi chưa rõ nghiệp vụ. Các khoản thiếu tài khoản vẫn lưu nháp được, nhưng chưa ghi sổ được.

V1 chưa có phiếu chuyển khoản nội bộ hai vế tự động. Không tạo một vế rồi coi là đã hoàn tất chuyển tiền; đưa quy trình này vào phần kế toán/tiền tiếp theo để hai tài khoản được ghi cùng giao dịch.

## Sửa sai

Phiếu nháp: dùng nút bút chì để sửa. Phiếu đã ghi: chủ shop dùng **Đảo**, điền ngày và lý do ít nhất 10 ký tự, kiểm tra rồi xác nhận. Hệ thống giữ phiếu gốc và thêm chuyển động ngược. Sau đó lập phiếu mới đúng nếu nghiệp vụ cần. Không dùng đảo để che giấu thay đổi; nhật ký giữ căn cứ thao tác.

## Nhập JSON của shop

Trong **Đối chiếu dữ liệu**, chọn file riêng ở `data/`. Xem trước số dòng rồi nhấn nhập. File đã chuyển hiện tại chứa 17 nhập hàng/12 thu chi, kể cả dòng tháng 9 mới thêm. Tất cả vào hàng chờ. Nhập lại không sinh trùng; dòng nguồn đổi nội dung có mã cũ sẽ báo cần đối chiếu.

Muốn chuyển một bản Excel cập nhật, cài Python và `pip install -r requirements-export.txt`, sau đó chạy:

```powershell
python scripts/export_excel.py --source 'D:\ChiDi Manager\ChiDi_ERP\ChiDi_Online_Business_ERP.xlsx' --output 'data/chidi-import-lan-tiep-theo.json'
```

Máy bàn giao có Python riêng trong thư mục ERP cũ, có thể dùng đường dẫn `.tools/python/python.exe` ở đó thay `python`. Chọn tên output chưa tồn tại. Script đọc file nguồn, không ghi workbook; nếu loại dữ liệu chưa hỗ trợ, dừng để kiểm tra thay vì tự đoán.

## Đọc báo cáo

Bộ lọc **Kỳ báo cáo / Đến ngày** áp dụng các số liệu đã ghi của dashboard và báo cáo. Danh sách chứng từ hiển thị toàn bộ kỳ, có bộ lọc trạng thái và tìm kiếm riêng. Giá trị nháp ở dashboard luôn ghi rõ “toàn bộ kỳ”.

Số dư tài khoản bằng số dư đầu đã xác nhận cộng phát sinh tới ngày chọn. Trước ngày mở sổ hoặc chưa xác nhận thì chưa có số dư đáng dùng. Nhóm chi là phân tích dòng tiền; không phải P&L dồn tích. COD thu về không tự là doanh thu. CSV xuất theo màn hình, đã xử lý ký tự có thể thành công thức bảng tính.

## Nhật ký và bản sao

Nhật ký cho biết người/thời điểm/thao tác/chứng từ/lý do đảo hoặc thống kê import. Demo chỉ có một người giả lập owner. Chế độ cloud lưu user ID thật; chưa có tên nhân viên trong audit nếu chưa xây danh mục hồ sơ.

Thiết lập cho phép xuất JSON bản sao demo để lưu tham khảo và đặt lại demo bằng thao tác xác nhận. V1 chưa có nút phục hồi bản sao demo. Không dùng bản sao này thay backup PostgreSQL; xem [hướng dẫn Supabase](SUPABASE_SETUP.md).
