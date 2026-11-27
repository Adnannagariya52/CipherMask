import type {
  DetectionCandidate,
  DetectionResult,
  EntityType,
  RedactionOutput,
  RedactionPolicy,
  TransformationRecord,
} from './types.ts';
import { buildNormalizedView, mapNormalizedSpanToOriginal, spanRequiredNormalization } from './normalization.ts';
import { detectEmails, detectObfuscatedEmails } from './detectors/email.ts';
import { detectPhones } from './detectors/phone.ts';
import { detectIps } from './detectors/ip.ts';
import { detectPans } from './detectors/pan.ts';
import { detectAadhaars } from './detectors/aadhaar.ts';
import { detectCards } from './detectors/card.ts';
import { resolveCandidates } from './resolver.ts';
import { SessionPseudonymAllocator } from './pseudonyms.ts';
import { computeReplacement, formatPartialMask, resolveCandidateDecision } from './redaction.ts';
import { verifySanitizedOutput } from './verification.ts';

function previewMaskForInspector(type: EntityType, rawText: string, canonicalKey: string): string {
  if (type === 'PERSON' || type === 'LOCATION' || type === 'ORGANIZATION' || type === 'MANUAL') {
    return rawText.length <= 2 ? '**' : `${rawText[0]}***${rawText[rawText.length - 1]}`;
  }
  return formatPartialMask(type, rawText, canonicalKey, 2);
}

export interface DetectTextOptions {
  revision?: number;
  policy: RedactionPolicy;
  nerCandidates?: DetectionCandidate[];
}

export function runDetectionPipeline(text: string, options: DetectTextOptions): DetectionResult {
  const startMs = performance.now();
  const { policy, revision = 1, nerCandidates = [] } = options;

  const acceptedPool: DetectionCandidate[] = [];
  const rejectedPool: DetectionCandidate[] = [];

  // 1. Primary deterministic detectors on original text
  acceptedPool.push(...detectEmails(text));
  acceptedPool.push(...detectPhones(text));

  const ipRes = detectIps(text);
  acceptedPool.push(...ipRes.accepted);
  rejectedPool.push(...ipRes.rejected);

  acceptedPool.push(...detectPans(text));

  const aadhaarRes = detectAadhaars(text, policy.conservativeMaskInvalid);
  acceptedPool.push(...aadhaarRes.accepted);
  rejectedPool.push(...aadhaarRes.rejected);

  const cardRes = detectCards(text, policy.conservativeMaskInvalid);
  acceptedPool.push(...cardRes.accepted);
  rejectedPool.push(...cardRes.rejected);

  // 2. Leak Hunter normalized & obfuscation pass
  if (policy.enableLeakHunter) {
    for (const obf of detectObfuscatedEmails(text)) {
      acceptedPool.push(obf);
    }

    const normView = buildNormalizedView(text);
    if (normView.wasTransformed) {
      const normAccepted: DetectionCandidate[] = [
        ...detectEmails(normView.normalized),
        ...detectPhones(normView.normalized),
        ...detectIps(normView.normalized).accepted,
        ...detectPans(normView.normalized),
        ...detectAadhaars(normView.normalized, policy.conservativeMaskInvalid).accepted,
        ...detectCards(normView.normalized, policy.conservativeMaskInvalid).accepted,
      ];

      for (const hit of normAccepted) {
        if (!spanRequiredNormalization(normView, hit.start, hit.end)) continue;
        const origSpan = mapNormalizedSpanToOriginal(normView, hit.start, hit.end);
        if (!origSpan) continue;
        acceptedPool.push({
          ...hit,
          id: `leak_${hit.type.toLowerCase()}_${origSpan.start}_${origSpan.end}`,
          start: origSpan.start,
          end: origSpan.end,
          rawText: text.slice(origSpan.start, origSpan.end),
          method: 'leak_hunter',
          evidence: `${hit.evidence} (Detected after Leak Hunter Unicode/invisible-char normalization.)`,
          fromLeakHunter: true,
        });
      }
    }
  }

  // 3. Optional local NER candidates (never override structured rule detections)
  if (policy.enableNer && nerCandidates.length > 0) {
    for (const ner of nerCandidates) {
      if (ner.start >= 0 && ner.end > ner.start && ner.end <= text.length) {
        acceptedPool.push(ner);
      }
    }
  }

  // 4. User manual spans
  for (const ms of policy.manualSpans) {
    if (ms.start >= 0 && ms.end > ms.start && ms.end <= text.length) {
      const slice = text.slice(ms.start, ms.end);
      acceptedPool.push({
        id: ms.id,
        type: ms.type || 'MANUAL',
        start: ms.start,
        end: ms.end,
        rawText: slice,
        maskedPreview: '',
        canonicalKey: slice,
        method: 'manual',
        validationStatus: 'structurally_valid',
        evidence: ms.label || 'Manually marked sensitive span.',
        reviewStatus: 'included',
      });
    }
  }

  // 5. Resolve overlaps deterministically
  const resolved = resolveCandidates(text, acceptedPool, rejectedPool);

  // 6. Populate safe masked previews & counts
  const countsByType: Partial<Record<EntityType, number>> = {};
  const uniqueKeys = new Set<string>();

  for (const c of resolved.accepted) {
    c.maskedPreview = previewMaskForInspector(c.type, c.rawText, c.canonicalKey);
    countsByType[c.type] = (countsByType[c.type] ?? 0) + 1;
    uniqueKeys.add(`${c.type}::${c.canonicalKey}`);
  }
  for (const c of resolved.uncertain) {
    c.maskedPreview = previewMaskForInspector(c.type, c.rawText, c.canonicalKey);
  }
  for (const c of resolved.rejected) {
    c.maskedPreview = previewMaskForInspector(c.type, c.rawText, c.canonicalKey);
  }

  return {
    revision,
    accepted: resolved.accepted,
    rejected: resolved.rejected,
    uncertain: resolved.uncertain,
    durationMs: Number((performance.now() - startMs).toFixed(2)),
    countsByType,
    totalAcceptedOccurrences: resolved.accepted.length,
    uniqueAcceptedCount: uniqueKeys.size,
  };
}

