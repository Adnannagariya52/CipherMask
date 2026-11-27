import type {
  DetectionCandidate,
  RedactionPolicy,
  TransformationRecord,
  VerificationFinding,
  VerificationReport,
} from './types.ts';
import { detectEmails, detectObfuscatedEmails } from './detectors/email.ts';
import { detectPhones } from './detectors/phone.ts';
import { detectIps } from './detectors/ip.ts';
import { detectPans } from './detectors/pan.ts';
import { detectAadhaars } from './detectors/aadhaar.ts';
import { detectCards } from './detectors/card.ts';
import { buildNormalizedView, mapNormalizedSpanToOriginal } from './normalization.ts';

/**
 * Independent secondary scan over the sanitized text + comparison against planned transformations.
 * Never reports "100% safe" or "guaranteed anonymous"; accurately reports "No supported patterns detected by enabled checks"
 * or surfaces any remaining, excluded, partial-retained, or uncertain findings.
 */
export function verifySanitizedOutput(
  sanitizedText: string,
  allCandidates: DetectionCandidate[],
  transformations: TransformationRecord[],
  policy: RedactionPolicy,
): VerificationReport {
  const findings: VerificationFinding[] = [];

  // 1. Track deliberate exclusions and partial retentions
  let excludedCount = 0;
  let partialRetainedCount = 0;
  let pendingCount = 0;

  for (const t of transformations) {
    if (!t.applied) {
      excludedCount += 1;
      findings.push({
        id: `excl_${t.candidateId}`,
        severity: 'warning',
        kind: 'deliberate_exclusion',
        message: `${t.type} occurrence at offset ${t.origStart}–${t.origEnd} was excluded from masking.`,
        start: t.outStart,
        end: t.outEnd,
        type: t.type,
      });
    } else if (t.mode === 'PARTIAL') {
      partialRetainedCount += 1;
    }
  }

  if (partialRetainedCount > 0) {
    findings.push({
      id: 'partial_notice',
      severity: 'info',
      kind: 'partial_retention',
      message: `${partialRetainedCount} item(s) use Partial Mask mode, which intentionally retains suffix or prefix characters.`,
    });
  }

  for (const c of allCandidates) {
    const override = policy.entityOverrides[c.id];
    const effectiveStatus = override?.reviewStatus ?? c.reviewStatus;
    if (c.validationStatus === 'uncertain' && effectiveStatus === 'pending') {
      pendingCount += 1;
    }
  }
  if (pendingCount > 0) {
    findings.push({
      id: 'pending_uncertain',
      severity: 'warning',
      kind: 'unreviewed_uncertain',
      message: `${pendingCount} uncertain candidate(s) remain unreviewed in original input.`,
    });
  }

  // 2. Build set of planned output replacement intervals so we distinguish newly introduced / remaining patterns
  // from legitimate partial masks or generated pseudonyms.
  const replacementSpans = transformations
    .filter((t) => t.applied)
    .map((t) => ({ start: t.outStart, end: t.outEnd, mode: t.mode, type: t.type }));

  const isInsidePartialMask = (start: number, end: number) =>
    replacementSpans.some((r) => r.mode === 'PARTIAL' && start >= r.start && end <= r.end);

  // 3. Rescan sanitized output using primary detectors + normalized Leak Hunter pass
  const residualCandidates: DetectionCandidate[] = [
    ...detectEmails(sanitizedText),
    ...detectPhones(sanitizedText),
    ...detectIps(sanitizedText).accepted,
    ...detectPans(sanitizedText),
    ...detectAadhaars(sanitizedText, false).accepted,
    ...detectCards(sanitizedText, false).accepted,
  ];

  if (policy.enableLeakHunter) {
    const normView = buildNormalizedView(sanitizedText);
    for (const o of detectObfuscatedEmails(sanitizedText)) {
      residualCandidates.push(o);
    }
    if (normView.wasTransformed) {
      const normHits = [
        ...detectEmails(normView.normalized),
        ...detectPans(normView.normalized),
        ...detectAadhaars(normView.normalized, false).accepted,
        ...detectCards(normView.normalized, false).accepted,
      ];
      for (const h of normHits) {
        const mapped = mapNormalizedSpanToOriginal(normView, h.start, h.end);
        if (!mapped) continue;
        residualCandidates.push({
          ...h,
          id: `res_norm_${mapped.start}_${mapped.end}`,
          start: mapped.start,
          end: mapped.end,
          rawText: sanitizedText.slice(mapped.start, mapped.end),
          fromLeakHunter: true,
        });
      }
    }
  }

  const seenResidual = new Set<string>();
  let remainingCount = 0;
  for (const rc of residualCandidates) {
    if (isInsidePartialMask(rc.start, rc.end)) continue;
    const key = `${rc.type}:${rc.start}:${rc.end}`;
    if (seenResidual.has(key)) continue;
    seenResidual.add(key);

    // Check if this span corresponds to an intentional exclusion
    const matchedExclusion = transformations.find(
      (t) => !t.applied && rc.start >= t.outStart && rc.end <= t.outEnd,
    );
    if (matchedExclusion) continue;

    remainingCount += 1;
    findings.push({
      id: `rem_${key}`,
      severity: 'risk',
      kind: rc.fromLeakHunter ? 'leak_hunter_residual' : 'remaining_pattern',
      message: `${rc.fromLeakHunter ? 'Leak Hunter residual' : 'Remaining'} ${rc.type} pattern detected in sanitized output (${rc.start}–${rc.end}).`,
      start: rc.start,
      end: rc.end,
      type: rc.type,
    });
  }

  const cleanByEnabledChecks = remainingCount === 0 && excludedCount === 0 && pendingCount === 0;
  let statusLabel = 'No supported patterns detected by enabled checks';
  if (remainingCount > 0) {
    statusLabel = `${remainingCount} remaining pattern(s) detected in output`;
  } else if (excludedCount > 0 || pendingCount > 0) {
    statusLabel = `Output checked; ${excludedCount} excluded, ${pendingCount} pending review`;
  }

  return {
    cleanByEnabledChecks,
    statusLabel,
    findings,
    remainingCount,
    excludedCount,
    partialRetainedCount,
    pendingCount,
    checkedAtMs: Date.now(),
  };
}
