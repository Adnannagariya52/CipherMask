import { clampRect, type PixelRect, type VisionRegion } from './geometry.ts';

function applyCpuBoxBlur(imageData: ImageData, radius: number): ImageData {
  const { width, height, data } = imageData;
  const r = Math.max(2, Math.min(24, Math.round(radius / 2)));
  const out = new Uint8ClampedArray(data.length);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let sa = 0;
      let count = 0;

      const y0 = Math.max(0, y - r);
      const y1 = Math.min(height - 1, y + r);
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(width - 1, x + r);

      for (let yy = y0; yy <= y1; yy += 2) {
        for (let xx = x0; xx <= x1; xx += 2) {
          const idx = (yy * width + xx) * 4;
          sr += data[idx];
          sg += data[idx + 1];
          sb += data[idx + 2];
          sa += data[idx + 3];
          count += 1;
        }
      }

      const dst = (y * width + x) * 4;
      out[dst] = Math.round(sr / count);
      out[dst + 1] = Math.round(sg / count);
      out[dst + 2] = Math.round(sb / count);
      out[dst + 3] = Math.round(sa / count);
    }
  }
  return new ImageData(out, width, height);
}

function renderBlurRegion(
  destCtx: CanvasRenderingContext2D,
  sourceCanvas: HTMLCanvasElement,
  rect: PixelRect,
  radius: number,
) {
  const pad = Math.min(32, Math.max(8, Math.round(radius)));
  const sample = clampRect(
    {
      x: rect.x - pad,
      y: rect.y - pad,
      width: rect.width + pad * 2,
      height: rect.height + pad * 2,
    },
    sourceCanvas.width,
    sourceCanvas.height,
  );
  if (sample.width <= 0 || sample.height <= 0) return;

  const off = document.createElement('canvas');
  off.width = sample.width;
  off.height = sample.height;
  const offCtx = off.getContext('2d');
  if (!offCtx) return;

  const supportsFilter = typeof offCtx.filter === 'string';
  if (supportsFilter) {
    offCtx.filter = `blur(${Math.max(4, radius)}px)`;
    offCtx.drawImage(
      sourceCanvas,
      sample.x,
      sample.y,
      sample.width,
      sample.height,
      0,
      0,
      sample.width,
      sample.height,
    );
    offCtx.filter = 'none';
  } else {
    offCtx.drawImage(
      sourceCanvas,
      sample.x,
      sample.y,
      sample.width,
      sample.height,
      0,
      0,
      sample.width,
      sample.height,
    );
    const blurred = applyCpuBoxBlur(offCtx.getImageData(0, 0, sample.width, sample.height), radius);
    offCtx.putImageData(blurred, 0, 0);
  }

  destCtx.save();
  destCtx.beginPath();
  destCtx.rect(rect.x, rect.y, rect.width, rect.height);
  destCtx.clip();
  destCtx.drawImage(off, sample.x, sample.y);
  destCtx.restore();
}

function renderPixelateRegion(
  destCtx: CanvasRenderingContext2D,
  sourceCanvas: HTMLCanvasElement,
  rect: PixelRect,
  blockSize: number,
) {
  const step = Math.max(4, Math.min(64, Math.round(blockSize)));
  const smallW = Math.max(1, Math.floor(rect.width / step));
  const smallH = Math.max(1, Math.floor(rect.height / step));

  const small = document.createElement('canvas');
  small.width = smallW;
  small.height = smallH;
  const sCtx = small.getContext('2d');
  if (!sCtx) return;

  sCtx.drawImage(
    sourceCanvas,
    rect.x,
    rect.y,
    rect.width,
    rect.height,
    0,
    0,
    smallW,
    smallH,
  );

  destCtx.save();
  destCtx.beginPath();
  destCtx.rect(rect.x, rect.y, rect.width, rect.height);
  destCtx.clip();
  destCtx.imageSmoothingEnabled = false;
  destCtx.drawImage(small, 0, 0, smallW, smallH, rect.x, rect.y, rect.width, rect.height);
  destCtx.restore();
}

