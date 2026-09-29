import { normalizePrintOptions, renderReceiptHtml } from '../../src/lib/print-bridge.js';

export function pixelsToEscPos({ width, height, data }, { autoCut = true } = {}) {
  if (typeof autoCut !== 'boolean') throw new Error('PRINTER_CUT_OPTION');
  if (
    !Number.isInteger(width) ||
    width < 1 ||
    width > 576 ||
    !Number.isInteger(height) ||
    height < 1 ||
    height > 4096 ||
    data.length !== width * height * 4
  )
    throw new Error('PRINTER_RASTER_BOUNDS');
  const rowBytes = Math.ceil(width / 8);
  const raster = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const alpha = data[i + 3] / 255;
      const luminance =
        alpha * (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) + (1 - alpha) * 255;
      if (luminance < 160) raster[y * rowBytes + (x >> 3)] |= 1 << (7 - (x % 8));
    }
  }
  return Buffer.concat([
    Buffer.from([
      27,
      64,
      27,
      97,
      0,
      29,
      118,
      48,
      0,
      rowBytes & 255,
      rowBytes >> 8,
      height & 255,
      height >> 8,
    ]),
    raster,
    Buffer.from(autoCut ? [10, 10, 10, 29, 86, 0] : [10, 10, 10]),
  ]);
}

export async function renderReceiptRaster(snapshot, paperWidth = 80, options = {}) {
  const remaining = () => {
    const value = (options.deadlineAt || Date.now() + 15000) - Date.now();
    if (options.signal?.aborted || value <= 0) throw new Error('PRINTER_DEADLINE');
    return value;
  };
  remaining();
  const printOptions = normalizePrintOptions(options.printOptions);
  const html = renderReceiptHtml(snapshot, { paperWidth, printOptions });
  const { chromium } = await import('playwright');
  const { PNG } = await import('pngjs');
  let browser;
  const abort = () => {
    void browser?.close().catch(() => {});
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    browser = await chromium.launch({
      headless: true,
      timeout: remaining(),
      ...(options.executablePath
        ? { executablePath: options.executablePath }
        : process.platform === 'win32'
          ? { channel: 'msedge' }
          : {}),
    });
    remaining();
    const page = await browser.newPage({
      viewport: { width: 640, height: 800 },
      deviceScaleFactor: 2,
    });
    page.setDefaultTimeout(remaining());
    // The receipt contains no network URLs; deny requests as a second boundary.
    await page.route('**/*', (route) => route.abort());
    await page.setContent(html, { waitUntil: 'load', timeout: remaining() });
    await page.evaluate(
      (pixels) => {
        document.body.style.width = `${pixels / 2}px`;
      },
      paperWidth === 80 ? 576 : 384,
    );
    await page.evaluate(() => document.fonts.ready);
    const box = await page.locator('body').boundingBox();
    if (!box || box.height * 2 > 4096) throw new Error('PRINTER_RECEIPT_TOO_LONG');
    const png = PNG.sync.read(await page.locator('body').screenshot({ animations: 'disabled' }));
    remaining();
    return pixelsToEscPos(png, { autoCut: printOptions.auto_cut });
  } finally {
    options.signal?.removeEventListener('abort', abort);
    await browser?.close().catch(() => {});
  }
}