export function applyRedactionPolicy(
  text: string,
  detection: DetectionResult,
  policy: RedactionPolicy,
  sharedAllocator?: SessionPseudonymAllocator,
): RedactionOutput {
  const startMs = performance.now();
  const allocator = sharedAllocator ?? new SessionPseudonymAllocator(text);

  // Merge accepted + any uncertain items that the user explicitly included via override
  const actionable: DetectionCandidate[] = [...detection.accepted];
  for (const u of detection.uncertain) {
    const ov = policy.entityOverrides[u.id];
    if (ov?.reviewStatus === 'included' || (ov?.mode && ov.mode !== 'KEEP')) {
      actionable.push(u);
    }
  }
  // Include rejected items only if user explicitly overrode to include them
  for (const r of detection.rejected) {
    const ov = policy.entityOverrides[r.id];
    if (ov?.reviewStatus === 'included') {
      actionable.push(r);
    }
  }

  actionable.sort((a, b) => a.start - b.start || a.end - b.end);

  const chunks: string[] = [];
  const transformations: TransformationRecord[] = [];
  let cursor = 0;
  let outCursor = 0;
  let appliedCount = 0;
  let excludedCount = 0;

  for (const cand of actionable) {
    if (cand.start < cursor) {
      // Safety guard against overlapping manual/override spans
      continue;
    }
    const unchanged = text.slice(cursor, cand.start);
    chunks.push(unchanged);
    outCursor += unchanged.length;

    const decision = resolveCandidateDecision(cand, policy);
    const origSlice = text.slice(cand.start, cand.end);

    if (!decision.included || decision.mode === 'KEEP') {
      chunks.push(origSlice);
      transformations.push({
        candidateId: cand.id,
        type: cand.type,
        mode: 'KEEP',
        origStart: cand.start,
        origEnd: cand.end,
        outStart: outCursor,
        outEnd: outCursor + origSlice.length,
        replacement: origSlice,
        originalSlice: origSlice,
        canonicalKey: cand.canonicalKey,
        applied: false,
      });
      outCursor += origSlice.length;
      excludedCount += 1;
    } else {
      const replacement = computeReplacement(
        cand,
        decision.mode,
        allocator,
        policy.phonePartialKeepDigits,
      );
      chunks.push(replacement);
      transformations.push({
        candidateId: cand.id,
        type: cand.type,
        mode: decision.mode,
        origStart: cand.start,
        origEnd: cand.end,
        outStart: outCursor,
        outEnd: outCursor + replacement.length,
        replacement,
        originalSlice: origSlice,
        canonicalKey: cand.canonicalKey,
        applied: true,
      });
      outCursor += replacement.length;
      appliedCount += 1;
    }

    cursor = cand.end;
  }

  const tail = text.slice(cursor);
  chunks.push(tail);

  const sanitizedText = chunks.join('');
  const allCombined = [...detection.accepted, ...detection.uncertain, ...detection.rejected];
  const verification = verifySanitizedOutput(sanitizedText, allCombined, transformations, policy);

  return {
    sanitizedText,
    transformations,
    appliedCount,
    excludedCount,
    pseudonymCount: allocator.size(),
    verification,
    durationMs: Number((performance.now() - startMs).toFixed(2)),
  };
}
