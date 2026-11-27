import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  MessageSquareLock,
  Plus,
  Paperclip,
  ShieldCheck,
  ShieldAlert,
  Send,
  Lock,
  Cloud,
  Cpu,
  Eye,
  EyeOff,
  FileArchive,
  XCircle,
  AlertTriangle,
  Sparkles,
  CheckCircle2,
  Scale,
  Trash2,
} from 'lucide-react';
import { useSession } from '../state/session.tsx';
import { sharedGemmaReasoner, type ModelDiagnostics } from '../intelligence/localReasoner.ts';
import { runDetectionPipeline } from '../engine/pipeline.ts';
import { createDefaultPolicy, formatPartialMask } from '../engine/redaction.ts';
import { runGemmaSemanticDetection } from '../intelligence/semanticDetector.ts';
import { fuseDetectionsWithGemma, type HybridFinding, type HybridFusionMetrics } from '../intelligence/fusion.ts';
import { runPrivacyCourt, type CourtMode, type PrivacyCourtResult } from '../intelligence/privacyCourt.ts';
import type { PolicyPurpose } from '../intelligence/schemas.ts';
import { buildLocalChatTurnPrompt } from '../intelligence/prompts.ts';
import {
  IdentityBridgeRegistry,
  restoreKnownPlaceholders,
} from '../workspace/identityBridge.ts';
import { exportSanitizedCollectionZip, type SanitizedCollectionArtifact } from '../workspace/collection.ts';
import {
  IS_CLOUD_BUILD_PROFILE,
  sharedOutboundFirewall,
  type ApprovedOutboundSnapshot,
  type OutboundEnvelope,
  type ReviewBundle,
} from '../gateway/firewall.ts';
import { DirectByokGeminiTransport, RelayCloudTransport } from '../gateway/transport.ts';
import { sha256Bytes, sha256Text } from '../engine/crypto/hash.ts';
import { parseCsvSafe } from '../engine/csv/parse.ts';
import { serializeCsvSafe } from '../engine/csv/serialize.ts';
import { decodeImageToCanonicalCanvas } from '../engine/vision/decode.ts';
import { detectVisualCodes } from '../engine/vision/codes.ts';
import { runLocalOcrDetection } from '../engine/vision/ocr.ts';
import { detectFacesLocally } from '../engine/vision/face.ts';
import { exportCanvasToBytes, renderSanitizedCanvas } from '../engine/vision/render.ts';
import { createAuditReceipt } from '../engine/audit.ts';
import { SafeMarkdown } from '../components/SafeMarkdown.tsx';
import { PageHeader } from '../components/ui/PageHeader.tsx';

type ChatMode = 'local' | 'cloud';

type WorkflowPhase =
  | 'DRAFT'
  | 'SCANNING'
  | 'REVIEW_FINDINGS'
  | 'PLAN_READY'
  | 'SANITIZING'
  | 'VERIFYING'
  | 'APPROVAL_READY'
  | 'APPROVED'
  | 'SENDING'
  | 'RESPONSE_RECEIVED'
  | 'DISPLAY'
  | 'CANCELLED'
  | 'ERROR';

interface ChatAttachment {
  sourceId: string;
  revision: number;
  kind: 'txt' | 'csv' | 'image';
  safeLabel: string;
  mime: string;
  byteLength: number;
  rawText?: string;
  rawImageBytes?: Uint8Array;
  sanitizedArtifact?: SanitizedCollectionArtifact;
  sanitizedPreviewUrl?: string;
  scanSummary?: string;
}

interface ChatTurn {
  id: string;
  role: 'user' | 'assistant';
  mode: ChatMode;
  modelLabel: string;
  sanitizedContent: string;
  localRawContent?: string;
  finishReason?: string;
  usageSummary?: string;
  timestamp: string;
}

interface ConversationState {
  id: string;
  title: string;
  mode: ChatMode;
  bridge: IdentityBridgeRegistry;
  turns: ChatTurn[];
  attachments: ChatAttachment[];
  sourceRevision: number;
  policyRevision: number;
  findingsRevision: number;
  transcriptRevision: number;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin);
}

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

function createEmptyConversation(index: number, mode: ChatMode = 'local'): ConversationState {
  const id = `conv_${Date.now()}_${index}`;
  return {
    id,
    title: `Session ${index}`,
    mode,
    bridge: new IdentityBridgeRegistry(id),
    turns: [],
    attachments: [],
    sourceRevision: 1,
    policyRevision: 1,
    findingsRevision: 1,
    transcriptRevision: 1,
  };
}

