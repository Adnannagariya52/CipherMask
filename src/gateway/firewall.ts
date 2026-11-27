import { z } from 'zod';
import { sha256Bytes, sha256Text } from '../engine/crypto/hash.ts';
import { runDetectionPipeline } from '../engine/pipeline.ts';
import { createDefaultPolicy } from '../engine/redaction.ts';
import { detectImageSignature } from '../engine/vision/decode.ts';
import { buildNormalizedView } from '../engine/normalization.ts';

export const IS_CLOUD_BUILD_PROFILE = import.meta.env.VITE_CLOUD_PROFILE === 'enabled';

export const OutboundMessageSchema = z
  .object({
    role: z.enum(['user', 'model']),
    text: z.string().min(1).max(32_000),
  })
  .strict();

export const OutboundImageAttachmentSchema = z
  .object({
    artifactId: z.string().min(1).max(64),
    safeLabel: z.string().min(1).max(80),
    mimeType: z.enum(['image/png', 'image/jpeg']),
    base64Data: z.string().min(16).max(6_000_000),
    sha256: z.string().length(64),
    byteLength: z.number().int().positive().max(4_500_000),
  })
  .strict();

export const OutboundEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    provider: z.literal('gemini'),
    model: z.string().min(3).max(80),
    systemInstruction: z.string().max(1000),
    history: z.array(OutboundMessageSchema).max(20),
    currentPrompt: z.string().min(1).max(24_000),
    sanitizedAttachments: z
      .array(
        z
          .object({
            artifactId: z.string().min(1).max(64),
            safeLabel: z.string().min(1).max(80),
            kind: z.enum(['text', 'txt', 'csv']),
            sanitizedText: z.string().max(40_000),
            sha256: z.string().length(64),
          })
          .strict(),
      )
      .max(8),
    sanitizedImages: z.array(OutboundImageAttachmentSchema).max(4),
  })
  .strict();

export type OutboundEnvelope = z.infer<typeof OutboundEnvelopeSchema>;

export interface ReleaseDraftInput {
  conversationId: string;
  provider: 'gemini';
  model: string;
  transportMode: 'relay' | 'direct-byok';
  organizerPermitted: boolean;
  providerTier: 'unpaid-demo' | 'authorized-paid';
  sourceRevisions: Record<string, number>;
  policyRevision: number;
  findingsRevision: number;
  transcriptRevision: number;
  scansComplete: boolean;
  hasUnresolvedCriticalFindings: boolean;
  knownOriginals: string[];
  envelope: OutboundEnvelope;
}

export interface ReviewBundle {
  reviewId: string;
  conversationId: string;
  provider: 'gemini';
  model: string;
  transportMode: 'relay' | 'direct-byok';
  exactSerializedBody: string;
  payloadHash: string;
  payloadByteLength: number;
  attachmentHashes: string[];
  sourceRevisions: Record<string, number>;
  policyRevision: number;
  findingsRevision: number;
  transcriptRevision: number;
  verificationWarnings: string[];
  blockedReasons: string[];
  canApprove: boolean;
  createdAtMs: number;
}

export interface ApprovedOutboundSnapshot {
  approvalId: string;
  reviewId: string;
  conversationId: string;
  provider: 'gemini';
  model: string;
  transportMode: 'relay' | 'direct-byok';
  exactSerializedBody: string;
  payloadHash: string;
  payloadByteLength: number;
  attachmentHashes: string[];
  sourceRevisions: Record<string, number>;
  policyRevision: number;
  findingsRevision: number;
  transcriptRevision: number;
  createdAtMs: number;
  expiresAtMs: number;
  consumed: boolean;
}

export interface CloudAuditEvent {
  approvalId: string;
  provider: string;
  model: string;
  timestamp: string;
  payloadHash: string;
  payloadByteLength: number;
  attachmentCount: number;
  attachmentHashes: string[];
  status: 'sent' | 'failed' | 'cancelled' | 'blocked';
  errorNote?: string;
}

