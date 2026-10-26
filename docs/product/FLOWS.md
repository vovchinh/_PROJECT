# Management flows implemented locally

**Catalog:** Danh mục → Nhóm sản phẩm or Sản phẩm / SKU → thêm/sửa. Product rows offer duplicate, archive/restore and a checked-delete dialog. The server returns usage/reason data and rejects deletion when business history exists. Archive keeps old references; a new purchase cannot use an archived SKU.

**Purchase:** Nhập hàng → create/edit draft → post to stock/FIFO → owner may reverse with date/reason if original lot is intact and no hold blocks it. A linked replacement draft flow is planned as E4.

**Cash:** Thu chi → create/edit draft → owner/manager post to cash movements → owner may reverse with date/reason. Dedicated expense-category editing is planned as E3; dated management profit is E7.

The UI is a client of server rules; local demo is separate browser storage and does not attest to cloud migration application.

**Nhân sự:** Nhân sự & Tiền lương → Phòng ban & chức vụ → Nhân viên. Owner/manager tạo hồ sơ không kèm Auth user, sửa master data hoặc lưu trữ; danh sách nhân viên có tìm/lọc/sắp xếp/phân trang trên server. Ca làm có thể qua đêm; chấm công thiếu giờ vẫn là nháp và phải xác nhận trước kỳ lương. Đơn nghỉ đi nháp → chờ duyệt → duyệt/từ chối/hủy; duyệt nghỉ không tự trừ lương.

**Tiền lương:** Nhập hợp đồng tháng/giờ và định mức, hệ số tăng ca theo hợp đồng/kỳ → lập kỳ → ghi các khoản lương đã xác nhận và ứng lương gắn kỳ → tính trên server → kiểm tra → duyệt (ghi nhận chi phí lương gộp) → ghi sổ trả lương bằng Thu Chi hiện hữu. Khoản bổ sung sai trước duyệt được sửa/hủy có lý do rồi tính lại. Phiếu đã duyệt giữ snapshot và không cho sửa trực tiếp. Nút trả lương xác nhận sổ nội bộ, không gửi chuyển khoản ngân hàng.
