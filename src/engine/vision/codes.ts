import jsQR from 'jsqr';
import {
  BinaryBitmap,
  HybridBinarizer,
  MultiFormatReader,
  RGBLuminanceSource,
} from '@zxing/library';
import { clampRect, padRect, unionRects, type PixelRect, type VisionRegion } from './geometry.ts';

function maskRectInImageData(data: Uint8ClampedArray, width: number, height: number, rect: PixelRect) {
  const r = clampRect(rect, width, height);
  for (let y = r.y; y < r.y + r.height; y += 1) {
    for (let x = r.x; x < r.x + r.width; x += 1) {
      const idx = (y * width + x) * 4;
      data[idx] = 255;
      data[idx + 1] = 255;
      data[idx + 2] = 255;
      data[idx + 3] = 255;
    }
  }
}

export function detectVisualCodes(canvas: HTMLCanvasElement): VisionRegion[] {
  const width = canvas.width;
  const height = canvas.height;
  const ctx = canvas.getContext('2d');
  if (!ctx || width === 0 || height === 0) return [];

  const imgData = ctx.getImageData(0, 0, width, height);
  const working = new Uint8ClampedArray(imgData.data);
  const regions: VisionRegion[] = [];

  // 1. Bounded multi-pass jsQR detection
  for (let pass = 0; pass < 5; pass += 1) {
    const qr = jsQR(working, width, height, { inversionAttempts: 'attemptBoth' });
    if (!qr) break;

    const corners = [
      qr.location.topLeftCorner,
      qr.location.topRightCorner,
      qr.location.bottomRightCorner,
      qr.location.bottomLeftCorner,
    ];
    const xs = corners.map((c) => c.x);
    const ys = corners.map((c) => c.y);
    const rawRect: PixelRect = {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
    };
    const padded = padRect(rawRect, 8, 8, width, height);

    regions.push({
      id: `qr_${pass + 1}_${padded.x}_${padded.y}`,
      type: 'QR',
      label: `QR_${String(regions.length + 1).padStart(2, '0')}`,
      rect: padded,
      polygon: corners,
      method: 'vision_code',
      selected: true,
      effect: 'solid',
      blurRadius: 18,
      pixelBlockSize: 16,
      maskedPreview: `QR payload (${qr.data.length} chars; hidden by default)`,
      evidence: 'Detected QR code via jsQR quadrilateral locator.',
    });

    maskRectInImageData(working, width, height, padded);
  }

  // 2. ZXing MultiFormatReader fallback for 1D barcodes (Code 128, EAN-13, etc.) and any missed QR
  try {
    const luminance = new RGBLuminanceSource(working, width, height);
    const bitmap = new BinaryBitmap(new HybridBinarizer(luminance));
    const reader = new MultiFormatReader();
    const res = reader.decode(bitmap);
    if (res) {
      const pts = res.getResultPoints() || [];
      let rect: PixelRect;
      if (pts.length >= 2) {
        const ptRects = pts.map((p) => ({ x: p.getX(), y: p.getY(), width: 1, height: 1 }));
        const u = unionRects(ptRects);
        // 1D barcode result points often form a thin horizontal line across the barcode; expand vertically conservatively
        const expandY = Math.max(24, Math.round(u.width * 0.28));
        rect = padRect(u, 14, expandY, width, height);
      } else {
        rect = { x: 0, y: 0, width: Math.min(120, width), height: Math.min(80, height) };
      }
      const fmt = String(res.getBarcodeFormat());
      const isQr = fmt.includes('QR');
      regions.push({
        id: `zxing_${regions.length + 1}_${rect.x}_${rect.y}`,
        type: isQr ? 'QR' : 'BARCODE',
        label: `${isQr ? 'QR' : 'BARCODE'}_${String(regions.length + 1).padStart(2, '0')}`,
        rect,
        method: 'vision_code',
        selected: true,
        effect: 'solid',
        blurRadius: 18,
        pixelBlockSize: 16,
        maskedPreview: `Barcode format ${fmt} (${res.getText().length} chars; review box bounds)`,
        evidence: `Detected via ZXing (${fmt}); verify expanded bounding box covers full code bars.`,
      });
    }
  } catch {
    // No barcode decoded by ZXing on remaining pixels
  }

  return regions;
}
