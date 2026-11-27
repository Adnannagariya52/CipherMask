import type { EntityType, RedactionMode } from '../types.ts';

export type VisualEffect = 'solid' | 'blur' | 'pixelate' | 'partial_text';

export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VisionRegion {
  id: string;
  type: EntityType;
  label: string;
  rect: PixelRect;
  polygon?: Array<{ x: number; y: number }>;
  method: 'ocr' | 'vision_face' | 'vision_segment' | 'vision_code' | 'manual';
  confidence?: number;
  selected: boolean;
  effect: VisualEffect;
  blurRadius: number;
  pixelBlockSize: number;
  /** Safe masked preview of matched text/code; raw value kept only in memory */
  maskedPreview?: string;
  replacementText?: string;
  redactionMode?: RedactionMode;
  validationStatus?: string;
  evidence?: string;
  /** Optional person segmentation binary mask in canonical coordinates */
  segmentationMask?: { width: number; height: number; mask: Uint8Array };
}

export function clampRect(rect: PixelRect, maxWidth: number, maxHeight: number): PixelRect {
  if (!Number.isFinite(rect.x) || !Number.isFinite(rect.y) || !Number.isFinite(rect.width) || !Number.isFinite(rect.height)) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const x0 = Math.max(0, Math.min(maxWidth, Math.floor(rect.x)));
  const y0 = Math.max(0, Math.min(maxHeight, Math.floor(rect.y)));
  const x1 = Math.max(x0, Math.min(maxWidth, Math.ceil(rect.x + rect.width)));
  const y1 = Math.max(y0, Math.min(maxHeight, Math.ceil(rect.y + rect.height)));
  return {
    x: x0,
    y: y0,
    width: Math.max(0, x1 - x0),
    height: Math.max(0, y1 - y0),
  };
}

export function padRect(rect: PixelRect, padX: number, padY: number, maxWidth: number, maxHeight: number): PixelRect {
  return clampRect(
    {
      x: rect.x - padX,
      y: rect.y - padY,
      width: rect.width + padX * 2,
      height: rect.height + padY * 2,
    },
    maxWidth,
    maxHeight,
  );
}

export function unionRects(rects: PixelRect[]): PixelRect {
  if (rects.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    if (r.x < minX) minX = r.x;
    if (r.y < minY) minY = r.y;
    if (r.x + r.width > maxX) maxX = r.x + r.width;
    if (r.y + r.height > maxY) maxY = r.y + r.height;
  }
  return {
    x: minX,
    y: minY,
    width: Math.max(0, maxX - minX),
    height: Math.max(0, maxY - minY),
  };
}

/**
 * Converts pointer client coordinates on a displayed element (accounting for CSS object-contain
 * letterboxing or explicit canvas rect) into canonical image pixel coordinates.
 */
export function clientToCanonicalPixel(
  clientX: number,
  clientY: number,
  elementRect: { left: number; top: number; width: number; height: number },
  imageWidth: number,
  imageHeight: number,
): { x: number; y: number } {
  if (elementRect.width <= 0 || elementRect.height <= 0 || imageWidth <= 0 || imageHeight <= 0) {
    return { x: 0, y: 0 };
  }
  const scale = Math.min(elementRect.width / imageWidth, elementRect.height / imageHeight);
  const renderedWidth = imageWidth * scale;
  const renderedHeight = imageHeight * scale;
  const offsetX = (elementRect.width - renderedWidth) / 2;
  const offsetY = (elementRect.height - renderedHeight) / 2;

  const relX = clientX - elementRect.left - offsetX;
  const relY = clientY - elementRect.top - offsetY;

  return {
    x: Math.max(0, Math.min(imageWidth, relX / scale)),
    y: Math.max(0, Math.min(imageHeight, relY / scale)),
  };
}

export function scaleRectFromInference(
  rect: PixelRect,
  scaleX: number,
  scaleY: number,
  canonicalWidth: number,
  canonicalHeight: number,
): PixelRect {
  return clampRect(
    {
      x: rect.x / scaleX,
      y: rect.y / scaleY,
      width: rect.width / scaleX,
      height: rect.height / scaleY,
    },
    canonicalWidth,
    canonicalHeight,
  );
}
