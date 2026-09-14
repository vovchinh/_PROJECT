# Thiết lập và nghiệm thu ChiDi V2

Cập nhật: **12/09/2026**. Bạn đã xác nhận chạy migration 002, đăng ký, xác nhận email, đăng nhập và tạo workspace thành công. V2 bổ sung khách hàng, đơn nhiều dòng, giữ hàng, xuất FIFO, giao thành công và hàng hoàn. Hướng dẫn này tiếp tục trên project đang dùng; không yêu cầu tạo lại tài khoản hay workspace.

Trạng thái lúc soạn: đang triển khai/kiểm tra V2. Các bài thử bên dưới là tiêu chí cần đạt; chưa coi là đã đạt cho tới khi có kết quả chạy tương ứng.

## 1. Bổ sung database bằng migration 003

1. Mở **Supabase Dashboard**, chọn đúng project đã chạy `001_core.sql` và `002_operations.sql`.
2. Mở **SQL Editor → New query**.
3. Mở [003_sales_inventory.sql](../supabase/migrations/003_sales_inventory.sql), sao chép toàn bộ nội dung vào query mới.
4. Kiểm tra tên project rồi nhấn **Run** một lần. Lưu query với tên dễ nhận biết, ví dụ `ChiDi 003 sales inventory`.
5. Sau khi thành công, giữ nguyên các bảng và chứng từ V1/V1.1 để ứng dụng dùng tiếp.

**Chỉ chạy 003 cho lần nâng cấp này. Không chạy lại 001/002, không xóa bảng để chữa lỗi.** Nếu có lỗi, giữ thông báo và xác định nguyên nhân trước khi chạy lại. File migration bổ sung là nơi quản lý thay đổi schema; không tự dựng các bảng còn thiếu bằng tay rồi bỏ qua ràng buộc/quyền.

Publishable key trong frontend không có quyền nâng cấp schema. Vì vậy bước SQL này do chủ project thực hiện trong SQL Editor của mình. Không cần gửi mật khẩu database hoặc secret key để cấu hình ứng dụng.

## 2. Mở ứng dụng và đúng workspace

1. Nếu server cũ đang chạy, dừng đúng cửa sổ bằng **Ctrl+C** rồi mở [START_CHIDI.cmd](../START_CHIDI.cmd).
2. Vào **http://localhost:2000**, đăng nhập bằng tài khoản ChiDi đang có.
3. Chọn workspace cần làm việc. Kiểm tra nhãn **Supabase online** khi dùng dữ liệu cloud.
4. Mở các phần **Khách hàng / Bán hàng / Kho hàng**. Nếu báo cần migration 003, quay lại kiểm tra bước SQL trên đúng project.
5. Giao diện V1/V1.1 vẫn có thể dùng khi chưa cài V2; lỗi thiếu 003 phải được hiển thị rõ, không tự chuyển sang demo và không hiển thị dữ liệu rỗng như thể đã kiểm tra xong.

Demo và cloud là hai nơi lưu độc lập. Dữ liệu thử trong trình duyệt không tự đi lên workspace online. Ba màn hình V2 không có bộ lọc kỳ; số quản trị lũy kế theo chứng từ đã ghi. Bộ lọc kỳ thu chi V1.1 không biến bảng kho hiện hành V2 thành báo cáo tồn lịch sử.

## 3. Chuẩn bị hàng trước khi nhận đơn

Đọc [quy tắc V2](QUY_TAC_BAN_HANG_V2.md) trước khi ghi nghiệp vụ đầu tiên. Chuẩn bị SKU đã xác nhận, nhà cung cấp/kho đúng và phiếu nhập có ngày thực tế. Phiếu nhập ở nháp chưa tạo hàng để giữ hoặc xuất.

Nguồn Excel của shop có ngày ước tính, SKU tạm và thiếu lịch sử bán. Những dòng đó vẫn giữ chờ đối chiếu. Không xác nhận hàng cũ chỉ để vượt lỗi thiếu tồn khi thử hệ thống. Muốn đưa tồn thực tế lên hệ thống, cần đối chiếu kiểm kê và lịch sử liên quan trước.

