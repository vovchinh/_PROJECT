# Management glossary

- **SKU:** one row in `products`; its UUID remains stable for all historical references.
- **Compatibility variant:** one-to-one row in `product_variants` mapped to a SKU; legacy attributes may remain `needs_review`.
- **Archive:** makes a master record unavailable for new use while retaining history.
- **Draft:** business document not yet posted to stock/cash ledgers.
- **Post:** commits a receipt/cash document and creates its authoritative movement.
- **Reverse:** posts a compensating movement, leaving the original document in the audit chain.
- **On hand / reserved / available:** physical lot balance / active holds / balance usable for a new reservation.
- **Management profit:** dated net sales less FIFO COGS and eligible operating expense; not a statutory financial statement.
- **Hồ sơ nhân viên:** bản ghi nhân sự trong một workspace, có thể không liên kết tài khoản đăng nhập; không phải `auth.users`.
- **Ca làm / chấm công xác nhận:** lịch dự kiến và sự kiện giờ thực tế; ca qua đêm dùng timestamp tuyệt đối. Thiếu giờ là nháp, không được tự biến thành vắng.
- **Kỳ lương:** khoảng ngày và chính sách ghi đè tùy chọn, đi qua DRAFT → CALCULATED → REVIEWED → APPROVED → PAID.
- **Phiếu lương snapshot:** mức hợp đồng, công, nghỉ có lương, các khoản bổ sung, ứng lương và số thực nhận đã được tính trên server; kỳ đã duyệt không lấy lại mức lương hiện tại.
- **Chi phí lương ghi nhận:** lương gộp ở `hr_payroll_expenses` khi duyệt; khác với dòng tiền thực trả trong `cash_movements`.
- **Ứng lương:** phiếu Thu Chi đã post cho một nhân viên và một kỳ lương cụ thể; khấu trừ khi tính kỳ đó, không cộng thêm chi phí lương.
- **Khoản lương bổ sung:** phụ cấp/thưởng/hoa hồng/khấu trừ đã xác nhận kèm lý do; hoa hồng phải có tham chiếu nguồn, không tự suy đoán từ đơn bán.
