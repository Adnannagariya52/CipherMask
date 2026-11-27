import { findPhoneNumbersInText, parsePhoneNumberFromString } from 'libphonenumber-js';
import type { DetectionCandidate } from '../types.ts';

// Explicit Indian mobile / landline patterns and labeled numbers as structured supplement
const INDIAN_MOBILE_RE = /(?<!\d)(?:\+91[\s.-]?|0)?([6-9]\d{4}[\s.-]?\d{5}|[6-9]\d{2}[\s.-]?\d{3}[\s.-]?\d{4}|[6-9]\d{9})(?!\d)/g;

const PHONE_CONTEXT_HINT_RE = /\b(?:tel|phone|ph|mob|mobile|cell|call|contact|whatsapp|fax)\b/i;

const DOTTED_QUAD_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const ISO_DATE_RE = /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/;

function isBoundedPhoneSpan(text: string, start: number, end: number): boolean {
  const before = start > 0 ? text[start - 1] : '';
  const after = end < text.length ? text[end] : '';
  if (/\d/.test(before) || /\d/.test(after)) return false;
  // Avoid IP octets or decimal floats like 192.168.1.100 or 1.2345678901
  if (before === '.' && /\d/.test(text[start - 2] ?? '')) return false;
  if (after === '.' && /\d/.test(text[end + 1] ?? '')) return false;
  const slice = text.slice(start, end).trim();
  if (DOTTED_QUAD_RE.test(slice) || ISO_DATE_RE.test(slice)) return false;
  return true;
}

export function detectPhones(text: string): DetectionCandidate[] {
  const results: DetectionCandidate[] = [];
  const seenSpan = new Set<string>();

  // 1. libphonenumber-js scan with IN default country for unlabeled Indian numbers + international +XX
  try {
    const matches = findPhoneNumbersInText(text, 'IN');
    for (const m of matches) {
      const start = m.startsAt;
      const end = m.endsAt;
      if (!isBoundedPhoneSpan(text, start, end)) continue;

      const raw = text.slice(start, end);
      const digits = raw.replace(/\D/g, '');
      // Skip pure 10+ digit sequences that look like timestamps/order IDs unless valid IN mobile or international or has separators/+
      const hasPlus = raw.trim().startsWith('+');
      const hasSeparators = /[\s()-]/.test(raw);
      const parsed = m.number;
      const isValid = parsed.isValid();
      const isPossible = parsed.isPossible();

      if (!isValid && !isPossible) continue;
      // Reject unformatted >=11-digit runs without '+' or phone context (e.g. 13-digit epoch timestamps)
      if (!hasPlus && !hasSeparators && digits.length >= 11) {
        const isZeroPrefixedInMobile = digits.length === 11 && /^0[6-9]\d{9}$/.test(digits);
        const ctxBefore = text.slice(Math.max(0, start - 24), start);
        if (!isZeroPrefixedInMobile && !PHONE_CONTEXT_HINT_RE.test(ctxBefore)) {
          continue;
        }
      }
      if (!hasPlus && !hasSeparators && digits.length === 10 && !/^[6-9]/.test(digits)) {
        // Bare 10 digits not starting with 6-9 in IN default: check context before accepting
        const ctxBefore = text.slice(Math.max(0, start - 24), start);
        if (!PHONE_CONTEXT_HINT_RE.test(ctxBefore)) {
          continue;
        }
      }

      const spanKey = `${start}:${end}`;
      seenSpan.add(spanKey);
      const e164 = parsed.number;

      results.push({
        id: `phone_${start}_${end}`,
        type: 'PHONE',
        start,
        end,
        rawText: raw,
        maskedPreview: '',
        canonicalKey: e164 || digits,
        method: 'parser',
        validationStatus: isValid ? 'structurally_valid' : 'uncertain',
        evidence: isValid
          ? `Validated by libphonenumber-js (${parsed.country || 'INTL'}, E.164 ${e164}).`
          : `Possible phone format (${parsed.country || 'unknown'}); review recommended.`,
        reviewStatus: isValid ? 'included' : 'pending',
      });
    }
  } catch {
    // Fallback handled below
  }

  // 2. Supplement for Indian mobile numbers with mixed grouping that findPhoneNumbersInText might miss
  INDIAN_MOBILE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INDIAN_MOBILE_RE.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (!isBoundedPhoneSpan(text, start, end)) continue;

    // Avoid overlap with already found libphonenumber span
    let overlaps = false;
    for (const key of seenSpan) {
      const [s, e] = key.split(':').map(Number);
      if (start < e && end > s) {
        overlaps = true;
        break;
      }
    }
    if (overlaps) continue;

    const raw = m[0];
    const parsed = parsePhoneNumberFromString(raw, 'IN');
    if (!parsed || !parsed.isValid()) continue;

    seenSpan.add(`${start}:${end}`);
    results.push({
      id: `phone_${start}_${end}`,
      type: 'PHONE',
      start,
      end,
      rawText: raw,
      maskedPreview: '',
      canonicalKey: parsed.number,
      method: 'parser',
      validationStatus: 'structurally_valid',
      evidence: `Validated Indian phone (${parsed.number}).`,
      reviewStatus: 'included',
    });
  }

  return results;
}
