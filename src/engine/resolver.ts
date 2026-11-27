import type { DetectionCandidate, EntityType } from './types.ts';

const TYPE_PRIORITY: Record<EntityType, number> = {
  MANUAL: 100,
  CARD: 92,
  AADHAAR: 90,
  IPV6: 88,
  EMAIL: 86,
  PAN: 84,
  IPV4: 82,
  PHONE: 78,
  CONTEXT_ID: 65,
  PERSON: 55,
  LOCATION: 52,
  ORGANIZATION: 50,
  FACE: 90,
  PERSON_REGION: 80,
  QR: 90,
  BARCODE: 88,
  METADATA: 80,
};

function validationWeight(c: DetectionCandidate): number {
  switch (c.validationStatus) {
    case 'checksum_valid':
      return 40;
    case 'structurally_valid':
      return 30;
    case 'pattern_match':
      return 20;
    case 'uncertain':
      return 10;
    case 'rejected':
      return 0;
  }
}

function hasContextLabelHint(text: string, c: DetectionCandidate): boolean {
  const before = text.slice(Math.max(0, c.start - 24), c.start).toLowerCase();
  if (c.type === 'CARD') return /\b(?:card|cc|visa|mastercard|rupay|debit|credit)\b/.test(before);
  if (c.type === 'AADHAAR') return /\b(?:aadhaar|aadhar|uidai|uid)\b/.test(before);
  if (c.type === 'PAN') return /\b(?:pan|tax)\b/.test(before);
  if (c.type === 'PHONE') return /\b(?:phone|tel|mob|mobile|call|whatsapp|contact)\b/.test(before);
  if (c.type === 'EMAIL') return /\b(?:email|mail|e-mail)\b/.test(before);
  if (c.type === 'IPV4' || c.type === 'IPV6') return /\b(?:ip|addr|host|server|client)\b/.test(before);
  return false;
}

function scoreCandidate(text: string, c: DetectionCandidate): number {
  const base = TYPE_PRIORITY[c.type] ?? 50;
  const val = validationWeight(c);
  const labelBonus = hasContextLabelHint(text, c) ? 25 : 0;
  const len = c.end - c.start;
  return base * 1000 + val * 100 + labelBonus * 10 + Math.min(len, 99);
}

function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && a.end > b.start;
}

function isNumericSubstringInsideRejected(
  c: DetectionCandidate,
  rejectedNumericRuns: DetectionCandidate[],
): boolean {
  if (c.type !== 'PHONE' && c.type !== 'AADHAAR' && c.type !== 'CARD') return false;
  return rejectedNumericRuns.some(
    (rej) =>
      c.start >= rej.start &&
      c.end <= rej.end &&
      (c.end - c.start < rej.end - rej.start || c.type === 'PHONE'),
  );
}

export interface ResolveResult {
  accepted: DetectionCandidate[];
  rejected: DetectionCandidate[];
  uncertain: DetectionCandidate[];
}

export function resolveCandidates(
  text: string,
  rawAcceptedAndUncertain: DetectionCandidate[],
  rawRejected: DetectionCandidate[],
): ResolveResult {
  // Deduplicate rejected candidates by exact span + type
  const rejectedMap = new Map<string, DetectionCandidate>();
  for (const r of rawRejected) {
    const key = `${r.type}:${r.start}:${r.end}`;
    if (!rejectedMap.has(key)) rejectedMap.set(key, r);
  }
  const rejectedNumericRuns = Array.from(rejectedMap.values()).filter(
    (r) => r.type === 'CARD' || r.type === 'AADHAAR' || r.type === 'IPV4',
  );

  // Filter out shorter numeric matches nested inside a rejected full numeric card/aadhaar run
  const filteredPool = rawAcceptedAndUncertain.filter(
    (c) => !isNumericSubstringInsideRejected(c, rejectedNumericRuns),
  );

  // Sort deterministically by score descending, then longer span, then earlier start
  const sorted = [...filteredPool].sort((a, b) => {
    const sa = scoreCandidate(text, a);
    const sb = scoreCandidate(text, b);
    if (sb !== sa) return sb - sa;
    const la = a.end - a.start;
    const lb = b.end - b.start;
    if (lb !== la) return lb - la;
    return a.start - b.start;
  });

  const chosen: DetectionCandidate[] = [];
  for (const cand of sorted) {
    if (cand.start < 0 || cand.end <= cand.start || cand.end > text.length) continue;
    const conflicting = chosen.find((existing) => overlaps(existing, cand));
    if (!conflicting) {
      chosen.push(cand);
    } else if (
      // Exact same span or partial overlap between two plausible NER/context spans is skipped cleanly;
      // if an unchosen candidate had identical span & same strength, mark uncertain only if not already resolved by higher-priority validator
      cand.type === 'MANUAL'
    ) {
      chosen.push(cand);
    }
  }

  // Also ensure rejected candidates don't duplicate an already-accepted span or leak as substrings inside a longer CARD run
  const allCardRuns = [
    ...chosen.filter((c) => c.type === 'CARD'),
    ...Array.from(rejectedMap.values()).filter((r) => r.type === 'CARD'),
  ];
  const finalRejected = Array.from(rejectedMap.values()).filter((rej) => {
    if (chosen.some((acc) => acc.start === rej.start && acc.end === rej.end)) return false;
    if (
      rej.type === 'AADHAAR' &&
      allCardRuns.some((card) => rej.start >= card.start && rej.end <= card.end && rej.end - rej.start < card.end - card.start)
    ) {
      return false;
    }
    return true;
  });

  chosen.sort((a, b) => a.start - b.start || a.end - b.end);
  finalRejected.sort((a, b) => a.start - b.start || a.end - b.end);

  const accepted: DetectionCandidate[] = [];
  const uncertain: DetectionCandidate[] = [];

  for (const c of chosen) {
    if (c.validationStatus === 'uncertain') {
      uncertain.push(c);
    } else {
      accepted.push(c);
    }
  }

  return { accepted, rejected: finalRejected, uncertain };
}