export interface CloudResult {
  status: 'completed' | 'error' | 'cancelled';
  text: string;
  model: string;
  finishReason?: string;
  usageSummary?: string;
  errorMessage?: string;
}

export interface CloudTransport {
  send(snapshot: ApprovedOutboundSnapshot, signal: AbortSignal): Promise<CloudResult>;
}

const APPROVAL_TTL_MS = 5 * 60 * 1000;

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

/**
 * Single enforced Outbound Privacy Firewall & Release Controller.
 * No UI component or chat view may call fetch() or @google/genai directly.
 */
export class OutboundPrivacyFirewall {
  private readonly pendingReviews = new Map<string, ReviewBundle>();
  private readonly approvals = new Map<string, ApprovedOutboundSnapshot>();
  private readonly auditLog: CloudAuditEvent[] = [];

  async prepareRelease(draft: ReleaseDraftInput): Promise<ReviewBundle> {
    const blockedReasons: string[] = [];
    const verificationWarnings: string[] = [];

    if (!IS_CLOUD_BUILD_PROFILE) {
      blockedReasons.push('Strict-local build profile active: cloud outbound transport is compiled disabled.');
    }
    if (!draft.organizerPermitted) {
      blockedReasons.push('Organizer/user cloud permission has not been enabled.');
    }
    if (!draft.scansComplete) {
      blockedReasons.push('Required local scans are incomplete or failed.');
    }
    if (draft.hasUnresolvedCriticalFindings) {
      blockedReasons.push('Unresolved high-risk findings remain; resolve or mask before cloud approval.');
    }

    const parsedEnv = OutboundEnvelopeSchema.safeParse(draft.envelope);
    if (!parsedEnv.success) {
      blockedReasons.push(
        `Outbound envelope schema invalid: ${parsedEnv.error.issues.map((i) => i.message).slice(0, 3).join('; ')}`,
      );
    }

    // Scan entire outbound text envelope (system + history + currentPrompt + sanitizedAttachments)
    const combinedOutboundText = [
      draft.envelope.systemInstruction,
      ...draft.envelope.history.map((h) => h.text),
      draft.envelope.currentPrompt,
      ...draft.envelope.sanitizedAttachments.map((a) => a.sanitizedText),
    ].join('\n');

    const policy = createDefaultPolicy('AI_SAFE');
    policy.enableLeakHunter = true;
    const rescan = runDetectionPipeline(combinedOutboundText, { policy, revision: 1 });
    if (rescan.accepted.length > 0) {
      const types = Array.from(new Set(rescan.accepted.map((a) => a.type))).join(', ');
      blockedReasons.push(
        `Outbound firewall detected ${rescan.accepted.length} remaining mandatory pattern(s) (${types}) in candidate payload.`,
      );
    }

    // Check against known original raw values from volatile Identity Bridge (normalized comparison)
    const normOutbound = buildNormalizedView(combinedOutboundText).normalized.toLowerCase();
    for (const orig of draft.knownOriginals) {
      const normOrig = buildNormalizedView(orig).normalized.trim().toLowerCase();
      if (normOrig.length >= 4 && normOutbound.includes(normOrig)) {
        blockedReasons.push('Outbound firewall detected an unmasked original session value inside candidate payload.');
        break;
      }
    }

    // Bind every reviewed artifact to its declared hash before approval. This prevents
    // a stale or substituted attachment from being approved under a previous review.
    for (const attachment of draft.envelope.sanitizedAttachments) {
      const actualHash = (await sha256Text(attachment.sanitizedText)).sha256Hex;
      if (actualHash !== attachment.sha256) {
        blockedReasons.push(`Text attachment ${attachment.safeLabel} hash mismatch.`);
      }
    }

    // Verify sanitized images have valid signatures, sizes, and content hashes.
    for (const img of draft.envelope.sanitizedImages) {
      try {
        const bytes = base64ToBytes(img.base64Data);
        const sig = detectImageSignature(bytes);
        if (sig !== img.mimeType) {
          blockedReasons.push(`Image attachment ${img.safeLabel} signature mismatch.`);
        }
        if (bytes.byteLength !== img.byteLength) {
          blockedReasons.push(`Image attachment ${img.safeLabel} byte length mismatch.`);
        }
        if ((await sha256Bytes(bytes)) !== img.sha256) {
          blockedReasons.push(`Image attachment ${img.safeLabel} hash mismatch.`);
        }
      } catch {
        blockedReasons.push(`Image attachment ${img.safeLabel} invalid base64 payload.`);
      }
    }

    if (draft.providerTier === 'unpaid-demo') {
      verificationWarnings.push(
        'Unpaid/free demo tier selected: send ONLY synthetic or public non-confidential examples.',
      );
    }

    const exactSerializedBody = JSON.stringify(draft.envelope);
    const { sha256Hex } = await sha256Text(exactSerializedBody);
    const reviewId = `rev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const attachmentHashes = [
      ...draft.envelope.sanitizedAttachments.map((a) => a.sha256),
      ...draft.envelope.sanitizedImages.map((i) => i.sha256),
    ];

    const bundle: ReviewBundle = {
      reviewId,
      conversationId: draft.conversationId,
      provider: draft.provider,
      model: draft.model,
      transportMode: draft.transportMode,
      exactSerializedBody,
      payloadHash: sha256Hex,
      payloadByteLength: new TextEncoder().encode(exactSerializedBody).byteLength,
      attachmentHashes,
      sourceRevisions: { ...draft.sourceRevisions },
      policyRevision: draft.policyRevision,
      findingsRevision: draft.findingsRevision,
      transcriptRevision: draft.transcriptRevision,
      verificationWarnings,
      blockedReasons,
      canApprove: blockedReasons.length === 0,
      createdAtMs: Date.now(),
    };

    this.pendingReviews.set(reviewId, bundle);
    return bundle;
  }

  approveRelease(
    reviewId: string,
    explicitUserConfirmation: boolean,
    currentState: {
      conversationId: string;
      sourceRevisions: Record<string, number>;
      policyRevision: number;
      findingsRevision: number;
      transcriptRevision: number;
      model: string;
    },
  ): ApprovedOutboundSnapshot {
    if (!explicitUserConfirmation) {
      throw new Error('Explicit user confirmation is required before approving outbound send.');
    }
    const bundle = this.pendingReviews.get(reviewId);
    if (!bundle) {
      throw new Error('Review bundle not found or invalidated.');
    }
    if (!bundle.canApprove) {
      throw new Error(`Cannot approve blocked payload: ${bundle.blockedReasons.join(' ')}`);
    }
    if (bundle.conversationId !== currentState.conversationId) {
      throw new Error('Conversation changed since review; approval rejected.');
    }
    if (
      bundle.policyRevision !== currentState.policyRevision ||
      bundle.findingsRevision !== currentState.findingsRevision ||
      bundle.transcriptRevision !== currentState.transcriptRevision ||
      bundle.model !== currentState.model ||
      JSON.stringify(bundle.sourceRevisions) !== JSON.stringify(currentState.sourceRevisions)
    ) {
      throw new Error('Source, policy, findings, model, or transcript changed after review; rescan required.');
    }

    this.pendingReviews.delete(reviewId);
    const now = Date.now();
    const snapshot: ApprovedOutboundSnapshot = {
      approvalId: `appr_${now}_${Math.random().toString(36).slice(2, 8)}`,
      reviewId,
      conversationId: bundle.conversationId,
      provider: bundle.provider,
      model: bundle.model,
      transportMode: bundle.transportMode,
      exactSerializedBody: bundle.exactSerializedBody,
      payloadHash: bundle.payloadHash,
      payloadByteLength: bundle.payloadByteLength,
      attachmentHashes: bundle.attachmentHashes,
      sourceRevisions: bundle.sourceRevisions,
      policyRevision: bundle.policyRevision,
      findingsRevision: bundle.findingsRevision,
      transcriptRevision: bundle.transcriptRevision,
      createdAtMs: now,
      expiresAtMs: now + APPROVAL_TTL_MS,
      consumed: false,
    };

    this.approvals.set(snapshot.approvalId, snapshot);
    return snapshot;
  }

  invalidateConversation(conversationId: string): void {
    for (const [id, b] of this.pendingReviews.entries()) {
      if (b.conversationId === conversationId) this.pendingReviews.delete(id);
    }
    for (const [id, a] of this.approvals.entries()) {
      if (a.conversationId === conversationId) this.approvals.delete(id);
    }
  }

  async sendApproved(
    approvalId: string,
    transport: CloudTransport,
    currentState: {
      conversationId: string;
      sourceRevisions: Record<string, number>;
      policyRevision: number;
      findingsRevision: number;
      transcriptRevision: number;
      model: string;
    },
    signal: AbortSignal,
  ): Promise<CloudResult> {
    if (!IS_CLOUD_BUILD_PROFILE) {
      throw new Error('Strict-local build forbids outbound cloud requests.');
    }
    const snapshot = this.approvals.get(approvalId);
    if (!snapshot) {
      throw new Error('No valid approval snapshot found.');
    }
    if (snapshot.consumed) {
      throw new Error('Approval snapshot has already been consumed; create a fresh approval to send again.');
    }
    if (Date.now() > snapshot.expiresAtMs) {
      this.approvals.delete(approvalId);
      throw new Error('Approval snapshot expired; re-review and approve again.');
    }
    if (
      snapshot.conversationId !== currentState.conversationId ||
      snapshot.policyRevision !== currentState.policyRevision ||
      snapshot.findingsRevision !== currentState.findingsRevision ||
      snapshot.transcriptRevision !== currentState.transcriptRevision ||
      snapshot.model !== currentState.model ||
      JSON.stringify(snapshot.sourceRevisions) !== JSON.stringify(currentState.sourceRevisions)
    ) {
      this.approvals.delete(approvalId);
      throw new Error('State became stale after approval; sending blocked.');
    }

    // Re-verify exact body integrity
    const { sha256Hex } = await sha256Text(snapshot.exactSerializedBody);
    if (sha256Hex !== snapshot.payloadHash) {
      throw new Error('Outbound payload hash mismatch.');
    }

    // Atomically mark consumed BEFORE network call so concurrent double-clicks cannot send twice
    snapshot.consumed = true;

    try {
      const result = await transport.send(snapshot, signal);
      this.auditLog.push({
        approvalId: snapshot.approvalId,
        provider: snapshot.provider,
        model: snapshot.model,
        timestamp: new Date().toISOString(),
        payloadHash: snapshot.payloadHash,
        payloadByteLength: snapshot.payloadByteLength,
        attachmentCount: snapshot.attachmentHashes.length,
        attachmentHashes: snapshot.attachmentHashes,
        status: result.status === 'completed' ? 'sent' : result.status === 'cancelled' ? 'cancelled' : 'failed',
        errorNote: result.errorMessage,
      });
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.auditLog.push({
        approvalId: snapshot.approvalId,
        provider: snapshot.provider,
        model: snapshot.model,
        timestamp: new Date().toISOString(),
        payloadHash: snapshot.payloadHash,
        payloadByteLength: snapshot.payloadByteLength,
        attachmentCount: snapshot.attachmentHashes.length,
        attachmentHashes: snapshot.attachmentHashes,
        status: signal.aborted ? 'cancelled' : 'failed',
        errorNote: msg,
      });
      throw err;
    }
  }

  getAuditEvents(): CloudAuditEvent[] {
    return [...this.auditLog];
  }

  clearAll(): void {
    this.pendingReviews.clear();
    this.approvals.clear();
    this.auditLog.length = 0;
  }
}

export const sharedOutboundFirewall = new OutboundPrivacyFirewall();
