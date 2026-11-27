export const IMAGE_MAX_BYTES = 15 * 1024 * 1024;
export const IMAGE_MAX_PIXELS = 16_000_000;

export interface DecodedCanonicalImage {
  mimeType: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
  canvas: HTMLCanvasElement;
  exifOrientationApplied: number;
  byteSize: number;
}

export function detectImageSignature(bytes: Uint8Array): 'image/png' | 'image/jpeg' | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  return null;
}

/**
 * Decodes PNG/JPEG locally into a single canonical oriented HTMLCanvasElement.
 * Relies on `createImageBitmap(..., { imageOrientation: 'from-image' })` so EXIF orientation
 * is normalized exactly once, with Image fallback if needed.
 */
export async function decodeImageToCanonicalCanvas(file: File | Blob, rawBytes?: Uint8Array): Promise<DecodedCanonicalImage> {
  const bytes = rawBytes ?? new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > IMAGE_MAX_BYTES) {
    throw new Error(`Image exceeds ${(IMAGE_MAX_BYTES / (1024 * 1024)).toFixed(0)} MiB limit.`);
  }
  const mimeType = detectImageSignature(bytes);
  if (!mimeType) {
    throw new Error('Unsupported or malformed image signature. Only valid PNG and JPEG files are accepted.');
  }

  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: mimeType });
  let width: number;
  let height: number;
  const canvas = document.createElement('canvas');

  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    try {
      width = bitmap.width;
      height = bitmap.height;
      if (width <= 0 || height <= 0) throw new Error('Image has zero dimensions.');
      if (width * height > IMAGE_MAX_PIXELS) {
        throw new Error(`Decoded image (${width}x${height}) exceeds ${IMAGE_MAX_PIXELS.toLocaleString()} pixel limit.`);
      }
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('2D Canvas context unavailable.');
      ctx.drawImage(bitmap, 0, 0);
    } finally {
      bitmap.close();
    }
  } else {
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error('Failed to decode image.'));
        el.src = url;
      });
      width = img.naturalWidth;
      height = img.naturalHeight;
      if (width * height > IMAGE_MAX_PIXELS) {
        throw new Error(`Decoded image (${width}x${height}) exceeds ${IMAGE_MAX_PIXELS.toLocaleString()} pixel limit.`);
      }
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('2D Canvas context unavailable.');
      ctx.drawImage(img, 0, 0);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  return {
    mimeType,
    width,
    height,
    canvas,
    exifOrientationApplied: 1,
    byteSize: bytes.byteLength,
  };
}