Dùng SKU/khách hàng kiểm tra riêng trong môi trường thử khi chạy bài dưới đây. Không trộn phiếu thử với số liệu báo cáo chính. Mọi ngày trong bài phải đi theo trình tự và phù hợp với chuỗi nghiệp vụ của SKU/kho.

## 4. Bài thử cơ bản có số đối chiếu

Tạo SKU kiểm tra, một khách hàng kiểm tra và hai phiếu nhập: **5 sản phẩm × 80.000 đ**, sau đó **5 sản phẩm × 90.000 đ**. Không thêm phí/thuế/chiết khấu cho bài này. Ghi sổ hai phiếu khi dữ liệu đã đủ điều kiện.

1. Kiểm kho 10 sản phẩm, giá trị 850.000 đ.
2. Lập đơn nháp bán 7 sản phẩm, giá 120.000 đ. Nháp chưa giữ hàng.
3. Xác nhận đơn: trong kho 10, đang giữ 7, còn có thể nhận đơn 3.
4. Xuất toàn bộ đơn: trong kho 3, giá trị còn 270.000 đ; đang giao 7, giá vốn hàng đang giao 580.000 đ.
5. Xác nhận giao thành công: doanh thu quản trị 840.000 đ; giá vốn 580.000 đ; lãi gộp 260.000 đ. Sổ tiền chưa tự có khoản thu.
6. Sau khi đã nhận lại và kiểm hàng đủ điều kiện bán lại, ghi trả 2 sản phẩm: kho 5, giá trị 430.000 đ; doanh thu ròng 600.000 đ; giá vốn ròng 420.000 đ; lãi gộp 180.000 đ.
7. Tải lại trang, kiểm các số vẫn giữ đúng. Xem lịch sử đơn, lượng hoàn và dấu vết giá vốn gốc.

Giá vốn 580.000 đ bằng `5 × 80.000 + 2 × 90.000`. V2 quy ước trả từ phần phân bổ xuất gốc đầu tiên còn chưa trả, nên 2 sản phẩm hoàn phục hồi 160.000 đ. Quy ước này không khẳng định lô vật lý khi không có serial. Hàng hoàn thành lô mới ở ngày nhận hoàn.

Các số trên là kết quả mong đợi của **dữ liệu kiểm tra**, không phải chứng từ thật của ChiDi. Phiếu thu COD và phiếu hoàn tiền cần được đối chiếu riêng; thao tác giao/hoàn không tự tạo tiền.

## 5. Bài thử hủy và giao thất bại

Với một đơn nháp, hủy đơn không làm thay đổi kho. Với đơn đã xác nhận nhưng chưa xuất, hủy phải trả lại đúng lượng đang giữ; sau hủy có thể dùng lượng đó cho đơn khác.

Với một đơn đã xuất đang giao, chưa được dùng luồng hủy trước xuất. Chỉ ghi nhận hoàn giao thất bại khi đã nhận lại và kiểm đủ toàn bộ lượng cần hoàn. Hàng đủ điều kiện bán lại vào kho; doanh thu giao thành công của đơn này vẫn bằng không. Nếu kiện thiếu hoặc có hàng lỗi, không chọn nhận đủ để đóng đơn. Quy trình chênh lệch, nhiều kiện hoặc kho cách ly chưa được hỗ trợ đầy đủ trong V2.

V2 xuất toàn bộ một đơn trong một lần. Không tạo một xác nhận xuất đại diện cho một phần kiện rồi coi phần còn lại chưa xuất trong cùng luồng.

## 6. Nghiệm thu bằng hai tài khoản

Dùng tài khoản chủ shop và tài khoản nhân viên đã đăng ký/xác nhận email. Thêm membership bằng màn hình nhóm V1.1. Không dùng chung mật khẩu.

| Bài thử | Kết quả phải thấy |
|---|---|
| Nhân viên tạo khách/đơn nháp | Lưu được theo quyền staff |
| Nhân viên thử xác nhận/xuất/giao/hoàn | Bị máy chủ từ chối; kiểm cả API/RPC, không chỉ nút giao diện |
| Chủ shop hoặc quản lý xử lý đơn | Chỉ chuyển trạng thái hợp lệ và đủ hàng |
| Tài khoản ở workspace khác truy cập đơn | Không đọc/sửa được dữ liệu hoặc tham chiếu SKU/khách/kho chéo workspace |
| Hai phiên tranh 3 sản phẩm còn có thể giữ, mỗi đơn xin 2 | Chỉ một đơn xác nhận được; không có tổng giữ 4 trên nguồn 3 |
| Hai phiên cùng gửi xuất một đơn | Một lần xuất duy nhất; không nhân đôi phân bổ hoặc phát sinh kho |
| Gửi lại request cũ, đổi nội dung | Bị từ chối thay vì ghi nghiệp vụ khác dưới mã cũ |

