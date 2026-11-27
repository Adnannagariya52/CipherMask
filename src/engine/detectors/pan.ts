import type { DetectionCandidate } from '../types.ts';

// Indian Permanent Account Number: 5 letters, 4 digits, 1 letter, bounded by non-alphanumeric
const PAN_RE = /(?<![A-Za-z0-9])([A-Za-z]{5}[0-9]{4}[A-Za-z])(?![A-Za-z0-9])/g;

const HOLDER_TYPE_CODES = new Set(['P', 'C', 'H', 'A', 'B', 'G', 'J', 'L', 'F', 'T']);

export function detectPans(text: string): DetectionCandidate[] {
  const results: DetectionCandidate[] = [];
  PAN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;

  while ((m = PAN_RE.exec(text)) !== null) {
    const raw = m[1];
    const start = m.index;
    const end = start + raw.length;
    const upper = raw.toUpperCase();
    const holderChar = upper[3];
    const knownHolderType = HOLDER_TYPE_CODES.has(holderChar);

    results.push({
      id: `pan_${start}_${end}`,
      type: 'PAN',
      start,
      end,
      rawText: raw,
      maskedPreview: '',
      canonicalKey: upper,
      method: 'regex',
      validationStatus: knownHolderType ? 'structurally_valid' : 'pattern_match',
      evidence: knownHolderType
        ? `Matched PAN 5A-4N-1A structure (holder code '${holderChar}').`
        : `Matched PAN 5A-4N-1A pattern (uncommon 4th holder letter '${holderChar}').`,
      reviewStatus: 'included',
    });
  }

  return results;
}
