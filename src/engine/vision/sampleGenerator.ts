import { BarcodeFormat, QRCodeWriter } from '@zxing/library';

/**
 * Generates a high-contrast synthetic support ticket + QR code PNG locally in Canvas.
 * Contains zero real user data; all identifiers are synthetic test vectors.
 */
export async function createSyntheticTicketPngBytes(): Promise<Uint8Array> {
  const width = 960;
  const height = 560;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D Canvas context unavailable');

  // Clean white document background for optimal OCR contrast
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, width, height);

  // Subtle header bar
  ctx.fillStyle = '#0F172A';
  ctx.fillRect(0, 0, width, 68);
  ctx.fillStyle = '#35D9AD';
  ctx.font = 'bold 24px Arial, sans-serif';
  ctx.fillText('SYNTHETIC SUPPORT TICKET #INC-4092', 32, 42);

  // Crisp black text fields
  ctx.fillStyle = '#0F172A';
  ctx.font = '20px Arial, sans-serif';
  const lines = [
    'Primary Email: priya.sharma@example.org',
    'Phone Number: +91 98765 43210',
    'Tax PAN: ABCDE1234F',
    'Synthetic Aadhaar: 2345 6789 0124',
    'Valid Card Vector: 4111 1111 1111 1111',
    'Invalid Card Vector: 4111 1111 1111 1112',
    'Client IPv4: 192.168.10.42',
    'Order Ref: ORD-2026-0419 (non-PII)',
  ];

  let y = 122;
  for (const line of lines) {
    ctx.fillText(line, 36, y);
    y += 48;
  }

  // Render real synthetic QR code on the right side using ZXing QRCodeWriter
  try {
    const writer = new QRCodeWriter();
    const matrix = writer.encode('SYNTHETIC-TICKET:INC-4092:USER-DEMO', BarcodeFormat.QR_CODE, 180, 180, new Map());
    const qrX = 720;
    const qrY = 120;
    const mw = matrix.getWidth();
    const mh = matrix.getHeight();
    const cell = Math.floor(180 / Math.max(mw, mh));
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(qrX - 10, qrY - 10, mw * cell + 20, mh * cell + 20);
    ctx.fillStyle = '#000000';
    for (let r = 0; r < mh; r += 1) {
      for (let c = 0; c < mw; c += 1) {
        if (matrix.get(c, r)) {
          ctx.fillRect(qrX + c * cell, qrY + r * cell, cell, cell);
        }
      }
    }
    ctx.fillStyle = '#475569';
    ctx.font = '14px Arial, sans-serif';
    ctx.fillText('Synthetic QR Badge', qrX + 20, qrY + mh * cell + 24);
  } catch {
    // Fallback if QR matrix fails
  }

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('Failed to encode synthetic sample PNG');
  return new Uint8Array(await blob.arrayBuffer());
}
