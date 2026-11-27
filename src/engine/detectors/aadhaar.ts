import type { DetectionCandidate } from '../types.ts';
import { validateAadhaar } from '../validators/verhoeff.ts';

// 12 digits optionally grouped 4-4-4 by single space or hyphen, bounded so not part of longer number
const AADHAAR_RE = /(?<!\d)(\d{4}(?:[ -]?\d{4}){2})(?!\d)/g;

export function detectAadhaars(
  text: string,
  conservativeMaskInvalid = false,
): { accepted: DetectionCandidate[]; rejected: DetectionCandidate[] } {
  const accepted: DetectionCandidate[] = [];
  const rejected: DetectionCandidate[] = [];

  AADHAAR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = AADHAAR_RE.exec(text)) !== null) {
    const raw = m[1];
    const start = m.index;
    const end = start + raw.length;
    const res = validateAadhaar(raw);

    if (res.valid) {
      accepted.push({
        id: `aadhaar_${start}_${end}`,
        type: 'AADHAAR',
        start,
        end,
        rawText: raw,
        maskedPreview: '',
        canonicalKey: res.digits,
        method: 'checksum',
        validationStatus: 'checksum_valid',
        evidence: res.reason,
        reviewStatus: 'included',
      });
    } else {
      // Only report as rejected Aadhaar candidate if it starts with 2-9 or has Aadhaar separators
      const hasSeparators = /[ -]/.test(raw);
      const startsValid = res.digits[0] >= '2' && res.digits[0] <= '9';
      if (startsValid || hasSeparators) {
        rejected.push({
          id: `aadhaar_rej_${start}_${end}`,
          type: 'AADHAAR',
          start,
          end,
          rawText: raw,
          maskedPreview: '',
          canonicalKey: res.digits,
          method: 'checksum',
          validationStatus: conservativeMaskInvalid ? 'uncertain' : 'rejected',
          evidence: res.reason,
          reviewStatus: conservativeMaskInvalid ? 'pending' : 'excluded',
        });
      }
    }
  }

  return { accepted, rejected };
}