function renderSolidMask(
  destCtx: CanvasRenderingContext2D,
  rect: PixelRect,
  labelText?: string,
) {
  destCtx.save();
  destCtx.globalCompositeOperation = 'source-over';
  destCtx.globalAlpha = 1;
  destCtx.beginPath();
  destCtx.rect(rect.x, rect.y, rect.width, rect.height);
  destCtx.clip();

  // Solid opaque dark slate fill with crisp emerald accent border inside region
  destCtx.fillStyle = '#090D14';
  destCtx.fillRect(rect.x, rect.y, rect.width, rect.height);

  if (labelText && rect.width >= 60 && rect.height >= 16) {
    const fontSize = Math.max(10, Math.min(18, Math.floor(rect.height * 0.52)));
    destCtx.font = `600 ${fontSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    const measured = destCtx.measureText(labelText);
    if (measured.width <= rect.width - 8) {
      destCtx.fillStyle = '#35D9AD';
      destCtx.textAlign = 'center';
      destCtx.textBaseline = 'middle';
      destCtx.fillText(labelText, rect.x + rect.width / 2, rect.y + rect.height / 2);
    }
  }
  destCtx.restore();
}

function renderSegmentationRegion(
  destCtx: CanvasRenderingContext2D,
  region: VisionRegion,
) {
  const seg = region.segmentationMask;
  if (!seg) return;
  const imgData = destCtx.getImageData(0, 0, destCtx.canvas.width, destCtx.canvas.height);
  const px = imgData.data;
  const cw = destCtx.canvas.width;
  const ch = destCtx.canvas.height;

  for (let y = 0; y < ch; y += 1) {
    const sy = Math.min(seg.height - 1, Math.floor((y / ch) * seg.height));
    for (let x = 0; x < cw; x += 1) {
      const sx = Math.min(seg.width - 1, Math.floor((x / cw) * seg.width));
      if (seg.mask[sy * seg.width + sx] > 0) {
        const idx = (y * cw + x) * 4;
        px[idx] = 9;
        px[idx + 1] = 13;
        px[idx + 2] = 20;
        px[idx + 3] = 255;
      }
    }
  }
  destCtx.putImageData(imgData, 0, 0);
}

/**
 * Renders a flattened sanitized canvas from canonical immutable source pixels.
 * Critical ordering invariant: weaker effects (blur, pixelate) render BEFORE opaque solid/partial
 * masks so overlap cannot restore previously protected pixels.
 */
export function renderSanitizedCanvas(
  sourceCanvas: HTMLCanvasElement,
  regions: VisionRegion[],
  targetCanvas?: HTMLCanvasElement,
): HTMLCanvasElement {
  const out = targetCanvas ?? document.createElement('canvas');
  out.width = sourceCanvas.width;
  out.height = sourceCanvas.height;
  const ctx = out.getContext('2d');
  if (!ctx) throw new Error('Failed to acquire 2D canvas context.');

  // Draw canonical oriented source once
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.drawImage(sourceCanvas, 0, 0);

  const selected = regions.filter((r) => r.selected);

  // Pass 1: Semantic person segmentation if enabled
  for (const r of selected) {
    if (r.method === 'vision_segment' && r.segmentationMask) {
      renderSegmentationRegion(ctx, r);
    }
  }

  // Pass 2: Weak effects (blur / pixelate)
  for (const r of selected) {
    if (r.method === 'vision_segment') continue;
    const clamped = clampRect(r.rect, out.width, out.height);
    if (clamped.width <= 0 || clamped.height <= 0) continue;
    if (r.effect === 'blur') {
      renderBlurRegion(ctx, sourceCanvas, clamped, r.blurRadius);
    } else if (r.effect === 'pixelate') {
      renderPixelateRegion(ctx, sourceCanvas, clamped, r.pixelBlockSize);
    }
  }

  // Pass 3: Opaque masks (solid / partial_text) rendered LAST so they cannot be overwritten
  for (const r of selected) {
    if (r.method === 'vision_segment') continue;
    const clamped = clampRect(r.rect, out.width, out.height);
    if (clamped.width <= 0 || clamped.height <= 0) continue;
    if (r.effect === 'solid') {
      const lbl = r.type === 'QR' || r.type === 'BARCODE' ? '[CODE MASKED]' : '[REDACTED]';
      renderSolidMask(ctx, clamped, lbl);
    } else if (r.effect === 'partial_text') {
      const replacement = r.replacementText || '[REDACTED]';
      renderSolidMask(ctx, clamped, replacement);
    }
  }

  return out;
}

export async function exportCanvasToBytes(
  canvas: HTMLCanvasElement,
  mime: 'image/png' | 'image/jpeg',
  jpegQuality = 0.92,
): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((b) => resolve(b), mime, mime === 'image/jpeg' ? jpegQuality : undefined);
  });
  if (!blob) {
    throw new Error(`Canvas export failed: toBlob returned null for ${mime}.`);
  }
  const buf = await blob.arrayBuffer();
  return new Uint8Array(buf);
}

export interface VisionExportVerification {
  opaqueRegionsVerified: number;
  opaquePixelMismatch: boolean;
  dimensionsMatch: boolean;
  metadataStrippedVerified: boolean;
  selectedFaces: number;
  unselectedFaces: number;
}

export function verifyOpaqueRegionsInCanvas(
  renderedCanvas: HTMLCanvasElement,
  regions: VisionRegion[],
): { opaqueRegionsVerified: number; opaquePixelMismatch: boolean } {
  const ctx = renderedCanvas.getContext('2d');
  if (!ctx) return { opaqueRegionsVerified: 0, opaquePixelMismatch: true };

  let verified = 0;
  let mismatch = false;

  for (const r of regions) {
    if (!r.selected || r.effect !== 'solid' || r.method === 'vision_segment') continue;
    const c = clampRect(r.rect, renderedCanvas.width, renderedCanvas.height);
    if (c.width < 2 || c.height < 2) continue;

    // Sample corner pixel of the opaque mask to confirm alpha=255 and opaque mask color
    const px = ctx.getImageData(c.x, c.y, 1, 1).data;
    if (px[3] !== 255 || px[0] !== 9 || px[1] !== 13 || px[2] !== 20) {
      mismatch = true;
    } else {
      verified += 1;
    }
  }

  return { opaqueRegionsVerified: verified, opaquePixelMismatch: mismatch };
}
