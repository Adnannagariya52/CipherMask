import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Upload,
  Sparkles,
  ScanText,
  ScanFace,
  QrCode,
  MousePointer,
  Square,
  Undo2,
  Redo2,
  Trash2,
  Download,
  Eye,
  EyeOff,
  CheckCircle2,
  AlertTriangle,
  Users,
  ZoomIn,
  ZoomOut,
  Maximize2,
  FileCheck2,
  XCircle,
} from 'lucide-react';
import { useSession } from '../../state/session.tsx';
import { createDefaultPolicy } from '../../engine/redaction.ts';
import { decodeImageToCanonicalCanvas, type DecodedCanonicalImage } from '../../engine/vision/decode.ts';
import { clientToCanonicalPixel, clampRect, type VisionRegion, type VisualEffect } from '../../engine/vision/geometry.ts';
import { inspectImageMetadata, type MetadataInspectionResult } from '../../engine/vision/metadata.ts';
import { detectVisualCodes } from '../../engine/vision/codes.ts';
import {
  mapTextSpansToOcrRegions,
  runLocalOcrDetection,
  terminateOcrWorker,
  type OcrWordBox,
} from '../../engine/vision/ocr.ts';
import { sharedGemmaReasoner } from '../../intelligence/localReasoner.ts';
import { runGemmaSemanticDetection } from '../../intelligence/semanticDetector.ts';
import { detectFacesLocally, segmentPeopleLocally } from '../../engine/vision/face.ts';
import {
  exportCanvasToBytes,
  renderSanitizedCanvas,
  verifyOpaqueRegionsInCanvas,
} from '../../engine/vision/render.ts';
import { createSyntheticTicketPngBytes } from '../../engine/vision/sampleGenerator.ts';
import { createAuditReceipt } from '../../engine/audit.ts';
import { EntityBadge } from '../../components/EntityBadge.tsx';
import { PageHeader } from '../../components/ui/PageHeader.tsx';

