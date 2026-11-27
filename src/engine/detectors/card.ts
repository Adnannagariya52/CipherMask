import type { DetectionCandidate } from '../types.ts';
import { validateLuhn } from '../validators/luhn.ts';

// Capture full 13–19 digit sequences with spaces or hyphens, bounded by non-digits
const CARD_RE = /(?<!\d)(\d(?:[ -]?\d){12,18})(?!\d)/g;

export function detectCards(
  text: string,
  conservativeMaskInvalid = false,
): { accepted: DetectionCandidate[]; rejected: DetectionCandidate[] } {
  const accepted: DetectionCandidate[] = [];
  const rejected: DetectionCandidate[] = [];

  CARD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CARD_RE.exec(text)) !== null) {
    const raw = m[1];
    const start = m.index;
    const end = start + raw.length;
    const luhn = validateLuhn(raw);

    if (luhn.valid) {
      accepted.push({
        id: `card_${start}_${end}`,
        type: 'CARD',
        start,
        end,
        rawText: raw,
        maskedPreview: '',
        canonicalKey: luhn.digits,
        method: 'checksum',
        validationStatus: 'checksum_valid',
        evidence: luhn.reason,
        reviewStatus: 'included',
      });
    } else {
      rejected.push({
        id: `card_rej_${start}_${end}`,
        type: 'CARD',
        start,
        end,
        rawText: raw,
        maskedPreview: '',
        canonicalKey: luhn.digits,
        method: 'checksum',
        validationStatus: conservativeMaskInvalid ? 'uncertain' : 'rejected',
        evidence: luhn.reason,
        reviewStatus: conservativeMaskInvalid ? 'pending' : 'excluded',
      });
    }
  }

  return { accepted, rejected };
}
