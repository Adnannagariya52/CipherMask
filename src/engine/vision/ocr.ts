import { createWorker, type Worker as TesseractWorker } from 'tesseract.js';
import type { RedactionPolicy } from '../types.ts';
import { runDetectionPipeline } from '../pipeline.ts';
import { clampRect, padRect, unionRects, type PixelRect, type VisionRegion } from './geometry.ts';

export interface OcrWordBox {
  text: string;
  confidence: number;
  bbox: PixelRect;
  lineIndex: number;
  startOffset: number;
  endOffset: number;
}

export interface OcrScanResult {
  fullText: string;
  words: OcrWordBox[];
  regions: VisionRegion[];
  rejectedCount: number;
  durationMs: number;
}

let sharedOcrWorker: TesseractWorker | null = null;

export async function terminateOcrWorker(): Promise<void> {
  if (sharedOcrWorker) {
    try {
      await sharedOcrWorker.terminate();
    } catch {
      // ignore
    }
    sharedOcrWorker = null;
  }
}

export async function runLocalOcrDetection(
  canvas: HTMLCanvasElement,
  policy: RedactionPolicy,
  onProgress?: (progress: number, status: string) => void,
): Promise<OcrScanResult> {
  const startMs = performance.now();

  if (!sharedOcrWorker) {
    onProgress?.(0.05, 'Initializing local Tesseract OCR worker...');
    sharedOcrWorker = await createWorker('eng', 1, {
      workerPath: '/assets/ocr/worker/worker.min.js',
      corePath: '/assets/ocr/core/',
      langPath: '/assets/ocr/lang/',
      workerBlobURL: false,
      cacheMethod: 'none',
      gzip: true,
      logger: (msg) => {
        if (typeof msg.progress === 'number') {
          onProgress?.(msg.progress, msg.status || 'Recognizing text...');
        }
      },
    });
  }

  onProgress?.(0.3, 'Running local OCR recognition...');
  const { data } = await sharedOcrWorker.recognize(canvas, {}, { blocks: true, text: true });

  const words: OcrWordBox[] = [];
  const textParts: string[] = [];
  let offset = 0;
  let lineIndex = 0;

  const blocks = data.blocks || [];
  for (const block of blocks) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        const lineWords = line.words || [];
        for (let wIdx = 0; wIdx < lineWords.length; wIdx += 1) {
          const w = lineWords[wIdx];
          const cleanText = (w.text || '').trim();
          if (!cleanText) continue;

          if (wIdx > 0 && textParts.length > 0 && !textParts[textParts.length - 1].endsWith('\n')) {
            textParts.push(' ');
            offset += 1;
          }

          const startOffset = offset;
          textParts.push(cleanText);
          offset += cleanText.length;

          const bbox = clampRect(
            {
              x: w.bbox.x0,
              y: w.bbox.y0,
              width: w.bbox.x1 - w.bbox.x0,
              height: w.bbox.y1 - w.bbox.y0,
            },
            canvas.width,
            canvas.height,
          );

          words.push({
            text: cleanText,
            confidence: w.confidence ?? 0,
            bbox,
            lineIndex,
            startOffset,
            endOffset: offset,
          });
        }
        textParts.push('\n');
        offset += 1;
        lineIndex += 1;
      }
    }
  }

  const fullText = textParts.join('');
  const det = runDetectionPipeline(fullText, { policy, revision: 1 });
  const regions: VisionRegion[] = [];

  for (const cand of det.accepted) {
    const overlappingWords = words.filter(
      (w) => w.startOffset < cand.end && w.endOffset > cand.start,
    );
    if (overlappingWords.length === 0) continue;

    // Group by lineIndex so wrapped multi-line identifiers mask each line tightly without eating unrelated middle columns
    const byLine = new Map<number, PixelRect[]>();
    for (const ow of overlappingWords) {
      const list = byLine.get(ow.lineIndex) ?? [];
      list.push(ow.bbox);
      byLine.set(ow.lineIndex, list);
    }

    const avgConf =
      overlappingWords.reduce((acc, w) => acc + w.confidence, 0) / overlappingWords.length;

    let partIdx = 0;
    for (const lineRects of byLine.values()) {
      partIdx += 1;
      const merged = padRect(unionRects(lineRects), 4, 3, canvas.width, canvas.height);
      if (merged.width <= 0 || merged.height <= 0) continue;
      regions.push({
        id: `ocr_${cand.id}_l${partIdx}`,
        type: cand.type,
        label: `${cand.type}`,
        rect: merged,
        method: 'ocr',
        confidence: Number((avgConf / 100).toFixed(3)),
        selected: true,
        effect: 'solid',
        blurRadius: 18,
        pixelBlockSize: 16,
        maskedPreview: cand.maskedPreview,
        validationStatus: cand.validationStatus,
        evidence: `${cand.evidence} (OCR word confidence ${avgConf.toFixed(0)}%; full affected word bounds masked)`,
      });
    }
  }

  onProgress?.(1, 'OCR scan complete');
  return {
    fullText,
    words,
    regions,
    rejectedCount: det.rejected.length,
    durationMs: Number((performance.now() - startMs).toFixed(2)),
  };
}

/**
 * Translates grounded semantic text spans (from local Gemma over OCR text)
 * into canonical OCR word/line bounding boxes without letting the LLM invent coordinates.
 */
export function mapTextSpansToOcrRegions(
  spans: Array<{ id: string; type: string; start: number; end: number; maskedPreview: string; evidence: string }>,
  words: OcrWordBox[],
  canvasWidth: number,
  canvasHeight: number,
): VisionRegion[] {
  const mapped: VisionRegion[] = [];

  for (const s of spans) {
    const overlapping = words.filter((w) => w.startOffset < s.end && w.endOffset > s.start);
    if (overlapping.length === 0) continue;

    const byLine = new Map<number, PixelRect[]>();
    for (const ow of overlapping) {
      const list = byLine.get(ow.lineIndex) ?? [];
      list.push(ow.bbox);
      byLine.set(ow.lineIndex, list);
    }

    const avgConf = overlapping.reduce((acc, w) => acc + w.confidence, 0) / overlapping.length;
    let linePart = 0;
    for (const lineRects of byLine.values()) {
      linePart += 1;
      const merged = padRect(unionRects(lineRects), 4, 3, canvasWidth, canvasHeight);
      if (merged.width <= 0 || merged.height <= 0) continue;
      mapped.push({
        id: `ocr_ai_${s.id}_l${linePart}`,
        type: 'CONTEXT_ID',
        label: `${s.type} (Gemma+OCR)`,
        rect: merged,
        method: 'ocr',
        confidence: Number((avgConf / 100).toFixed(3)),
        selected: true,
        effect: 'solid',
        blurRadius: 18,
        pixelBlockSize: 16,
        maskedPreview: s.maskedPreview,
        evidence: `${s.evidence} (Mapped from grounded OCR words; confidence ${avgConf.toFixed(0)}%)`,
      });
    }
  }

  return mapped;
}