Kiểm thử SQL cục bộ chưa thay cho hai phiên Supabase thật cạnh tranh. Sau thay đổi role hoặc workspace, tải lại và thử thao tác để bảo đảm phiên cũ không giữ quyền trên máy chủ.

## 7. Kiểm tra các tình huống dễ làm lệch số

- Phiếu nhập chưa ghi, SKU tạm hoặc ngày ước tính không tạo nguồn có thể bán.
- Đơn nhiều dòng thiếu một dòng hàng: toàn bộ xác nhận bị từ chối, không để một nửa đơn giữ được hàng.
- Không bán hàng của lô có ngày sau ngày nghiệp vụ.
- Không ghi hành động bán hoặc ghi sổ nhập mới với ngày sau hôm nay theo giờ Việt Nam. Nếu có cảnh báo phiếu nhập tương lai đã ghi từ V1, đối chiếu nguồn đó; V2 không tự sửa chứng từ cũ.
- Không chèn ngày lùi trước sự kiện đã ghi của cùng SKU/kho để làm đổi FIFO.
- Không đảo phiếu nhập khi lô đang được giữ hoặc đã được dùng xuất hàng.
- Không trả quá lượng đã giao, không nhận lại cùng lượng hai lần.
- Hàng hoàn chưa nhận hoặc không đủ điều kiện bán lại không tăng kho sẵn bán.
- Lô có phí lẻ: 3 sản phẩm tổng 240.001 đ; xuất 2 có giá vốn 160.000 đ, phần còn 80.001 đ; xuất hết/hoàn không làm mất đồng lẻ.
- Báo cáo giao thành công, hàng đang đi và thu tiền COD được đọc riêng.

## 8. Trạng thái kiểm tra V2

| Phần | Trạng thái lúc soạn |
|---|---|
| Nâng cấp 002, đăng ký, xác nhận email, đăng nhập, workspace | Người dùng xác nhận đã hoàn tất trước V2 |
| Migration 003/RLS/RPC trên máy | Chờ kết quả V2 |
| Nghiệp vụ FIFO, giữ hàng, giao và trả | Chờ kết quả V2 |
| Giao diện desktop/mobile, form nhiều dòng | Chờ kết quả V2 |
| Cài 003 trên Supabase thật | Chủ project cần chạy một lần |
| Hai tài khoản/hai workspace V2 trên cloud | Chờ nghiệm thu |
| Cạnh tranh nhiều kết nối cloud | Chờ nghiệm thu |
| Đối chiếu tồn thật và backup/khôi phục | Chờ nghiệm thu vận hành |

Ghi lại kết quả, mã chứng từ kiểm tra và thời điểm; không lưu mật khẩu, token hoặc Authorization header trong báo cáo. Các kiểm thử tự động cần chạy theo phiên bản code V2 hiện hành; xem [VERIFICATION.md](VERIFICATION.md) khi kết quả được cập nhật.

## 9. Sau bài thử

Khi kết quả khớp, hoàn thiện danh mục thật, dữ liệu đầu kỳ và hàng chờ đối chiếu trước khi vận hành thường xuyên. Chỉ người có quyền mới xác nhận, xuất, giao hoặc nhận hoàn. Cuối ngày đối chiếu hàng đang giao, hàng trong kho, đơn chờ xử lý và dòng tiền bằng chứng từ.

Báo cáo V2 là quản trị hàng bán và lãi gộp trong phạm vi đã xây. Chưa có sổ cái kép, đối soát COD tự động, thuế hoặc lợi nhuận sau toàn bộ chi phí. Tiếp tục phát triển theo các phân hệ trong kiến trúc sau khi phần bán hàng/kho này đã được kiểm chứng.