function triggerDownload(filename: string, bytes: Uint8Array, mime: string) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const blob = new Blob([copy.buffer], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const MAX_UNDO = 30;

export const VisionShield: React.FC = () => {
  const { setLastAuditReceipt, setActiveModule, pushToast, announce } = useSession();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const sourcePreviewCanvasRef = useRef<HTMLCanvasElement>(null);
  const sanitizedPreviewCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<SVGSVGElement>(null);

  const [decoded, setDecoded] = useState<DecodedCanonicalImage | null>(null);
  const [filename, setFilename] = useState<string>('image.png');
  const [metadata, setMetadata] = useState<MetadataInspectionResult | null>(null);
  const [revealMeta, setRevealMeta] = useState<boolean>(false);

  const [regions, setRegions] = useState<VisionRegion[]>([]);
  const [undoStack, setUndoStack] = useState<VisionRegion[][]>([]);
  const [redoStack, setRedoStack] = useState<VisionRegion[][]>([]);
  const [selectedRegionId, setSelectedRegionId] = useState<string | null>(null);

  const [tool, setTool] = useState<'select' | 'draw'>('select');
  const [drawStart, setDrawStart] = useState<{ x: number; y: number } | null>(null);
  const [drawCurrent, setDrawCurrent] = useState<{ x: number; y: number } | null>(null);
  const [zoom, setZoom] = useState<number>(1);

  const [busyMessage, setBusyMessage] = useState<string>('');
  const [scanProgress, setScanProgress] = useState<number>(0);
  const cancelFlagRef = useRef<boolean>(false);

  const [ocrRan, setOcrRan] = useState<boolean>(false);
  const [ocrTextPreview, setOcrTextPreview] = useState<string>('');
  const [ocrWords, setOcrWords] = useState<OcrWordBox[]>([]);
  const [showOcrText, setShowOcrText] = useState<boolean>(false);
  const [faceRan, setFaceRan] = useState<boolean>(false);
  const [codeRan, setCodeRan] = useState<boolean>(false);
  const [exportFormat, setExportFormat] = useState<'image/png' | 'image/jpeg'>('image/png');
  const [exportVerificationMsg, setExportVerificationMsg] = useState<string>('');

  // Manual numeric box inputs (keyboard accessible alternative to pointer drawing)
  const [manualForm, setManualForm] = useState({ x: 20, y: 20, width: 160, height: 48 });

  // Cleanup worker on unmount / session reset remount
  useEffect(() => {
    return () => {
      cancelFlagRef.current = true;
      terminateOcrWorker();
    };
  }, []);

  const commitRegions = useCallback(
    (updater: (prev: VisionRegion[]) => VisionRegion[]) => {
      setRegions((prev) => {
        const next = updater(prev);
        setUndoStack((u) => [...u.slice(-(MAX_UNDO - 1)), prev]);
        setRedoStack([]);
        return next;
      });
    },
    [],
  );

  const handleUndo = () => {
    if (undoStack.length === 0) return;
    const previous = undoStack[undoStack.length - 1];
    setUndoStack((u) => u.slice(0, -1));
    setRedoStack((r) => [...r, regions]);
    setRegions(previous);
  };

  const handleRedo = () => {
    if (redoStack.length === 0) return;
    const next = redoStack[redoStack.length - 1];
    setRedoStack((r) => r.slice(0, -1));
    setUndoStack((u) => [...u, regions]);
    setRegions(next);
  };

  const loadBytesIntoVision = async (bytes: Uint8Array, name: string) => {
    try {
      const mimeGuess = bytes[0] === 0x89 ? 'image/png' : 'image/jpeg';
      const blob = new Blob([bytes.buffer as ArrayBuffer], { type: mimeGuess });
      const dec = await decodeImageToCanonicalCanvas(blob, bytes);
      const meta = await inspectImageMetadata(bytes, dec.mimeType);

      setDecoded(dec);
      setFilename(name.replace(/[^A-Za-z0-9._-]/g, '_'));
      setMetadata(meta);
      setRevealMeta(false);
      setRegions([]);
      setUndoStack([]);
      setRedoStack([]);
      setSelectedRegionId(null);
      setOcrRan(false);
      setOcrTextPreview('');
      setFaceRan(false);
      setCodeRan(false);
      setZoom(1);
      setExportVerificationMsg('');
      announce(`Loaded ${name} (${dec.width}x${dec.height}).`);
      pushToast('success', `Loaded ${name} (${dec.width}×${dec.height} px).`);
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : 'Failed to decode image.');
    }
  };

  const handleFileUpload = async (file: File) => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    await loadBytesIntoVision(bytes, file.name);
  };

  const handleLoadSyntheticTicket = async () => {
    try {
      const bytes = await createSyntheticTicketPngBytes();
      await loadBytesIntoVision(bytes, 'synthetic-support-ticket.png');
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : 'Failed to generate synthetic PNG.');
    }
  };

  const handleLoadPortraitSample = async () => {
    try {
      const res = await fetch('/assets/samples/portrait.jpg');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      await loadBytesIntoVision(bytes, 'sample-portrait.jpg');
    } catch (err) {
      pushToast('error', `Could not load bundled portrait fixture: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Render Source & Live Sanitized Canvases whenever decoded image or regions change
  useEffect(() => {
    if (!decoded) return;
    const srcCanvas = sourcePreviewCanvasRef.current;
    if (srcCanvas) {
      srcCanvas.width = decoded.width;
      srcCanvas.height = decoded.height;
      const ctx = srcCanvas.getContext('2d');
      ctx?.drawImage(decoded.canvas, 0, 0);
    }

    const outCanvas = sanitizedPreviewCanvasRef.current;
    if (outCanvas) {
      renderSanitizedCanvas(decoded.canvas, regions, outCanvas);
    }
  }, [decoded, regions]);

  const handleScanOcrAndCodes = async () => {
    if (!decoded) return;
    cancelFlagRef.current = false;
    setBusyMessage('Scanning QR / barcodes...');
    setScanProgress(0.15);

    try {
      const codeRegions = detectVisualCodes(decoded.canvas);
      setCodeRan(true);
      if (cancelFlagRef.current) return;

      setBusyMessage('Running local Tesseract OCR...');
      const policy = createDefaultPolicy('AI_SAFE');
      const ocrRes = await runLocalOcrDetection(decoded.canvas, policy, (p, st) => {
        if (!cancelFlagRef.current) {
          setScanProgress(p);
          setBusyMessage(st);
        }
      });
      if (cancelFlagRef.current) return;

      setOcrRan(true);
      setOcrTextPreview(ocrRes.fullText);
      setOcrWords(ocrRes.words);

      let aiMappedRegions: VisionRegion[] = [];
      if (sharedGemmaReasoner.getStatus().state === 'ready' && ocrRes.fullText.trim()) {
        setBusyMessage('Running local Gemma semantic scan on OCR text...');
        const sem = await runGemmaSemanticDetection(sharedGemmaReasoner, ocrRes.fullText, 'vision_ocr', 1, {
          maxChunks: 3,
        });
        aiMappedRegions = mapTextSpansToOcrRegions(
          sem.grounded.map((g) => ({
            id: g.id,
            type: g.type,
            start: g.start,
            end: g.end,
            maskedPreview: `${g.rawText[0] || '*'}***`,
            evidence: g.validationNote,
          })),
          ocrRes.words,
          decoded.width,
          decoded.height,
        );
      }

      commitRegions((prev) => {
        const manualAndFaces = prev.filter((r) => r.method !== 'ocr' && r.method !== 'vision_code');
        return [...manualAndFaces, ...codeRegions, ...ocrRes.regions, ...aiMappedRegions];
      });

      pushToast(
        'success',
        `OCR found ${ocrRes.regions.length} rule region(s), ${aiMappedRegions.length} Gemma contextual region(s), and ${codeRegions.length} code region(s).`,
      );
    } catch (err) {
      pushToast('error', `OCR/Code scan error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusyMessage('');
      setScanProgress(0);
    }
  };

  const handleDetectFaces = async () => {
    if (!decoded) return;
    cancelFlagRef.current = false;
    setBusyMessage('Running local MediaPipe FaceDetector...');
    setScanProgress(0.5);

    try {
      const faces = await detectFacesLocally(decoded.canvas, 0.45);
      if (cancelFlagRef.current) return;
      setFaceRan(true);
      commitRegions((prev) => [...prev.filter((r) => r.method !== 'vision_face'), ...faces]);
      pushToast(
        faces.length > 0 ? 'success' : 'info',
        faces.length > 0
          ? `Detected ${faces.length} face region(s). Select individual effects or export.`
          : 'No faces detected by BlazeFace; use manual draw tool if needed.',
      );
    } catch (err) {
      pushToast('error', `Face detection unavailable: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusyMessage('');
      setScanProgress(0);
    }
  };

  const handleSegmentPeople = async () => {
    if (!decoded) return;
    setBusyMessage('Running semantic person segmentation...');
    setScanProgress(0.5);
    try {
      const seg = await segmentPeopleLocally(decoded.canvas);
      if (!seg) {
        pushToast('info', 'No foreground person segmentation mask detected.');
        return;
      }
      commitRegions((prev) => [...prev.filter((r) => r.method !== 'vision_segment'), seg]);
      setSelectedRegionId(seg.id);
      pushToast('info', 'Added semantic person mask (covers all detected people; toggle Selected to apply).');
    } catch (err) {
      pushToast('error', `Segmentation unavailable: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusyMessage('');
      setScanProgress(0);
    }
  };

  const handleRunAllScans = async () => {
    await handleScanOcrAndCodes();
    if (!cancelFlagRef.current) {
      await handleDetectFaces();
    }
  };

  const handlePointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!decoded || tool !== 'draw' || !overlayRef.current) return;
    const rect = overlayRef.current.getBoundingClientRect();
    const pt = clientToCanonicalPixel(e.clientX, e.clientY, rect, decoded.width, decoded.height);
    setDrawStart(pt);
    setDrawCurrent(pt);
  };

  const handlePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!decoded || !drawStart || !overlayRef.current) return;
    const rect = overlayRef.current.getBoundingClientRect();
    const pt = clientToCanonicalPixel(e.clientX, e.clientY, rect, decoded.width, decoded.height);
    setDrawCurrent(pt);
  };

  const handlePointerUp = () => {
    if (!decoded || !drawStart || !drawCurrent) {
      setDrawStart(null);
      setDrawCurrent(null);
      return;
    }
    const x = Math.min(drawStart.x, drawCurrent.x);
    const y = Math.min(drawStart.y, drawCurrent.y);
    const width = Math.abs(drawCurrent.x - drawStart.x);
    const height = Math.abs(drawCurrent.y - drawStart.y);
    setDrawStart(null);
    setDrawCurrent(null);

    if (width < 6 || height < 6) return;
    const clamped = clampRect({ x, y, width, height }, decoded.width, decoded.height);
    const id = `manual_${Date.now()}`;
    const region: VisionRegion = {
      id,
      type: 'MANUAL',
      label: `MANUAL_${regions.filter((r) => r.method === 'manual').length + 1}`,
      rect: clamped,
      method: 'manual',
      selected: true,
      effect: 'solid',
      blurRadius: 20,
      pixelBlockSize: 16,
      evidence: 'Manually drawn mask region.',
    };
    commitRegions((prev) => [...prev, region]);
    setSelectedRegionId(id);
    setTool('select');
  };

  const handleAddManualNumeric = (e: React.FormEvent) => {
    e.preventDefault();
    if (!decoded) return;
    const clamped = clampRect(manualForm, decoded.width, decoded.height);
    if (clamped.width < 2 || clamped.height < 2) {
      pushToast('warning', 'Manual rectangle must be at least 2×2 pixels inside image bounds.');
      return;
    }
    const id = `manual_${Date.now()}`;
    const region: VisionRegion = {
      id,
      type: 'MANUAL',
      label: `MANUAL_${regions.filter((r) => r.method === 'manual').length + 1}`,
      rect: clamped,
      method: 'manual',
      selected: true,
      effect: 'solid',
      blurRadius: 20,
      pixelBlockSize: 16,
      evidence: 'Manually entered keyboard rectangle.',
    };
    commitRegions((prev) => [...prev, region]);
    setSelectedRegionId(id);
  };

  const selectedRegion = useMemo(
    () => regions.find((r) => r.id === selectedRegionId) ?? null,
    [regions, selectedRegionId],
  );

  const updateRegion = (id: string, patch: Partial<VisionRegion>) => {
    commitRegions((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  const handleExportImage = async () => {
    if (!decoded) return;
    try {
      const fullOut = renderSanitizedCanvas(decoded.canvas, regions);
      const bytes = await exportCanvasToBytes(fullOut, exportFormat, 0.92);
      const pixelCheck = verifyOpaqueRegionsInCanvas(fullOut, regions);
      const outMeta = await inspectImageMetadata(bytes, exportFormat);

      const ext = exportFormat === 'image/png' ? 'png' : 'jpg';
      const outName = filename.replace(/\.(png|jpe?g)$/i, '') + `.sanitized.${ext}`;
      triggerDownload(outName, bytes, exportFormat);

      const faceRegions = regions.filter((r) => r.type === 'FACE');
      const selectedFaces = faceRegions.filter((r) => r.selected).length;
      const unselectedFaces = faceRegions.length - selectedFaces;

      const appliedEffects: Record<string, number> = {};
      for (const r of regions) {
        if (!r.selected) continue;
        appliedEffects[r.effect] = (appliedEffects[r.effect] ?? 0) + 1;
      }

      const byType: Record<string, number> = {};
      for (const r of regions) {
        byType[r.type] = (byType[r.type] ?? 0) + 1;
      }

      const metadataStrippedVerified = !outMeta.hasGps && !outMeta.hasDeviceInfo && outMeta.pngTextChunksFound.length === 0;
      const receipt = await createAuditReceipt({
        inputFormat: decoded.mimeType === 'image/png' ? 'png' : 'jpeg',
        inputByteSize: decoded.byteSize,
        outputFormat: exportFormat,
        outputBytes: bytes,
        policyPreset: 'CUSTOM',
        defaultMode: 'FULL',
        enabledMethods: [
          ...(ocrRan ? ['ocr'] : []),
          ...(faceRan ? ['vision_face'] : []),
          ...(codeRan ? ['vision_code'] : []),
          'canvas_flatten',
        ],
        counts: {
          totalDetected: regions.length,
          uniqueEntities: regions.length,
          applied: regions.filter((r) => r.selected).length,
          excluded: regions.filter((r) => !r.selected).length,
          rejected: 0,
          uncertain: 0,
          byType,
        },
        durationsMs: { detection: 0, redaction: 0 },
        statusLabel: pixelCheck.opaquePixelMismatch
          ? 'Exported; some opaque mask bounds failed pixel check'
          : 'Flattened image exported; selected opaque masks verified',
        remainingFindings: unselectedFaces,
        limitations: [
          'Blur and pixelation may retain identifiable patterns; opaque solid masking is recommended.',
          'OCR and face detectors can have false negatives; visually inspect output before sharing.',
        ],
        visionSummary: {
          originalDimensions: { width: decoded.width, height: decoded.height },
          exportedDimensions: { width: fullOut.width, height: fullOut.height },
          selectedFaces,
          unselectedFaces,
          appliedEffects,
          ocrRan,
          codeScanRan: codeRan,
          metadataCategoriesDetected: metadata?.categoriesPresent ?? [],
          metadataRemovedVerified: metadataStrippedVerified,
        },
        offlineAssetStatus: {
          ocr: ocrRan ? 'used' : 'ready',
          faceDetector: faceRan ? 'used' : 'ready',
        },
      });
      setLastAuditReceipt(receipt);
      setExportVerificationMsg(
        `Exported ${outName} (${fullOut.width}×${fullOut.height} px, ${(bytes.byteLength / 1024).toFixed(1)} KiB). Opaque masks verified: ${pixelCheck.opaqueRegionsVerified}. Metadata carried over: ${metadataStrippedVerified ? 'None detected' : 'Check warnings'}.`,
      );
      pushToast('success', `Exported flattened ${outName} with SHA-256 receipt.`);
    } catch (err) {
      pushToast('error', `Export failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const faceCount = regions.filter((r) => r.type === 'FACE').length;
  const selectedCount = regions.filter((r) => r.selected).length;

  return (
    <div className="space-y-8 ae-fade-in">
      <PageHeader
        eyebrow="Visual Privacy Studio"
        title="Vision Shield"
        description="Inspect images, detect text, QR codes, and faces locally, apply opaque masks or pixelation, and export flattened EXIF-free files."
      />

      {/* Primary Action Toolbar */}
      <section className="ae-card p-5 sm:p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2.5">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,.png,.jpg,.jpeg"
              className="hidden"
              data-testid="vision-file-input"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFileUpload(f);
                e.target.value = '';
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="ae-btn-secondary inline-flex items-center gap-2 rounded-xl px-4 h-11 text-[15px] cursor-pointer"
            >
              <Upload className="w-4 h-4 text-[#087F6D]" aria-hidden="true" />
              <span>Upload PNG / JPEG</span>
            </button>

            <button
              type="button"
              data-testid="load-vision-ticket-btn"
              onClick={handleLoadSyntheticTicket}
              className="ae-btn-secondary inline-flex items-center gap-2 rounded-xl px-4 h-11 text-[15px] text-[#087F6D] border-[#087F6D]/30 bg-[#E1F5EF]/50 hover:bg-[#E1F5EF] cursor-pointer"
            >
              <Sparkles className="w-4 h-4" aria-hidden="true" />
              <span>Sample Ticket + QR</span>
            </button>

            <button
              type="button"
              data-testid="load-vision-portrait-btn"
              onClick={handleLoadPortraitSample}
              className="ae-btn-secondary inline-flex items-center gap-2 rounded-xl px-4 h-11 text-[15px] cursor-pointer"
            >
              <span>Sample Portrait (Faces)</span>
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              data-testid="vision-scan-ocr-btn"
              disabled={!decoded || Boolean(busyMessage)}
              onClick={handleScanOcrAndCodes}
              className="ae-btn-secondary inline-flex items-center gap-2 rounded-xl px-4 h-11 text-sm disabled:opacity-45 cursor-pointer"
            >
              <ScanText className="w-4 h-4 text-[#2563EB]" aria-hidden="true" />
              <span>Scan OCR + QR</span>
            </button>

            <button
              type="button"
              data-testid="vision-scan-faces-btn"
              disabled={!decoded || Boolean(busyMessage)}
              onClick={handleDetectFaces}
              className="ae-btn-indigo inline-flex items-center gap-2 rounded-xl px-4 h-11 text-sm disabled:opacity-45 cursor-pointer"
            >
              <ScanFace className="w-4 h-4" aria-hidden="true" />
              <span>Detect Faces</span>
            </button>

            <button
              type="button"
              disabled={!decoded || Boolean(busyMessage)}
              onClick={handleSegmentPeople}
              className="ae-btn-secondary inline-flex items-center gap-2 rounded-xl px-4 h-11 text-sm disabled:opacity-45 cursor-pointer"
            >
              <Users className="w-4 h-4 text-[#6366F1]" aria-hidden="true" />
              <span>Segment People</span>
            </button>

            <button
              type="button"
              data-testid="vision-scan-all-btn"
              disabled={!decoded || Boolean(busyMessage)}
              onClick={handleRunAllScans}
              className="ae-btn-primary inline-flex items-center gap-2 rounded-xl px-5 h-11 text-[15px] disabled:opacity-45 cursor-pointer"
            >
              <QrCode className="w-4 h-4" aria-hidden="true" />
              <span>Run All Scans</span>
            </button>

            {busyMessage && (
              <button
                type="button"
                onClick={() => {
                  cancelFlagRef.current = true;
                  setBusyMessage('');
                }}
                className="ae-btn-danger inline-flex items-center gap-1.5 rounded-xl px-4 h-11 text-sm cursor-pointer"
              >
                <XCircle className="w-4 h-4" />
                <span>Cancel</span>
              </button>
            )}
          </div>
        </div>

        {/* Canvas Editing Strip */}
        <div className="pt-4 border-t border-[#EDF0F4] flex flex-wrap items-center justify-between gap-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-xl border border-[#E2E8F0] bg-[#F7F9FC] p-1">
              <button
                type="button"
                onClick={() => setTool('select')}
                className={`inline-flex items-center gap-1.5 rounded-lg px-3 h-8 font-medium transition cursor-pointer ${
                  tool === 'select'
                    ? 'bg-white text-[#087F6D] shadow-2xs border border-[#E2E8F0]'
                    : 'text-[#475569] hover:text-[#101828]'
                }`}
              >
                <MousePointer className="w-3.5 h-3.5" /> Select
              </button>
              <button
                type="button"
                data-testid="vision-draw-tool-btn"
                onClick={() => setTool('draw')}
                className={`inline-flex items-center gap-1.5 rounded-lg px-3 h-8 font-medium transition cursor-pointer ${
                  tool === 'draw'
                    ? 'bg-white text-[#087F6D] shadow-2xs border border-[#E2E8F0]'
                    : 'text-[#475569] hover:text-[#101828]'
                }`}
              >
                <Square className="w-3.5 h-3.5" /> Draw Box
              </button>
            </div>

            <button
              type="button"
              disabled={undoStack.length === 0}
              onClick={handleUndo}
              className="ae-btn-secondary inline-flex items-center gap-1.5 rounded-lg px-3 h-9 text-sm disabled:opacity-45 cursor-pointer"
            >
              <Undo2 className="w-3.5 h-3.5" /> Undo
            </button>
            <button
              type="button"
              disabled={redoStack.length === 0}
              onClick={handleRedo}
              className="ae-btn-secondary inline-flex items-center gap-1.5 rounded-lg px-3 h-9 text-sm disabled:opacity-45 cursor-pointer"
            >
              <Redo2 className="w-3.5 h-3.5" /> Redo
            </button>

            {faceCount > 0 && (
              <>
                <button
                  type="button"
                  onClick={() =>
                    commitRegions((prev) =>
                      prev.map((r) => (r.type === 'FACE' ? { ...r, selected: true } : r)),
                    )
                  }
                  className="ae-btn-secondary rounded-lg px-3 h-9 text-sm cursor-pointer"
                >
                  All Faces
                </button>
                <button
                  type="button"
                  onClick={() =>
                    commitRegions((prev) =>
                      prev.map((r) => (r.type === 'FACE' ? { ...r, selected: false } : r)),
                    )
                  }
                  className="ae-btn-secondary rounded-lg px-3 h-9 text-sm cursor-pointer"
                >
                  Unselect Faces
                </button>
              </>
            )}
            {regions.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  commitRegions(() => []);
                  setSelectedRegionId(null);
                }}
                className="ae-btn-danger rounded-lg px-3 h-9 text-sm cursor-pointer"
              >
                Reset Boxes
              </button>
            )}
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setZoom((z) => Math.max(0.5, Number((z - 0.25).toFixed(2))))}
              aria-label="Zoom out"
              className="ae-btn-secondary rounded-lg p-2 cursor-pointer"
            >
              <ZoomOut className="w-4 h-4" />
            </button>
            <span className="font-mono w-14 text-center text-sm font-medium text-[#101828]">{Math.round(zoom * 100)}%</span>
            <button
              type="button"
              onClick={() => setZoom((z) => Math.min(2.5, Number((z + 0.25).toFixed(2))))}
              aria-label="Zoom in"
              className="ae-btn-secondary rounded-lg p-2 cursor-pointer"
            >
              <ZoomIn className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => setZoom(1)}
              aria-label="Fit zoom"
              className="ae-btn-secondary rounded-lg px-3 h-9 text-sm cursor-pointer"
            >
              <Maximize2 className="w-3.5 h-3.5 inline mr-1.5" />
              Fit
            </button>
          </div>
        </div>
      </section>

      {busyMessage && (
        <div className="ae-card p-4 text-sm flex items-center justify-between gap-4 border-[#087F6D]/30 bg-[#E1F5EF]/45">
          <span className="text-[#087F6D] font-semibold">{busyMessage}</span>
          <div className="w-52 h-2 rounded-full bg-[#E2E8F0] overflow-hidden">
            <div
              className="h-full bg-[#087F6D] transition-all"
              style={{ width: `${Math.max(8, Math.round(scanProgress * 100))}%` }}
            />
          </div>
        </div>
      )}

      {!decoded ? (
        <div className="rounded-2xl border border-dashed border-[#CBD5E1] bg-white p-16 text-center space-y-4">
          <div className="mx-auto w-14 h-14 rounded-2xl bg-[#E1F5EF] text-[#087F6D] flex items-center justify-center">
            <ScanText className="w-7 h-7" aria-hidden="true" />
          </div>
          <p className="text-lg font-semibold text-[#101828]">
            Upload a PNG or JPEG screenshot, document photo, or portrait
          </p>
          <p className="text-base text-[#475569] max-w-2xl mx-auto leading-relaxed">
            Or load one of the bundled synthetic samples above. All OCR, BlazeFace face detection, QR scanning, metadata stripping, and Canvas flattening stay inside your browser.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
          {/* Side-by-side Neutral Canvas Stage */}
          <div className="xl:col-span-8 space-y-5">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              {/* Source + Interactive SVG Overlay */}
              <div className="ae-card overflow-hidden">
                <div className="px-5 py-3.5 border-b border-[#EDF0F4] bg-[#F8FAFC] flex items-center justify-between text-sm">
                  <span className="font-semibold text-[#101828]">
                    Original ({decoded.width}×{decoded.height})
                  </span>
                  <span className="text-[#64748B] text-[13px]">{tool === 'draw' ? 'Drag to draw mask' : 'Click box to inspect'}</span>
                </div>
                <div className="overflow-auto max-h-[500px] p-4 flex items-center justify-center bg-[#F1F5F9]">
                  <div
                    className="relative inline-block shadow-sm"
                    style={{ width: `${Math.round(zoom * 100)}%`, maxWidth: zoom === 1 ? '100%' : 'none' }}
                  >
                    <canvas
                      ref={sourcePreviewCanvasRef}
                      data-testid="vision-source-canvas"
                      className="block w-full h-auto rounded-lg bg-white"
                    />
                    <svg
                      ref={overlayRef}
                      viewBox={`0 0 ${decoded.width} ${decoded.height}`}
                      className={`absolute inset-0 w-full h-full ${tool === 'draw' ? 'cursor-crosshair' : 'cursor-pointer'}`}
                      onPointerDown={handlePointerDown}
                      onPointerMove={handlePointerMove}
                      onPointerUp={handlePointerUp}
                    >
                      {regions.map((r) => {
                        const isSel = r.id === selectedRegionId;
                        const stroke = r.selected ? (isSel ? '#087F6D' : '#6366F1') : '#64748B';
                        return (
                          <g
                            key={r.id}
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedRegionId(r.id);
                            }}
                          >
                            <rect
                              x={r.rect.x}
                              y={r.rect.y}
                              width={r.rect.width}
                              height={r.rect.height}
                              fill={r.selected ? (isSel ? 'rgba(8,127,109,0.20)' : 'rgba(99,102,241,0.14)') : 'rgba(100,116,139,0.10)'}
                              stroke={stroke}
                              strokeWidth={Math.max(2, Math.round(decoded.width / 350))}
                              strokeDasharray={r.selected ? undefined : '6 4'}
                            />
                          </g>
                        );
                      })}
                      {drawStart && drawCurrent && (
                        <rect
                          x={Math.min(drawStart.x, drawCurrent.x)}
                          y={Math.min(drawStart.y, drawCurrent.y)}
                          width={Math.abs(drawCurrent.x - drawStart.x)}
                          height={Math.abs(drawCurrent.y - drawStart.y)}
                          fill="rgba(8,127,109,0.22)"
                          stroke="#087F6D"
                          strokeWidth={2}
                        />
                      )}
                    </svg>
                  </div>
                </div>
              </div>

              {/* Sanitized Live Canvas */}
              <div className="ae-card overflow-hidden border-[#087F6D]/30">
                <div className="px-5 py-3.5 border-b border-[#EDF0F4] bg-[#E1F5EF]/55 flex items-center justify-between text-sm">
                  <span className="font-semibold text-[#087F6D]">Sanitized Pixel Preview</span>
                  <span className="font-mono text-[13px] text-[#475569]">{selectedCount} region(s) active</span>
                </div>
                <div className="overflow-auto max-h-[500px] p-4 flex items-center justify-center bg-[#F1F5F9]">
                  <div
                    className="relative inline-block shadow-sm"
                    style={{ width: `${Math.round(zoom * 100)}%`, maxWidth: zoom === 1 ? '100%' : 'none' }}
                  >
                    <canvas
                      ref={sanitizedPreviewCanvasRef}
                      data-testid="vision-sanitized-canvas"
                      className="block w-full h-auto rounded-lg bg-white"
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Keyboard Accessible Numeric Rectangle Entry */}
            <form
              onSubmit={handleAddManualNumeric}
              className="ae-card p-4 sm:p-5 flex flex-wrap items-end gap-3 text-sm"
            >
              <div className="font-semibold text-[#101828] mr-1 self-center">Manual Box (px):</div>
              {(['x', 'y', 'width', 'height'] as const).map((field) => (
                <label key={field} className="flex flex-col gap-1 text-xs font-medium text-[#64748B]">
                  <span className="uppercase">{field}</span>
                  <input
                    type="number"
                    min={0}
                    max={Math.max(decoded.width, decoded.height)}
                    value={manualForm[field]}
                    onChange={(e) =>
                      setManualForm((prev) => ({ ...prev, [field]: Number(e.target.value) || 0 }))
                    }
                    className="ae-input w-24 px-3 h-10 font-mono text-sm"
                  />
                </label>
              ))}
              <button
                type="submit"
                data-testid="vision-add-manual-box-btn"
                className="ae-btn-secondary rounded-xl px-4 h-10 text-sm font-semibold text-[#087F6D] border-[#087F6D]/35 hover:bg-[#E1F5EF] cursor-pointer"
              >
                + Add Box
              </button>
            </form>

            {ocrRan && (
              <div className="ae-card p-5 text-sm space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold text-[#101828]">Recognized OCR Text ({ocrWords.length} word boxes; RAM only)</span>
                  <div className="flex items-center gap-4">
                    <button
                      type="button"
                      onClick={async () => {
                        if (!decoded || !ocrTextPreview.trim()) return;
                        if (sharedGemmaReasoner.getStatus().state !== 'ready') {
                          pushToast('info', 'Load Gemma 3 4B in Local AI & Cloud Setup to map contextual AI findings onto OCR boxes.');
                          return;
                        }
                        setBusyMessage('Running Gemma semantic scan on OCR text...');
                        try {
                          const sem = await runGemmaSemanticDetection(sharedGemmaReasoner, ocrTextPreview, 'vision_ocr', 1, { maxChunks: 3 });
                          const aiMapped = mapTextSpansToOcrRegions(
                            sem.grounded.map((g) => ({
                              id: g.id,
                              type: g.type,
                              start: g.start,
                              end: g.end,
                              maskedPreview: `${g.rawText[0] || '*'}***`,
                              evidence: g.validationNote,
                            })),
                            ocrWords,
                            decoded.width,
                            decoded.height,
                          );
                          commitRegions((prev) => [...prev.filter((r) => !r.id.startsWith('ocr_ai_')), ...aiMapped]);
                          pushToast('success', `Mapped ${aiMapped.length} Gemma contextual OCR region(s).`);
                        } finally {
                          setBusyMessage('');
                        }
                      }}
                      className="text-[#4338CA] font-medium hover:underline cursor-pointer"
                    >
                      Run Gemma Semantic OCR
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowOcrText((v) => !v)}
                      className="text-[#087F6D] font-medium hover:underline cursor-pointer"
                    >
                      {showOcrText ? 'Hide OCR Text' : 'Show OCR Text'}
                    </button>
                  </div>
                </div>
                {showOcrText && (
                  <pre className="ae-well p-4 font-mono text-[13px] whitespace-pre-wrap max-h-44 overflow-y-auto text-[#1E293B]">
                    {ocrTextPreview || '(No text recognized)'}
                  </pre>
                )}
              </div>
            )}
          </div>

          {/* Right Inspector & Metadata Column */}
          <aside className="xl:col-span-4 space-y-5">
            {/* Metadata Card */}
            <div className="ae-card p-5 text-sm space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold text-[#101828]">Embedded Metadata</h2>
                {metadata && metadata.categoriesPresent.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setRevealMeta((v) => !v)}
                    className="inline-flex items-center gap-1.5 text-[13px] font-medium text-[#087F6D] cursor-pointer"
                  >
                    {revealMeta ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    {revealMeta ? 'Hide' : 'Reveal'}
                  </button>
                )}
              </div>
              {metadata && metadata.categoriesPresent.length === 0 ? (
                <p className="text-[#475569]">No EXIF/GPS/PNG text metadata detected by supported parser checks.</p>
              ) : (
                <div className="space-y-2.5">
                  <div className="flex flex-wrap gap-1.5">
                    {metadata?.categoriesPresent.map((cat) => (
                      <span
                        key={cat}
                        className="rounded-md bg-[#FFFBEB] border border-[#FDE68A] px-2.5 py-0.5 text-xs font-medium text-[#B45309]"
                      >
                        {cat}
                      </span>
                    ))}
                  </div>
                  {revealMeta && metadata && (
                    <div className="ae-well p-3 font-mono text-xs space-y-1 text-[#475569]">
                      {Object.entries(metadata.rawSummaryInMemory).map(([k, v]) => (
                        <div key={k}>
                          <span className="text-[#64748B]">{k}:</span> {v}
                        </div>
                      ))}
                    </div>
                  )}
                  <p className="text-[13px] text-[#15803D] font-medium">
                    Export creates a fresh Canvas encoding without carrying over source EXIF/GPS/PNG text chunks.
                  </p>
                </div>
              )}
            </div>

            {/* Region Inspector */}
            <div className="ae-card overflow-hidden flex flex-col">
              <div className="px-5 py-4 border-b border-[#EDF0F4] text-base font-semibold text-[#101828]">
                Detected &amp; Manual Regions ({regions.length})
              </div>

              {selectedRegion && (
                <div className="p-4 border-b border-[#EDF0F4] bg-[#F8FAFC] text-sm space-y-3">
                  <div className="flex items-center justify-between">
                    <EntityBadge type={selectedRegion.type} />
                    <label className="inline-flex items-center gap-2 cursor-pointer text-[#101828] font-medium">
                      <input
                        type="checkbox"
                        checked={selectedRegion.selected}
                        onChange={(e) => updateRegion(selectedRegion.id, { selected: e.target.checked })}
                        className="h-4 w-4 accent-[#087F6D]"
                      />
                      <span>Mask Enabled</span>
                    </label>
                  </div>

                  {selectedRegion.method !== 'vision_segment' && (
                    <div className="space-y-2.5">
                      <div>
                        <span className="text-xs font-medium text-[#64748B] block mb-1.5">Visual Effect</span>
                        <div className="grid grid-cols-3 gap-2">
                          {(['solid', 'blur', 'pixelate'] as VisualEffect[]).map((eff) => (
                            <button
                              key={eff}
                              type="button"
                              data-testid={`region-effect-${eff}`}
                              onClick={() => updateRegion(selectedRegion.id, { effect: eff, selected: true })}
                              className={`rounded-lg border px-2.5 py-2 text-[13px] font-medium capitalize cursor-pointer transition-colors ${
                                selectedRegion.effect === eff
                                  ? 'border-[#087F6D] bg-[#E1F5EF] text-[#087F6D] font-semibold'
                                  : 'border-[#E2E8F0] bg-white text-[#475569]'
                              }`}
                            >
                              {eff === 'solid' ? 'Solid Mask' : eff}
                            </button>
                          ))}
                        </div>
                      </div>

                      {selectedRegion.effect === 'blur' && (
                        <label className="block text-xs font-medium text-[#475569]">
                          Blur Radius ({selectedRegion.blurRadius}px)
                          <input
                            type="range"
                            min={6}
                            max={48}
                            value={selectedRegion.blurRadius}
                            onChange={(e) =>
                              updateRegion(selectedRegion.id, { blurRadius: Number(e.target.value) })
                            }
                            className="w-full accent-[#087F6D] mt-1"
                          />
                        </label>
                      )}

                      {selectedRegion.effect === 'pixelate' && (
                        <label className="block text-xs font-medium text-[#475569]">
                          Block Size ({selectedRegion.pixelBlockSize}px)
                          <input
                            type="range"
                            min={6}
                            max={48}
                            value={selectedRegion.pixelBlockSize}
                            onChange={(e) =>
                              updateRegion(selectedRegion.id, { pixelBlockSize: Number(e.target.value) })
                            }
                            className="w-full accent-[#087F6D] mt-1"
                          />
                        </label>
                      )}
                    </div>
                  )}

                  {(selectedRegion.effect === 'blur' || selectedRegion.effect === 'pixelate') && (
                    <div className="flex items-start gap-2 rounded-lg border border-[#FDE68A] bg-[#FFFBEB] p-2.5 text-xs text-[#B45309]">
                      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
                      <span>Blur/pixelation may preserve identifiable patterns; opaque solid mask is recommended for high-risk PII.</span>
                    </div>
                  )}

                  <div className="flex items-center justify-between text-xs text-[#64748B]">
                    <span className="font-mono">
                      [{selectedRegion.rect.x},{selectedRegion.rect.y} {selectedRegion.rect.width}×{selectedRegion.rect.height}]
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        commitRegions((prev) => prev.filter((r) => r.id !== selectedRegion.id));
                        setSelectedRegionId(null);
                      }}
                      className="inline-flex items-center gap-1 font-medium text-[#DC2626] hover:underline cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" /> Delete
                    </button>
                  </div>
                </div>
              )}

              <div className="max-h-80 overflow-y-auto divide-y divide-[#EDF0F4]">
                {regions.length === 0 ? (
                  <div className="p-6 text-sm text-[#64748B] text-center">
                    No regions yet. Run OCR/Faces/QR scans or draw a manual box.
                  </div>
                ) : (
                  regions.map((r) => (
                    <div
                      key={r.id}
                      onClick={() => setSelectedRegionId(r.id)}
                      className={`px-5 py-3 text-sm flex items-center justify-between gap-2 cursor-pointer transition-colors hover:bg-[#F7F9FC] ${
                        selectedRegionId === r.id ? 'bg-[#E1F5EF]/60 border-l-4 border-l-[#087F6D]' : ''
                      }`}
                    >
                      <div className="min-w-0 space-y-1">
                        <div className="flex items-center gap-2">
                          <EntityBadge type={r.type} />
                          <span className="text-xs font-mono text-[#475569] uppercase">{r.effect}</span>
                        </div>
                        <div className="text-[13px] text-[#64748B] truncate">
                          {r.maskedPreview || r.evidence || r.label}
                        </div>
                      </div>
                      <input
                        type="checkbox"
                        aria-label={`Toggle mask for ${r.label}`}
                        checked={r.selected}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => updateRegion(r.id, { selected: e.target.checked })}
                        className="h-4 w-4 accent-[#087F6D]"
                      />
                    </div>
                  ))
                )}
              </div>
            </div>
          </aside>
        </div>
      )}

      {/* Export & Verification Bar */}
      {decoded && (
        <section className="ae-card p-5 sm:p-6 flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-[15px] font-semibold text-[#101828]">
              <CheckCircle2 className="w-5 h-5 text-[#15803D]" aria-hidden="true" />
              <span>
                Ready to flatten {selectedCount} active region(s) at full {decoded.width}×{decoded.height} resolution
              </span>
            </div>
            {exportVerificationMsg && (
              <div data-testid="vision-export-status" className="text-[13px] text-[#15803D] font-mono">
                {exportVerificationMsg}
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <select
              aria-label="Export image format"
              value={exportFormat}
              onChange={(e) => setExportFormat(e.target.value as 'image/png' | 'image/jpeg')}
              className="ae-input px-3.5 h-11 text-sm font-medium"
            >
              <option value="image/png">PNG (Exact unselected pixels)</option>
              <option value="image/jpeg">JPEG (92% quality)</option>
            </select>

            <button
              type="button"
              data-testid="vision-export-btn"
              onClick={handleExportImage}
              className="ae-btn-primary inline-flex items-center gap-2 rounded-xl px-5 h-11 text-[15px] cursor-pointer"
            >
              <Download className="w-4 h-4" aria-hidden="true" />
              <span>Export Flattened Image</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveModule('audit')}
              className="ae-btn-secondary inline-flex items-center gap-2 rounded-xl px-4 h-11 text-[15px] cursor-pointer"
            >
              <FileCheck2 className="w-4 h-4 text-[#087F6D]" aria-hidden="true" />
              <span>Audit Receipt</span>
            </button>
          </div>
        </section>
      )}
    </div>
  );
};
