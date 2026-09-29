import { useState } from 'react';
import { Eye, Printer } from 'lucide-react';
import { Panel, ErrorMessage } from '../components.jsx';
import { prepareBrowserPrint, renderReceiptHtml, sendToLanBridge } from '../lib/print-bridge.js';

// Explicitly synthetic paper for setup. This component has no repository/RPC access.
export default function LivePrinterPreview({ mode, bridgeUrl, bridgeToken, canPrint }) {
  const [visible, setVisible] = useState(false),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(''),
    [error, setError] = useState('');
  const [sample] = useState(() => ({
    ticket_no: 'IN-THU',
    customer_no: 'THỬ',
    customer_name: 'IN THỬ — KHÔNG PHẢI PHIẾU BÁN',
    campaign_name: 'Kiểm tra chữ Việt và khổ giấy',
    session_code: 'CHIDI-80MM',
    committed_at: new Date().toISOString(),
    lines: [
      {
        product_id: 'printer-test',
        sku: 'THU-80MM',
        name: 'Áo thử màu vàng · Nguyễn Thị Diệu',
        color: 'Vàng',
        size: 'M',
        qty: 1,
        unit_price: '0',
        line_total: '0',
      },
    ],
    total_amount: '0',
  }));
  async function testPrint() {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    let popup;
    try {
      if (mode === 'queue') throw new Error('Chọn USB hoặc LAN trên máy tính tại quầy để in thử.');
      if (mode === 'browser') {
        popup = prepareBrowserPrint({ paperWidth: 80 });
        await popup.print(sample);
        setNotice('Đã mở hộp thoại in thử. Kiểm tra giấy, dấu tiếng Việt và lề trên máy ZYWELL.');
      } else {
        const result = await sendToLanBridge({
          baseUrl: bridgeUrl,
          token: bridgeToken,
          attemptId: `test_${crypto.randomUUID()}`,
          snapshot: sample,
        });
        setNotice(
          result.status === 'sent'
            ? 'Cầu nối đã gửi phiếu thử. Hãy nhìn giấy để xác nhận kết quả.'
            : result.status === 'dry_run'
              ? 'Cầu nối đang dry-run: đã kiểm tra mẫu, chưa gửi tới máy in.'
              : 'Chưa xác định kết quả in thử; kiểm tra giấy trước khi thử lại.',
        );
      }
    } catch (failure) {
      popup?.close();
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel
      title="Mẫu phiếu trong phiên LIVE"
      note="Phiếu 80 mm có STT khách, SKU, màu/cỡ, số lượng và giá. Mẫu thử bên dưới không tạo phiếu bán hoặc giữ hàng."
    >
      <div className="live-printer-preview">
        <div className="foundation-actions">
          <button
            className="button secondary"
            aria-expanded={visible}
            onClick={() => setVisible(!visible)}
          >
            <Eye size={17} />
            {visible ? 'Thu gọn mẫu phiếu' : 'Xem mẫu phiếu'}
          </button>
          {canPrint && (
            <button
              className="button primary"
              disabled={busy || mode === 'queue'}
              onClick={testPrint}
            >
              <Printer size={17} />
              {busy ? 'Đang in thử…' : 'In thử 80 mm'}
            </button>
          )}
        </div>
        <ErrorMessage error={error} />
        {notice && (
          <p className="sales-note" role="status">
            {notice}
          </p>
        )}
        {visible && (
          <iframe title="Mẫu phiếu Live 80 mm" sandbox="" srcDoc={renderReceiptHtml(sample)} />
        )}
      </div>
    </Panel>
  );
}
