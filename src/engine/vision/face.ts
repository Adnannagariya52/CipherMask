import { FaceDetector, FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision';
import { padRect, type VisionRegion } from './geometry.ts';

let faceDetectorInstance: FaceDetector | null = null;
let segmenterInstance: ImageSegmenter | null = null;

export async function disposeVisionModels(): Promise<void> {
  if (faceDetectorInstance) {
    try {
      faceDetectorInstance.close();
    } catch {
      // ignore
    }
    faceDetectorInstance = null;
  }
  if (segmenterInstance) {
    try {
      segmenterInstance.close();
    } catch {
      // ignore
    }
    segmenterInstance = null;
  }
}

export async function detectFacesLocally(
  canvas: HTMLCanvasElement,
  minDetectionConfidence = 0.45,
): Promise<VisionRegion[]> {
  if (!faceDetectorInstance) {
    const fileset = await FilesetResolver.forVisionTasks('/assets/vision/wasm');
    faceDetectorInstance = await FaceDetector.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: '/assets/vision/models/blaze_face_short_range.tflite',
        delegate: 'CPU',
      },
      runningMode: 'IMAGE',
      minDetectionConfidence,
    });
  } else {
    await faceDetectorInstance.setOptions({ minDetectionConfidence });
  }

  const res = faceDetectorInstance.detect(canvas);
  const detections = res.detections || [];
  const regions: VisionRegion[] = [];

  for (let i = 0; i < detections.length; i += 1) {
    const d = detections[i];
    const box = d.boundingBox;
    if (!box) continue;
    const score = d.categories?.[0]?.score ?? 0;
    const padX = Math.round(box.width * 0.12);
    const padY = Math.round(box.height * 0.14);
    const rect = padRect(
      {
        x: box.originX,
        y: box.originY,
        width: box.width,
        height: box.height,
      },
      padX,
      padY,
      canvas.width,
      canvas.height,
    );
    if (rect.width <= 0 || rect.height <= 0) continue;

    regions.push({
      id: `face_${i + 1}_${rect.x}_${rect.y}`,
      type: 'FACE',
      label: `FACE_${String(i + 1).padStart(2, '0')}`,
      rect,
      method: 'vision_face',
      confidence: Number(score.toFixed(3)),
      selected: true,
      effect: 'blur',
      blurRadius: 20,
      pixelBlockSize: 16,
      evidence: `BlazeFace detection score ${(score * 100).toFixed(1)}% (scoped to image; no biometric identity).`,
    });
  }

  return regions;
}

export async function segmentPeopleLocally(canvas: HTMLCanvasElement): Promise<VisionRegion | null> {
  if (!segmenterInstance) {
    const fileset = await FilesetResolver.forVisionTasks('/assets/vision/wasm');
    segmenterInstance = await ImageSegmenter.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: '/assets/vision/models/selfie_segmenter.tflite',
        delegate: 'CPU',
      },
      runningMode: 'IMAGE',
      outputCategoryMask: true,
      outputConfidenceMasks: false,
    });
  }

  const res = segmenterInstance.segment(canvas);
  const maskObj = res.categoryMask;
  if (!maskObj) return null;

  try {
    const w = maskObj.width;
    const h = maskObj.height;
    const raw = maskObj.getAsUint8Array();
    const binary = new Uint8Array(w * h);
    let minX = w;
    let minY = h;
    let maxX = 0;
    let maxY = 0;
    let fgPixels = 0;

    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const idx = y * w + x;
        // selfie_segmenter category 0 = background, >0 (or 1) = person foreground
        if (raw[idx] > 0) {
          binary[idx] = 1;
          fgPixels += 1;
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }

    if (fgPixels === 0) return null;
    return {
      id: `person_seg_${Date.now()}`,
      type: 'PERSON_REGION',
      label: 'ALL_DETECTED_PEOPLE',
      rect: {
        x: minX,
        y: minY,
        width: Math.max(1, maxX - minX + 1),
        height: Math.max(1, maxY - minY + 1),
      },
      method: 'vision_segment',
      selected: false, // Opt-in because semantic mask covers all foreground people together
      effect: 'solid',
      blurRadius: 22,
      pixelBlockSize: 18,
      segmentationMask: { width: w, height: h, mask: binary },
      evidence: 'Semantic person segmentation mask (conceals all detected foreground people; use manual boxes for individual people).',
    };
  } finally {
    res.close();
  }
}