export const CipherChat: React.FC = () => {
  const { cloudConfig, ephemeralApiKey, setActiveModule, setLastAuditReceipt, pushToast, announce } = useSession();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [conversations, setConversations] = useState<ConversationState[]>(() => [
    createEmptyConversation(1, 'local'),
  ]);
  const [activeConvId, setActiveConvId] = useState<string>(() => conversations[0].id);
  const [modelDiag, setModelDiag] = useState<ModelDiagnostics>(() => sharedGemmaReasoner.getStatus());

  const [draftPrompt, setDraftPrompt] = useState<string>('');
  const [purpose, setPurpose] = useState<PolicyPurpose>('technical_debugging');
  const [privacyScriptInput, setPrivacyScriptInput] = useState<string>(
    'Preserve error codes and retry counts; mask names, contact info, payment IDs, and medical context; hide faces in screenshots.',
  );
  const [courtMode, setCourtMode] = useState<CourtMode>('fast');
  const [useHybridGemma, setUseHybridGemma] = useState<boolean>(true);
  const [localAllowRawContext, setLocalAllowRawContext] = useState<boolean>(false);

  const [phase, setPhase] = useState<WorkflowPhase>('DRAFT');
  const [phaseNote, setPhaseNote] = useState<string>('Not sent');
  const [promptFindings, setPromptFindings] = useState<HybridFinding[]>([]);
  const [fusionMetrics, setFusionMetrics] = useState<HybridFusionMetrics | null>(null);
  const [courtResult, setCourtResult] = useState<PrivacyCourtResult | null>(null);
  const [sanitizedPromptPreview, setSanitizedPromptPreview] = useState<string>('');
  const [reviewBundle, setReviewBundle] = useState<ReviewBundle | null>(null);
  const [approvedSnapshot, setApprovedSnapshot] = useState<ApprovedOutboundSnapshot | null>(null);
  const [showExactPayload, setShowExactPayload] = useState<boolean>(false);
  const [revealedTurnIds, setRevealedTurnIds] = useState<Record<string, boolean>>({});
  const [streamingLocalText, setStreamingLocalText] = useState<string>('');

  const activeConv = useMemo(
    () => conversations.find((c) => c.id === activeConvId) ?? conversations[0],
    [conversations, activeConvId],
  );

  useEffect(() => {
    const unsub = sharedGemmaReasoner.subscribe(() => {
      setModelDiag(sharedGemmaReasoner.getStatus());
    });
    return () => {
      unsub();
      abortRef.current?.abort();
    };
  }, []);

  const invalidateApproval = (convId: string) => {
    sharedOutboundFirewall.invalidateConversation(convId);
    setReviewBundle(null);
    setApprovedSnapshot(null);
    setPhase('DRAFT');
    setPhaseNote('Draft modified — analyze/sanitize required before send');
  };

  const updateActiveConv = (updater: (c: ConversationState) => ConversationState) => {
    setConversations((prev) => prev.map((c) => (c.id === activeConv.id ? updater(c) : c)));
  };

  const handleNewConversation = () => {
    const next = createEmptyConversation(conversations.length + 1, activeConv.mode);
    setConversations((prev) => [...prev, next]);
    setActiveConvId(next.id);
    setDraftPrompt('');
    setPromptFindings([]);
    setFusionMetrics(null);
    setCourtResult(null);
    setSanitizedPromptPreview('');
    setReviewBundle(null);
    setApprovedSnapshot(null);
    setPhase('DRAFT');
    setPhaseNote('Not sent');
  };

  const handleSwitchMode = (nextMode: ChatMode) => {
    if (nextMode === activeConv.mode) return;
    // Trust boundary: switching from local raw chat to cloud starts a fresh isolated cloud conversation
    if (nextMode === 'cloud' && activeConv.turns.some((t) => t.mode === 'local')) {
      const freshCloud = createEmptyConversation(conversations.length + 1, 'cloud');
      setConversations((prev) => [...prev, freshCloud]);
      setActiveConvId(freshCloud.id);
      invalidateApproval(freshCloud.id);
      pushToast('info', 'Started an isolated Cloud conversation so local turns cannot leak into cloud history.');
      return;
    }
    updateActiveConv((c) => ({ ...c, mode: nextMode, policyRevision: c.policyRevision + 1 }));
    invalidateApproval(activeConv.id);
  };

  const handleAttachFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const added: ChatAttachment[] = [];

    for (const f of Array.from(files)) {
      const lower = f.name.toLowerCase();
      if (lower.endsWith('.txt') || lower.endsWith('.log') || lower.endsWith('.md')) {
        if (f.size > 2 * 1024 * 1024) {
          pushToast('error', `${f.name} exceeds 2 MiB limit.`);
          continue;
        }
        const text = (await f.text()).replace(/^\uFEFF/, '');
        added.push({
          sourceId: `src_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          revision: 1,
          kind: 'txt',
          safeLabel: `attachment_${activeConv.attachments.length + added.length + 1}.txt`,
          mime: 'text/plain',
          byteLength: f.size,
          rawText: text,
        });
      } else if (lower.endsWith('.csv')) {
        if (f.size > 5 * 1024 * 1024) {
          pushToast('error', `${f.name} exceeds 5 MiB limit.`);
          continue;
        }
        const text = await f.text();
        added.push({
          sourceId: `src_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          revision: 1,
          kind: 'csv',
          safeLabel: `attachment_${activeConv.attachments.length + added.length + 1}.csv`,
          mime: 'text/csv',
          byteLength: f.size,
          rawText: text,
        });
      } else if (lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
        if (f.size > 15 * 1024 * 1024) {
          pushToast('error', `${f.name} exceeds 15 MiB limit.`);
          continue;
        }
        const bytes = new Uint8Array(await f.arrayBuffer());
        added.push({
          sourceId: `src_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          revision: 1,
          kind: 'image',
          safeLabel: `image_${activeConv.attachments.length + added.length + 1}.${lower.endsWith('.png') ? 'png' : 'jpg'}`,
          mime: lower.endsWith('.png') ? 'image/png' : 'image/jpeg',
          byteLength: f.size,
          rawImageBytes: bytes,
        });
      } else {
        pushToast('warning', `Unsupported attachment '${f.name}'. Allowed: .txt, .csv, .png, .jpg/.jpeg.`);
      }
    }

    if (added.length > 0) {
      updateActiveConv((c) => ({
        ...c,
        attachments: [...c.attachments, ...added],
        sourceRevision: c.sourceRevision + 1,
      }));
      invalidateApproval(activeConv.id);
    }
  };

  const handleLoadSyntheticDemo = () => {
    const samplePrompt =
      'Draft an apology email regarding a fictional failed payment for Aarav Mehta (priya.sharma@example.org, +91 98765 43210, test card 4111 1111 1111 1111, invalid ref 4111 1111 1111 1112). Preserve GATEWAY_TIMEOUT and 3 retries; hide unrelated medical clinic visit context.';
    const sampleTxt =
      'Payment Support Log #TXN-9012\nCustomer: Aarav Mehta\nEmail: priya.sharma@example.org\nContext: Customer mentioned recent orthopedic surgery delay.\nError: GATEWAY_TIMEOUT after 3 retries on INR 1,450.';
    setDraftPrompt(samplePrompt);
    updateActiveConv((c) => ({
      ...c,
      attachments: [
        {
          sourceId: `demo_txt_${Date.now()}`,
          revision: 1,
          kind: 'txt',
          safeLabel: 'support_log_1.txt',
          mime: 'text/plain',
          byteLength: new TextEncoder().encode(sampleTxt).byteLength,
          rawText: sampleTxt,
        },
      ],
      sourceRevision: c.sourceRevision + 1,
    }));
    invalidateApproval(activeConv.id);
    pushToast('info', 'Loaded synthetic CipherChat payment-ticket prompt + attachment.');
  };

  const applyHybridTransformsToString = (
    text: string,
    findings: HybridFinding[],
    sourceId: string,
    plan: PrivacyCourtResult['plan'],
    bridge: IdentityBridgeRegistry,
  ): string => {
    const sorted = [...findings].filter((f) => f.included).sort((a, b) => a.start - b.start);
    const out: string[] = [];
    let cursor = 0;

    for (const f of sorted) {
      if (f.start < cursor || f.end > text.length) continue;
      out.push(text.slice(cursor, f.start));
      const tr = plan.transforms.find((t) => t.findingId === f.id);
      const action = tr?.action ?? plan.policy.defaultTextMode;

      if (action === 'preserve') {
        out.push(text.slice(f.start, f.end));
      } else if (action === 'full_mask' || action === 'suppress') {
        out.push(action === 'suppress' ? '[SUPPRESSED]' : '[REDACTED]');
      } else if (action === 'partial_mask') {
        out.push(
          formatPartialMask(
            (f.type as Parameters<typeof formatPartialMask>[0]) || 'MANUAL',
            f.rawText,
            f.canonicalKey,
            2,
          ),
        );
      } else {
        out.push(bridge.allocateOrGet(String(f.type), f.canonicalKey, f.rawText, sourceId, text));
      }
      cursor = f.end;
    }
    out.push(text.slice(cursor));
    return out.join('');
  };

  const handleAnalyzeAndSanitize = async () => {
    if (!draftPrompt.trim() && activeConv.attachments.length === 0) {
      pushToast('warning', 'Enter a prompt or attach a file before scanning.');
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setPhase('SCANNING');
    setPhaseNote('Running deterministic rules + Leak Hunter...');
    announce('CipherChat scanning prompt and attachments locally.');

    try {
      const basePolicy = createDefaultPolicy('RESEARCH');
      basePolicy.enableLeakHunter = true;

      // 1. Scan prompt text (Rules + optional Gemma semantic detection)
      const promptDet = runDetectionPipeline(draftPrompt, {
        policy: basePolicy,
        revision: activeConv.sourceRevision,
      });

      const gemmaReady = useHybridGemma && modelDiag.state === 'ready';
      let gemmaPromptRes = { grounded: [] as Awaited<ReturnType<typeof runGemmaSemanticDetection>>['grounded'], ungroundedCount: 0, incomplete: false };
      if (gemmaReady && draftPrompt.trim()) {
        setPhaseNote('Running local Gemma 3 4B semantic detection on prompt...');
        gemmaPromptRes = await runGemmaSemanticDetection(
          sharedGemmaReasoner,
          draftPrompt,
          'prompt',
          activeConv.sourceRevision,
          { signal: controller.signal, maxChunks: 4 },
        );
      }

      const fusedPrompt = fuseDetectionsWithGemma(
        draftPrompt,
        'prompt',
        activeConv.sourceRevision,
        promptDet,
        gemmaPromptRes.grounded,
        gemmaPromptRes.ungroundedCount,
        gemmaReady,
      );
      setPromptFindings(fusedPrompt.findings);
      setFusionMetrics(fusedPrompt.metrics);

      if (controller.signal.aborted) {
        setPhase('CANCELLED');
        return;
      }

      // 2. PrivacyScript + Privacy Court
      setPhase('PLAN_READY');
      const strictCloudFloor = activeConv.mode === 'cloud';
      const courtRes = await runPrivacyCourt({
        mode: courtMode,
        purpose,
        instruction: privacyScriptInput,
        findings: fusedPrompt.editFindings,
        sourceText: draftPrompt,
        strictCloudFloor,
        reasoner: gemmaReady ? sharedGemmaReasoner : undefined,
        signal: controller.signal,
        onStage: (msg) => setPhaseNote(msg),
      });
      setCourtResult(courtRes);

      if (controller.signal.aborted) {
        setPhase('CANCELLED');
        return;
      }

      // 3. Sanitize prompt & all attachments via shared Conversation Identity Bridge
      setPhase('SANITIZING');
      setPhaseNote('Applying deterministic transformations across prompt and attachments...');

      const sanPrompt = applyHybridTransformsToString(
        draftPrompt,
        fusedPrompt.editFindings,
        'prompt',
        courtRes.plan,
        activeConv.bridge,
      );
      setSanitizedPromptPreview(sanPrompt);

      const updatedAttachments: ChatAttachment[] = [];
      const textAttachmentsEnvelope: OutboundEnvelope['sanitizedAttachments'] = [];
      const imageAttachmentsEnvelope: OutboundEnvelope['sanitizedImages'] = [];

      for (const att of activeConv.attachments) {
        if (att.kind === 'txt' && att.rawText !== undefined) {
          const det = runDetectionPipeline(att.rawText, { policy: basePolicy, revision: att.revision });
          const fused = fuseDetectionsWithGemma(
            att.rawText,
            att.sourceId,
            att.revision,
            det,
            [],
            0,
            false,
          );
          const attPlan = {
            ...courtRes.plan,
            transforms: fused.editFindings.map((f) => ({
              findingId: f.id,
              type: String(f.type),
              action:
                (courtRes.plan.policy.categories[String(f.type)] as typeof courtRes.plan.policy.defaultTextMode) ??
                courtRes.plan.policy.defaultTextMode,
              reasonCode: f.reasonCode,
              overriddenByPrivacyFloor: false,
            })),
          };
          const sanTxt = applyHybridTransformsToString(
            att.rawText,
            fused.editFindings,
            att.sourceId,
            attPlan,
            activeConv.bridge,
          );
          const { bytes, sha256Hex } = await sha256Text(sanTxt);
          const artifact: SanitizedCollectionArtifact = {
            artifactId: `art_${att.sourceId}`,
            sourceId: att.sourceId,
            sourceRevision: att.revision,
            kind: 'txt',
            safeFilename: att.safeLabel,
            mime: 'text/plain',
            bytes,
            sha256: sha256Hex,
            sanitizedTextPreview: sanTxt.slice(0, 12_000),
          };
          updatedAttachments.push({
            ...att,
            sanitizedArtifact: artifact,
            scanSummary: `${fused.editFindings.length} finding(s) masked`,
          });
          textAttachmentsEnvelope.push({
            artifactId: artifact.artifactId,
            safeLabel: att.safeLabel,
            kind: 'txt',
            sanitizedText: sanTxt.slice(0, 12_000),
            sha256: sha256Hex,
          });
        } else if (att.kind === 'csv' && att.rawText !== undefined) {
          const parsed = parseCsvSafe(att.rawText);
          const sanRows = parsed.rows.map((row, rIdx) =>
            row.map((cell, cIdx) => {
              if (rIdx === 0) return cell;
              const det = runDetectionPipeline(cell, { policy: basePolicy, revision: 1 });
              if (det.accepted.length === 0) return cell;
              const fused = fuseDetectionsWithGemma(cell, `${att.sourceId}_r${rIdx}_c${cIdx}`, 1, det, [], 0, false);
              return applyHybridTransformsToString(cell, fused.editFindings, att.sourceId, courtRes.plan, activeConv.bridge);
            }),
          );
          const sanCsv = serializeCsvSafe(sanRows, {
            delimiter: parsed.diagnostics.delimiter,
            lineEnding: parsed.diagnostics.lineEnding,
          });
          const { bytes, sha256Hex } = await sha256Text(sanCsv);
          const artifact: SanitizedCollectionArtifact = {
            artifactId: `art_${att.sourceId}`,
            sourceId: att.sourceId,
            sourceRevision: att.revision,
            kind: 'csv',
            safeFilename: att.safeLabel,
            mime: 'text/csv',
            bytes,
            sha256: sha256Hex,
            sanitizedTextPreview: sanCsv.slice(0, 12_000),
          };
          updatedAttachments.push({
            ...att,
            sanitizedArtifact: artifact,
            scanSummary: `${parsed.rows.length} CSV rows scanned & masked`,
          });
          textAttachmentsEnvelope.push({
            artifactId: artifact.artifactId,
            safeLabel: att.safeLabel,
            kind: 'csv',
            sanitizedText: sanCsv.slice(0, 12_000),
            sha256: sha256Hex,
          });
        } else if (att.kind === 'image' && att.rawImageBytes) {
          const blob = new Blob([att.rawImageBytes.buffer as ArrayBuffer], { type: att.mime });
          const decoded = await decodeImageToCanonicalCanvas(blob, att.rawImageBytes);
          const qrRegions = detectVisualCodes(decoded.canvas);
          const ocrRes = await runLocalOcrDetection(decoded.canvas, basePolicy);
          let faceRegions: typeof qrRegions = [];
          try {
            faceRegions = await detectFacesLocally(decoded.canvas, 0.45);
          } catch {
            faceRegions = [];
          }
          // Strict cloud policy uses solid opaque masks on faces, OCR PII, and QR codes
          const allRegions = [...qrRegions, ...ocrRes.regions, ...faceRegions].map((r) => ({
            ...r,
            selected: true,
            effect: strictCloudFloor ? ('solid' as const) : r.effect,
          }));
          const flattened = renderSanitizedCanvas(decoded.canvas, allRegions);
          const outBytes = await exportCanvasToBytes(flattened, 'image/png');
          const outSha = await sha256Bytes(outBytes);
          if (att.sanitizedPreviewUrl) URL.revokeObjectURL(att.sanitizedPreviewUrl);
          const previewUrl = URL.createObjectURL(new Blob([outBytes.buffer as ArrayBuffer], { type: 'image/png' }));

          const artifact: SanitizedCollectionArtifact = {
            artifactId: `art_${att.sourceId}`,
            sourceId: att.sourceId,
            sourceRevision: att.revision,
            kind: 'image',
            safeFilename: att.safeLabel.replace(/\.(jpe?g)$/i, '.png'),
            mime: 'image/png',
            bytes: outBytes,
            sha256: outSha,
          };
          updatedAttachments.push({
            ...att,
            sanitizedArtifact: artifact,
            sanitizedPreviewUrl: previewUrl,
            scanSummary: `${ocrRes.regions.length} OCR, ${faceRegions.length} face(s), ${qrRegions.length} code(s) masked`,
          });
          imageAttachmentsEnvelope.push({
            artifactId: artifact.artifactId,
            safeLabel: artifact.safeFilename,
            mimeType: 'image/png',
            base64Data: bytesToBase64(outBytes),
            sha256: outSha,
            byteLength: outBytes.byteLength,
          });
        }
      }

      const nextFindingsRev = activeConv.findingsRevision + 1;
      const nextPolicyRev = activeConv.policyRevision + 1;
      updateActiveConv((c) => ({
        ...c,
        attachments: updatedAttachments,
        findingsRevision: nextFindingsRev,
        policyRevision: nextPolicyRev,
      }));

      // 4. Verify & Prepare Firewall ReviewBundle (never sends automatically!)
      setPhase('VERIFYING');
      setPhaseNote('Running outbound firewall verification...');

      const cloudSafeHistory = activeConv.turns
        .filter((t) => t.mode === 'cloud')
        .slice(-8)
        .map((t) => ({
          role: (t.role === 'user' ? 'user' : 'model') as 'user' | 'model',
          text: t.sanitizedContent,
        }));

      const envelope: OutboundEnvelope = {
        schemaVersion: 1,
        provider: 'gemini',
        model: cloudConfig.modelId || 'gemini-2.5-flash',
        systemInstruction:
          'You are a helpful professional assistant. Preserve any [[CM_...]] pseudonym placeholders verbatim without attempting to guess original identities.',
        history: cloudSafeHistory,
        currentPrompt: sanPrompt || '[See attached sanitized artifacts]',
        sanitizedAttachments: textAttachmentsEnvelope,
        sanitizedImages: imageAttachmentsEnvelope,
      };

      const hasUnresolvedCritical = fusedPrompt.findings.some(
        (f) => f.reviewRequired && f.mandatoryFloor,
      );

      const bundle = await sharedOutboundFirewall.prepareRelease({
        conversationId: activeConv.id,
        provider: 'gemini',
        model: envelope.model,
        transportMode: cloudConfig.transportMode,
        organizerPermitted: cloudConfig.organizerPermitted,
        providerTier: cloudConfig.providerTier,
        sourceRevisions: { main: activeConv.sourceRevision },
        policyRevision: nextPolicyRev,
        findingsRevision: nextFindingsRev,
        transcriptRevision: activeConv.transcriptRevision,
        scansComplete: !gemmaPromptRes.incomplete,
        hasUnresolvedCriticalFindings: hasUnresolvedCritical,
        knownOriginals: activeConv.bridge.getAllKnownOriginals(),
        envelope,
      });

      setReviewBundle(bundle);
      setApprovedSnapshot(null);
      setPhase('APPROVAL_READY');
      setPhaseNote(
        activeConv.mode === 'local'
          ? 'Local sanitization verified — ready for Private Gemma chat'
          : bundle.canApprove
            ? 'Verified & ready for explicit outbound approval'
            : `Cloud send blocked: ${bundle.blockedReasons[0]}`,
      );
    } catch (err) {
      setPhase('ERROR');
      setPhaseNote(err instanceof Error ? err.message : 'Analysis failed');
      pushToast('error', err instanceof Error ? err.message : 'Scan failed.');
    }
  };

  const handleSendLocalChat = async () => {
    if (modelDiag.state !== 'ready') {
      pushToast('warning', 'Local Gemma 3 4B is not loaded. Open Local AI & Cloud Setup to load weights.');
      return;
    }
    const useSanitized = !localAllowRawContext;
    if (useSanitized && !sanitizedPromptPreview && draftPrompt.trim()) {
      pushToast('info', 'Run Analyze / Sanitize first so sanitized context is verified.');
      return;
    }

    const promptText = useSanitized ? sanitizedPromptPreview || draftPrompt : draftPrompt;
    const contextText = activeConv.attachments
      .map((a) =>
        useSanitized
          ? a.sanitizedArtifact?.sanitizedTextPreview || ''
          : a.rawText || '',
      )
      .filter(Boolean)
      .join('\n\n');

    const localHistory = activeConv.turns
      .filter((t) => t.mode === 'local')
      .map((t) => ({
        role: t.role,
        content: useSanitized ? t.sanitizedContent : t.localRawContent || t.sanitizedContent,
      }));

    const omittedTurns = Math.max(0, localHistory.length - 6);
    const contextBudgetLimit = 1800;
    const omittedContextChars = Math.max(0, contextText.length - contextBudgetLimit);
    if (omittedTurns > 0 || omittedContextChars > 0) {
      pushToast(
        'info',
        `Context budget applied: ${omittedTurns} older turn(s) and ${omittedContextChars} trailing context char(s) omitted to fit Gemma window.`,
      );
    }

    const fullPrompt = buildLocalChatTurnPrompt(promptText, contextText || undefined, localHistory);
    const controller = new AbortController();
    abortRef.current = controller;

    setPhase('SENDING');
    setStreamingLocalText('');
    setPhaseNote('Generating local Gemma 3 4B response...');

    const userTurn: ChatTurn = {
      id: `turn_u_${Date.now()}`,
      role: 'user',
      mode: 'local',
      modelLabel: 'Local User',
      sanitizedContent: sanitizedPromptPreview || '[Local Turn]',
      localRawContent: draftPrompt,
      timestamp: new Date().toISOString(),
    };

    const res = await sharedGemmaReasoner.run(
      { jobId: `chat_${Date.now()}`, task: 'private_chat', prompt: fullPrompt, maxOutputTokens: 700 },
      {
        signal: controller.signal,
        onPartial: (partial) => setStreamingLocalText(partial),
      },
    );

    setStreamingLocalText('');
    if (res.status === 'completed') {
      const assistantTurn: ChatTurn = {
        id: `turn_a_${Date.now()}`,
        role: 'assistant',
        mode: 'local',
        modelLabel: 'Gemma 3 4B (Local WebGPU)',
        sanitizedContent: res.text,
        timestamp: new Date().toISOString(),
      };
      updateActiveConv((c) => ({
        ...c,
        turns: [...c.turns, userTurn, assistantTurn],
        transcriptRevision: c.transcriptRevision + 1,
      }));
      setDraftPrompt('');
      setPhase('DISPLAY');
      setPhaseNote(`Local response received in ${res.elapsedMs} ms`);
    } else if (res.status === 'cancelled') {
      setPhase('CANCELLED');
      setPhaseNote('Local generation cancelled.');
    } else {
      setPhase('ERROR');
      setPhaseNote(res.errorMessage || 'Local Gemma generation error');
      pushToast('error', res.errorMessage || 'Local Gemma error.');
    }
  };

  const handleApproveAndSendCloud = async () => {
    if (!reviewBundle) return;
    try {
      const snapshot = sharedOutboundFirewall.approveRelease(reviewBundle.reviewId, true, {
        conversationId: activeConv.id,
        sourceRevisions: { main: activeConv.sourceRevision },
        policyRevision: activeConv.policyRevision,
        findingsRevision: activeConv.findingsRevision,
        transcriptRevision: activeConv.transcriptRevision,
        model: reviewBundle.model,
      });
      setApprovedSnapshot(snapshot);
      setPhase('APPROVED');

      const controller = new AbortController();
      abortRef.current = controller;
      setPhase('SENDING');
      setPhaseNote(`Sending approved sanitized payload to ${snapshot.model}...`);

      const transport =
        cloudConfig.transportMode === 'direct-byok'
          ? new DirectByokGeminiTransport(() => ephemeralApiKey)
          : new RelayCloudTransport();

      const cloudRes = await sharedOutboundFirewall.sendApproved(
        snapshot.approvalId,
        transport,
        {
          conversationId: activeConv.id,
          sourceRevisions: { main: activeConv.sourceRevision },
          policyRevision: activeConv.policyRevision,
          findingsRevision: activeConv.findingsRevision,
          transcriptRevision: activeConv.transcriptRevision,
          model: snapshot.model,
        },
        controller.signal,
      );

      if (cloudRes.status === 'completed') {
        const userTurn: ChatTurn = {
          id: `turn_cu_${Date.now()}`,
          role: 'user',
          mode: 'cloud',
          modelLabel: 'Approved Outbound Prompt',
          sanitizedContent: sanitizedPromptPreview || '[Sanitized Attachments]',
          timestamp: new Date().toISOString(),
        };
        const assistantTurn: ChatTurn = {
          id: `turn_ca_${Date.now()}`,
          role: 'assistant',
          mode: 'cloud',
          modelLabel: cloudRes.model,
          sanitizedContent: cloudRes.text,
          finishReason: cloudRes.finishReason,
          usageSummary: cloudRes.usageSummary,
          timestamp: new Date().toISOString(),
        };
        updateActiveConv((c) => ({
          ...c,
          turns: [...c.turns, userTurn, assistantTurn],
          transcriptRevision: c.transcriptRevision + 1,
        }));
        setDraftPrompt('');
        setReviewBundle(null);
        setApprovedSnapshot(null);
        setPhase('DISPLAY');
        setPhaseNote(`Gemini received sanitized content (${snapshot.payloadByteLength} bytes).`);
      } else {
        setPhase('ERROR');
        setPhaseNote(cloudRes.errorMessage || 'Cloud request failed');
        pushToast('error', cloudRes.errorMessage || 'Cloud request failed.');
      }
    } catch (err) {
      setPhase('ERROR');
      setPhaseNote(err instanceof Error ? err.message : 'Outbound firewall blocked send');
      pushToast('error', err instanceof Error ? err.message : 'Send failed.');
    }
  };

  const handleExportCollectionZip = async () => {
    const artifacts = activeConv.attachments
      .map((a) => a.sanitizedArtifact)
      .filter((a): a is SanitizedCollectionArtifact => Boolean(a));

    if (sanitizedPromptPreview) {
      const { bytes, sha256Hex } = await sha256Text(sanitizedPromptPreview);
      artifacts.unshift({
        artifactId: 'prompt_sanitized',
        sourceId: 'prompt',
        sourceRevision: activeConv.sourceRevision,
        kind: 'text',
        safeFilename: 'sanitized_prompt.txt',
        mime: 'text/plain',
        bytes,
        sha256: sha256Hex,
      });
    }

    if (artifacts.length === 0) {
      pushToast('warning', 'Run Analyze / Sanitize first to produce sanitized artifacts.');
      return;
    }

    const totalBytes = artifacts.reduce((acc, a) => acc + a.bytes.byteLength, 0);
    const placeholderReceipt = await createAuditReceipt({
      inputFormat: 'paste',
      inputByteSize: totalBytes,
      outputFormat: 'application/zip',
      outputBytes: new Uint8Array([0]),
      policyPreset: 'CUSTOM',
      defaultMode: 'PSEUDONYM',
      enabledMethods: ['rules', 'leak_hunter', ...(useHybridGemma && modelDiag.state === 'ready' ? ['gemma_3_4b'] : [])],
      counts: {
        totalDetected: fusionMetrics?.finalFindingCount ?? 0,
        uniqueEntities: fusionMetrics?.uniqueIdentitiesCount ?? 0,
        applied: fusionMetrics?.finalFindingCount ?? 0,
        excluded: 0,
        rejected: fusionMetrics?.ungroundedRejectedCount ?? 0,
        uncertain: 0,
        byType: {},
      },
      durationsMs: { detection: 0, redaction: 0 },
      statusLabel: 'Sanitized collection ZIP prepared',
      remainingFindings: 0,
      limitations: ['Collection ZIP excludes original files, raw filenames, vaults, and local restoration text.'],
      offlineAssetStatus: { gemma: modelDiag.state },
    });

    const zipBytes = await exportSanitizedCollectionZip(artifacts, placeholderReceipt);
    const zipSha = await sha256Bytes(zipBytes);
    const finalReceipt = { ...placeholderReceipt, outputByteSize: zipBytes.byteLength, outputSha256: zipSha };
    setLastAuditReceipt(finalReceipt);
    triggerDownload(`ciphermask-sanitized-collection-${zipSha.slice(0, 8)}.zip`, zipBytes, 'application/zip');
    pushToast('success', `Exported sanitized ZIP (${artifacts.length} file(s), SHA-256 ${zipSha.slice(0, 10)}…).`);
  };

  return (
    <div className="space-y-8 ae-fade-in">
      <PageHeader
        eyebrow="Autonomous AI Privacy Firewall"
        title="CipherChat"
        description="Converse safely using device-local Gemma 3 4B or sanitized cloud relays governed by PrivacyScript, Privacy Court, and Identity Bridge."
        actions={
          <div className="flex items-center gap-2.5">
            <span
              data-testid="chat-workflow-phase"
              className="rounded-full border border-[#C7D2FE] bg-[#EEF2FF] px-3.5 py-1.5 font-mono text-xs font-semibold text-[#4338CA]"
            >
              {phase}
            </span>
            <button
              type="button"
              data-testid="chat-load-demo-btn"
              onClick={handleLoadSyntheticDemo}
              className="ae-btn-secondary inline-flex items-center gap-2 rounded-xl px-4 h-10 text-sm text-[#087F6D] border-[#087F6D]/30 bg-[#E1F5EF]/50 hover:bg-[#E1F5EF] cursor-pointer"
            >
              <Sparkles className="w-4 h-4" />
              <span>Demo Scenario</span>
            </button>
          </div>
        }
      />

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* Left Conversation Sidebar */}
        <aside className="xl:col-span-2 ae-card p-4 flex flex-col gap-4">
          <button
            type="button"
            data-testid="chat-new-conv-btn"
            onClick={handleNewConversation}
            className="ae-btn-primary inline-flex items-center justify-center gap-2 rounded-xl px-4 h-11 text-sm cursor-pointer"
          >
            <Plus className="w-4 h-4" /> New Chat
          </button>

          <div className="space-y-1.5 flex-1 overflow-y-auto max-h-96">
            {conversations.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => {
                  setActiveConvId(c.id);
                  invalidateApproval(c.id);
                }}
                className={`w-full text-left rounded-xl px-3 py-2.5 text-sm border transition cursor-pointer ${
                  c.id === activeConv.id
                    ? 'border-[#087F6D]/35 bg-[#E1F5EF] text-[#101828]'
                    : 'border-transparent hover:bg-[#F7F9FC] text-[#475569]'
                }`}
              >
                <div className="font-semibold truncate">{c.title}</div>
                <div className="text-xs flex items-center gap-1.5 mt-0.5 text-[#64748B]">
                  {c.mode === 'local' ? (
                    <Cpu className="w-3.5 h-3.5 text-[#087F6D]" />
                  ) : (
                    <Cloud className="w-3.5 h-3.5 text-[#6366F1]" />
                  )}
                  <span>{c.mode === 'local' ? 'Private Local' : 'Protected Cloud'}</span>
                </div>
              </button>
            ))}
          </div>

          <div className="border-t border-[#EDF0F4] pt-3.5 text-xs space-y-1.5">
            <div className="font-semibold text-[#101828]">Shared Identity Bridge</div>
            <div className="font-mono text-[#087F6D] font-medium">{activeConv.bridge.size()} session token(s)</div>
            <button
              type="button"
              onClick={() => setActiveModule('setup')}
              className="text-[#475569] hover:text-[#087F6D] underline cursor-pointer text-left font-medium"
            >
              Gemma: {modelDiag.state.toUpperCase()}
            </button>
          </div>
        </aside>

        {/* Center Conversation & Composer */}
        <section className="xl:col-span-6 flex flex-col gap-5">
          {/* Trust Boundary Mode Switcher */}
          <div className="ae-card p-3 flex flex-wrap items-center justify-between gap-3">
            <div className="inline-flex rounded-xl border border-[#E2E8F0] bg-[#F7F9FC] p-1 gap-1 w-full sm:w-auto">
              <button
                type="button"
                data-testid="chat-mode-local"
                onClick={() => handleSwitchMode('local')}
                className={`flex-1 sm:flex-none inline-flex items-center justify-center gap-2 rounded-lg px-4 h-10 text-sm font-semibold transition-all cursor-pointer ${
                  activeConv.mode === 'local'
                    ? 'bg-[#FFFFFF] text-[#087F6D] border border-[#E2E8F0] shadow-2xs'
                    : 'text-[#475569] border border-transparent hover:text-[#101828]'
                }`}
              >
                <Lock className="w-4 h-4" />
                <span>Private AI / Local (Gemma 3 4B)</span>
              </button>
              <button
                type="button"
                data-testid="chat-mode-cloud"
                onClick={() => handleSwitchMode('cloud')}
                className={`flex-1 sm:flex-none inline-flex items-center justify-center gap-2 rounded-lg px-4 h-10 text-sm font-semibold transition-all cursor-pointer ${
                  activeConv.mode === 'cloud'
                    ? 'bg-[#FFFFFF] text-[#4338CA] border border-[#C7D2FE] shadow-2xs'
                    : 'text-[#475569] border border-transparent hover:text-[#101828]'
                }`}
              >
                <Cloud className="w-4 h-4" />
                <span>Protected Cloud (Gemini)</span>
              </button>
            </div>
          </div>

          {/* Spacious Conversation Canvas */}
          <div className="ae-card p-6 space-y-5 min-h-[300px] max-h-[460px] overflow-y-auto">
            {activeConv.turns.length === 0 && !streamingLocalText ? (
              <div className="h-56 flex flex-col items-center justify-center text-center px-6 space-y-3">
                <div className="w-12 h-12 rounded-2xl bg-[#EEF2FF] text-[#6366F1] flex items-center justify-center">
                  <MessageSquareLock className="w-6 h-6" />
                </div>
                <p className="text-[#101828] font-semibold text-lg">
                  {activeConv.mode === 'local'
                    ? 'Private Local AI Workspace — Zero External Requests'
                    : 'Protected Cloud Firewall — Explicit Approval Required'}
                </p>
                <p className="max-w-lg text-[15px] leading-relaxed text-[#475569]">
                  Write your prompt, attach TXT/CSV/PNG/JPEG files, customize your PrivacyScript instruction, and click <strong>Analyze / Sanitize</strong> before anything leaves the browser.
                </p>
              </div>
            ) : (
              <>
                {activeConv.turns.map((t) => {
                  const isRevealed = Boolean(revealedTurnIds[t.id]);
                  const restored =
                    t.role === 'assistant' && isRevealed
                      ? restoreKnownPlaceholders(t.sanitizedContent, activeConv.bridge)
                      : null;

                  return (
                    <div
                      key={t.id}
                      className={`rounded-2xl p-4 sm:p-5 space-y-2.5 ${
                        t.role === 'user'
                          ? 'bg-[#F7F9FC] border border-[#E2E8F0] ml-4 sm:ml-8'
                          : 'bg-[#FFFFFF] border border-[#087F6D]/25 mr-4 sm:mr-8 shadow-2xs'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2 text-xs text-[#64748B]">
                        <span className="font-semibold text-[#101828]">{t.modelLabel}</span>
                        <span className="font-mono">
                          {t.mode === 'cloud' ? 'Cloud-Safe Transcript' : 'Local-Only'}
                          {t.usageSummary ? ` | ${t.usageSummary}` : ''}
                        </span>
                      </div>

                      <SafeMarkdown content={t.sanitizedContent} />

                      {t.role === 'assistant' && activeConv.bridge.size() > 0 && (
                        <div className="pt-2 border-t border-[#EDF0F4] flex flex-wrap items-center justify-between gap-2">
                          <button
                            type="button"
                            onClick={() =>
                              setRevealedTurnIds((prev) => ({ ...prev, [t.id]: !prev[t.id] }))
                            }
                            className="inline-flex items-center gap-1.5 text-sm font-medium text-[#087F6D] hover:underline cursor-pointer"
                          >
                            {isRevealed ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                            {isRevealed ? 'Hide Local Restoration' : 'Reveal Known Placeholders Locally'}
                          </button>
                        </div>
                      )}

                      {restored && (
                        <div className="rounded-xl border border-[#FDE68A] bg-[#FFFBEB] p-3.5 space-y-1.5">
                          <div className="text-xs font-semibold text-[#B45309]">
                            Local-Only Restored View ({restored.restoredCount} placeholder(s) restored — NEVER sent to cloud)
                          </div>
                          <SafeMarkdown content={restored.restoredText} />
                          {restored.unknownPlaceholders.length > 0 && (
                            <div className="text-xs text-[#B45309] font-mono">
                              Unknown placeholders left unchanged: {restored.unknownPlaceholders.join(', ')}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}

                {streamingLocalText && (
                  <div className="rounded-2xl border border-[#C7D2FE] bg-[#EEF2FF]/45 p-5 mr-8 space-y-2">
                    <div className="text-xs font-semibold text-[#4338CA]">Gemma 3 4B (Streaming locally...)</div>
                    <SafeMarkdown content={streamingLocalText} />
                  </div>
                )}
              </>
            )}
          </div>

          {/* PrivacyScript Policy & Composer */}
          <div className="ae-card p-5 sm:p-6 space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <select
                aria-label="Sharing purpose"
                value={purpose}
                onChange={(e) => {
                  setPurpose(e.target.value as PolicyPurpose);
                  invalidateApproval(activeConv.id);
                }}
                className="ae-input px-3.5 h-11 text-sm font-medium"
              >
                <option value="technical_debugging">Purpose: Technical Debugging</option>
                <option value="customer_support">Purpose: Customer Support</option>
                <option value="research_analytics">Purpose: Research / Analytics</option>
                <option value="public_sharing">Purpose: Public Sharing</option>
                <option value="general_assistance">Purpose: General Assistance</option>
                <option value="custom">Purpose: Custom</option>
              </select>

              <div className="sm:col-span-2 flex items-center gap-2">
                <input
                  type="text"
                  aria-label="PrivacyScript policy objective"
                  value={privacyScriptInput}
                  onChange={(e) => {
                    setPrivacyScriptInput(e.target.value);
                    invalidateApproval(activeConv.id);
                  }}
                  placeholder="PrivacyScript objective (e.g., Preserve error codes; hide names and health details)..."
                  className="ae-input flex-1 px-3.5 h-11 text-sm"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
              <div className="flex flex-wrap items-center gap-4">
                <label className="inline-flex items-center gap-2 cursor-pointer text-[#475569] font-medium">
                  <input
                    type="checkbox"
                    checked={useHybridGemma}
                    onChange={(e) => setUseHybridGemma(e.target.checked)}
                    className="h-4 w-4 accent-[#6366F1]"
                  />
                  <span>Hybrid Rules + Gemma ({modelDiag.state === 'ready' ? 'Ready' : 'Rule Fallback'})</span>
                </label>

                <div className="inline-flex items-center gap-1.5 text-[#475569]">
                  <Scale className="w-4 h-4 text-[#6366F1]" />
                  <span className="font-medium">Court:</span>
                  {(['fast', 'deep'] as CourtMode[]).map((cm) => (
                    <button
                      key={cm}
                      type="button"
                      onClick={() => setCourtMode(cm)}
                      className={`rounded-lg px-2.5 py-1 border text-xs font-semibold capitalize cursor-pointer transition-colors ${
                        courtMode === cm
                          ? 'border-[#C7D2FE] bg-[#EEF2FF] text-[#4338CA]'
                          : 'border-[#E2E8F0] bg-white text-[#64748B]'
                      }`}
                    >
                      {cm}
                    </button>
                  ))}
                </div>
              </div>

              {activeConv.mode === 'local' && (
                <label className="inline-flex items-center gap-2 cursor-pointer text-[#B45309] text-xs font-medium">
                  <input
                    type="checkbox"
                    checked={localAllowRawContext}
                    onChange={(e) => setLocalAllowRawContext(e.target.checked)}
                    className="h-4 w-4 accent-[#B45309]"
                  />
                  <span>Local-only raw context (never cloud)</span>
                </label>
              )}
            </div>

            {activeConv.attachments.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {activeConv.attachments.map((att) => (
                  <div
                    key={att.sourceId}
                    className="inline-flex items-center gap-2 rounded-lg border border-[#E2E8F0] bg-[#F7F9FC] px-3 py-1.5 text-xs"
                  >
                    <Paperclip className="w-3.5 h-3.5 text-[#087F6D]" />
                    <span className="font-mono font-medium text-[#101828]">{att.safeLabel}</span>
                    {att.scanSummary && <span className="text-[#15803D] font-medium">({att.scanSummary})</span>}
                    <button
                      type="button"
                      aria-label={`Remove ${att.safeLabel}`}
                      onClick={() => {
                        updateActiveConv((c) => ({
                          ...c,
                          attachments: c.attachments.filter((a) => a.sourceId !== att.sourceId),
                          sourceRevision: c.sourceRevision + 1,
                        }));
                        invalidateApproval(activeConv.id);
                      }}
                      className="text-[#64748B] hover:text-[#DC2626] cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <textarea
              data-testid="chat-composer-input"
              value={draftPrompt}
              onChange={(e) => {
                setDraftPrompt(e.target.value);
                if (phase !== 'DRAFT') invalidateApproval(activeConv.id);
              }}
              onKeyDown={(e) => {
                // Enter never bypasses sanitization/approval! Ctrl+Enter initiates local Analyze / Sanitize only.
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  handleAnalyzeAndSanitize();
                }
              }}
              rows={4}
              placeholder="Write a prompt with sensitive context or attach files... (Enter adds newline; Ctrl+Enter runs local Analyze / Sanitize)"
              className="ae-input w-full p-4 font-mono text-[14px] leading-relaxed placeholder-[#94A3B8] resize-y"
            />

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2.5">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept=".txt,.csv,.png,.jpg,.jpeg"
                  className="hidden"
                  onChange={(e) => {
                    handleAttachFiles(e.target.files);
                    e.target.value = '';
                  }}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="ae-btn-secondary inline-flex items-center gap-2 rounded-xl px-4 h-11 text-sm cursor-pointer"
                >
                  <Paperclip className="w-4 h-4 text-[#087F6D]" /> Attach File
                </button>

                <button
                  type="button"
                  data-testid="chat-sanitize-btn"
                  disabled={phase === 'SCANNING' || phase === 'SANITIZING'}
                  onClick={handleAnalyzeAndSanitize}
                  className="ae-btn-primary inline-flex items-center gap-2 rounded-xl px-5 h-11 text-[15px] disabled:opacity-45 cursor-pointer"
                >
                  <ShieldCheck className="w-4 h-4" /> Analyze / Sanitize
                </button>

                {(phase === 'SCANNING' || phase === 'SENDING') && (
                  <button
                    type="button"
                    onClick={() => abortRef.current?.abort()}
                    className="ae-btn-danger inline-flex items-center gap-1.5 rounded-xl px-3.5 h-11 text-sm cursor-pointer"
                  >
                    <XCircle className="w-4 h-4" /> Cancel
                  </button>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2.5">
                <button
                  type="button"
                  data-testid="chat-export-zip-btn"
                  onClick={handleExportCollectionZip}
                  className="ae-btn-secondary inline-flex items-center gap-2 rounded-xl px-4 h-11 text-sm cursor-pointer"
                >
                  <FileArchive className="w-4 h-4 text-[#087F6D]" /> Export Sanitized ZIP
                </button>

                {activeConv.mode === 'local' && (
                  <button
                    type="button"
                    data-testid="chat-send-local-btn"
                    disabled={modelDiag.state !== 'ready' || phase === 'SENDING'}
                    onClick={handleSendLocalChat}
                    className="ae-btn-indigo inline-flex items-center gap-2 rounded-xl px-4 h-11 text-sm disabled:opacity-45 cursor-pointer"
                  >
                    <Cpu className="w-4 h-4" /> Send to Local Gemma
                  </button>
                )}
              </div>
            </div>
          </div>
        </section>

        {/* Right Privacy Firewall & Intelligence Inspector */}
        <aside className="xl:col-span-4 ae-card p-5 space-y-4 text-sm overflow-y-auto max-h-[82vh]">
          <div className="border-b border-[#EDF0F4] pb-3 space-y-0.5">
            <h2 className="text-lg font-semibold text-[#101828]">Privacy Firewall &amp; Review</h2>
            <p className="text-xs text-[#64748B] truncate">{phaseNote}</p>
          </div>

          {/* 1. Detection Provenance */}
          {fusionMetrics && (
            <div className="ae-well p-4 space-y-2">
              <div className="text-sm font-semibold text-[#101828]">1. Detection Provenance</div>
              <div className="grid grid-cols-3 gap-2 font-mono text-xs text-[#475569]">
                <div>Rules: <span className="font-semibold text-[#087F6D]">{fusionMetrics.ruleFindingsCount}</span></div>
                <div>Gemma: <span className="font-semibold text-[#4338CA]">{fusionMetrics.gemmaGroundedCount}</span></div>
                <div>Both: <span className="font-semibold text-[#2563EB]">{fusionMetrics.overlapCount}</span></div>
                <div>AI-Only: <span className="font-semibold text-[#101828]">{fusionMetrics.aiOnlyAdditions}</span></div>
                <div>Ungrounded: <span className="font-semibold text-[#DC2626]">{fusionMetrics.ungroundedRejectedCount}</span></div>
                <div>Unique: <span className="font-semibold text-[#101828]">{fusionMetrics.uniqueIdentitiesCount}</span></div>
              </div>
            </div>
          )}

          {/* Grounded Findings List */}
          {promptFindings.length > 0 && (
            <div className="ae-well p-4 space-y-2 max-h-44 overflow-y-auto">
              <div className="text-sm font-semibold text-[#101828]">Prompt Findings ({promptFindings.length})</div>
              {promptFindings.map((f) => (
                <div key={f.id} className="flex items-center justify-between gap-2 border-t border-[#E2E8F0] pt-2 font-mono text-xs">
                  <span className="font-semibold text-[#087F6D]">{f.type}</span>
                  <span className="text-[#475569] truncate">{f.maskedPreview}</span>
                  <span className="rounded-md border border-[#E2E8F0] bg-white px-2 py-0.5 text-[11px] text-[#475569]">
                    {f.provenanceLabel}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* 2. PrivacyScript & Court Timeline */}
          {courtResult && (
            <div className="rounded-xl border border-[#C7D2FE] bg-[#EEF2FF]/45 p-4 space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-[#312E81]">
                  2. PrivacyScript &amp; Court ({courtResult.mode.toUpperCase()})
                </span>
                <span className="font-mono text-[11px] text-[#4338CA]">{courtResult.plan.compilerSource}</span>
              </div>
              <div className="space-y-2 border-l-2 border-[#C7D2FE] pl-3">
                {courtResult.stages.map((s, i) => (
                  <div key={i} className="text-xs text-[#334155]">
                    <span className="font-semibold capitalize text-[#4338CA]">{s.stage.replace('_', ' ')}</span>{' '}
                    <span className="text-[#64748B]">({s.status})</span>: {s.summary}
                  </div>
                ))}
              </div>
              {courtResult.plan.warnings.length > 0 && (
                <div className="rounded-lg border border-[#FDE68A] bg-[#FFFBEB] p-2.5 text-xs text-[#B45309]">
                  {courtResult.plan.warnings.join(' | ')}
                </div>
              )}
            </div>
          )}

          {/* Sanitized Prompt Preview */}
          {sanitizedPromptPreview && (
            <div className="rounded-xl border border-[#087F6D]/30 bg-[#E1F5EF]/45 p-4 space-y-2">
              <div className="text-sm font-semibold text-[#087F6D]">Sanitized Prompt Preview</div>
              <pre
                data-testid="chat-sanitized-preview"
                className="font-mono text-[13px] leading-relaxed whitespace-pre-wrap text-[#101828] max-h-40 overflow-y-auto"
              >
                {sanitizedPromptPreview}
              </pre>
            </div>
          )}

          {/* 3. Outbound Payload Review & Explicit Approval */}
          {reviewBundle && (
            <div className="ae-well p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-[#101828]">3. Outbound Payload Review</span>
                <span className="font-mono text-xs text-[#64748B]">{reviewBundle.payloadByteLength} B</span>
              </div>

              <div className="font-mono text-xs text-[#64748B] space-y-0.5">
                <div>Destination: {reviewBundle.provider} / {reviewBundle.model} ({reviewBundle.transportMode})</div>
                <div className="truncate">SHA-256: {reviewBundle.payloadHash}</div>
                <div>Attachments: {reviewBundle.attachmentHashes.length}</div>
              </div>

              {reviewBundle.blockedReasons.length > 0 && (
                <div
                  data-testid="chat-firewall-blocked"
                  className="rounded-xl border border-[#FECACA] bg-[#FEF2F2] p-3 text-xs text-[#DC2626] space-y-1"
                >
                  <div className="flex items-center gap-1.5 font-semibold">
                    <ShieldAlert className="w-4 h-4 shrink-0" />
                    <span>Outbound Cloud Send Blocked</span>
                  </div>
                  {reviewBundle.blockedReasons.map((r, i) => (
                    <p key={i}>{r}</p>
                  ))}
                </div>
              )}

              {reviewBundle.verificationWarnings.length > 0 && (
                <div className="rounded-xl border border-[#FDE68A] bg-[#FFFBEB] p-3 text-xs text-[#B45309] flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{reviewBundle.verificationWarnings.join(' ')}</span>
                </div>
              )}

              <button
                type="button"
                onClick={() => setShowExactPayload((v) => !v)}
                className="text-[#087F6D] font-medium underline text-xs cursor-pointer"
              >
                {showExactPayload ? 'Hide Exact Serialized JSON' : 'Inspect Exact Serialized JSON Body'}
              </button>

              {showExactPayload && (
                <pre
                  data-testid="chat-exact-outbound-json"
                  className="rounded-xl border border-[#E2E8F0] bg-white p-3 font-mono text-xs whitespace-pre-wrap max-h-44 overflow-y-auto text-[#101828]"
                >
                  {reviewBundle.exactSerializedBody}
                </pre>
              )}

              {activeConv.attachments.some((a) => a.sanitizedPreviewUrl) && (
                <div className="space-y-1.5">
                  <div className="text-xs font-medium text-[#64748B]">Sanitized Image Bytes Preview:</div>
                  <div className="grid grid-cols-2 gap-2">
                    {activeConv.attachments
                      .filter((a) => a.sanitizedPreviewUrl)
                      .map((a) => (
                        <img
                          key={a.sourceId}
                          src={a.sanitizedPreviewUrl}
                          alt={`Sanitized ${a.safeLabel}`}
                          className="rounded-xl border border-[#E2E8F0] w-full h-auto"
                        />
                      ))}
                  </div>
                </div>
              )}

              {activeConv.mode === 'cloud' && (
                <button
                  type="button"
                  data-testid="chat-approve-send-btn"
                  disabled={!reviewBundle.canApprove || !IS_CLOUD_BUILD_PROFILE || phase === 'SENDING'}
                  onClick={handleApproveAndSendCloud}
                  className="ae-btn-primary w-full inline-flex items-center justify-center gap-2 rounded-xl px-4 h-11 text-sm disabled:opacity-45 cursor-pointer"
                >
                  <Send className="w-4 h-4" />
                  {approvedSnapshot ? 'Sending Approved Snapshot...' : 'Approve & Send Sanitized Payload'}
                </button>
              )}

              {activeConv.mode === 'local' && reviewBundle.canApprove === false && (
                <div className="flex items-center gap-2 text-xs font-medium text-[#15803D]">
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                  <span>Local sanitization ready. Copy sanitized text, export ZIP, or load Gemma 3 4B for offline chat.</span>
                </div>
              )}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
};
