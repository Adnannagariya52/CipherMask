import type { SemanticCategory, SemanticDetectionResponse } from './schemas.ts';
import { validateLuhn } from '../engine/validators/luhn.ts';
import { validateAadhaar } from '../engine/validators/verhoeff.ts';

export interface GroundedAiFinding {
  id: string;
  sourceId: string;
  sourceRevision: number;
  type: SemanticCategory;
  start: number;
  end: number;
  rawText: string;
  canonicalKey: string;
  reasonCode: string;
  reviewRequired: boolean;
  validationNote: string;
  detector: 'gemma';
}

export interface GroundingOutcome {
  grounded: GroundedAiFinding[];
  ungroundedQuotes: string[];
  rejectedMandatoryPromotions: string[];
}

function findAllOccurrences(haystack: string, needle: string): number[] {
  const indices: number[] = [];
  if (!needle) return indices;
  let pos = 0;
  while (pos <= haystack.length - needle.length) {
    const idx = haystack.indexOf(needle, pos);
    if (idx === -1) break;
    indices.push(idx);
    pos = idx + Math.max(1, needle.length);
  }
  return indices;
}

export function groundSemanticFindings(
  chunkText: string,
  chunkGlobalStart: number,
  sourceId: string,
  sourceRevision: number,
  parsed: SemanticDetectionResponse,
): GroundingOutcome {
  const grounded: GroundedAiFinding[] = [];
  const ungroundedQuotes: string[] = [];
  const rejectedMandatoryPromotions: string[] = [];
  const seenSpans = new Set<string>();

  for (const item of parsed.findings) {
    const occurrences = findAllOccurrences(chunkText, item.quote);
    if (occurrences.length === 0) {
      ungroundedQuotes.push(item.quote.slice(0, 60));
      continue;
    }

    // Disambiguate repeated quotes using anchors or occurrence index; otherwise mark all occurrences for review
    let selectedOffsets: number[];
    if (occurrences.length === 1) {
      selectedOffsets = occurrences;
    } else if (item.leftAnchor || item.rightAnchor) {
      const anchored = occurrences.filter((idx) => {
        const left = chunkText.slice(Math.max(0, idx - 60), idx);
        const right = chunkText.slice(idx + item.quote.length, idx + item.quote.length + 60);
        const leftOk = item.leftAnchor ? left.includes(item.leftAnchor) : true;
        const rightOk = item.rightAnchor ? right.includes(item.rightAnchor) : true;
        return leftOk && rightOk;
      });
      selectedOffsets = anchored.length > 0 ? anchored : occurrences;
    } else if (typeof item.occurrence === 'number' && occurrences[item.occurrence] !== undefined) {
      selectedOffsets = [occurrences[item.occurrence]];
    } else {
      selectedOffsets = occurrences;
    }

    const ambiguousMulti = occurrences.length > 1 && selectedOffsets.length > 1;

    for (const localIdx of selectedOffsets) {
      const start = chunkGlobalStart + localIdx;
      const end = start + item.quote.length;
      const spanKey = `${item.type}:${start}:${end}`;
      if (seenSpans.has(spanKey)) continue;
      seenSpans.add(spanKey);

      let effectiveType: SemanticCategory = item.type;
      let validationNote = 'Grounded exact quote from local Gemma 3 4B analysis.';

      // Deterministic guard: Gemma cannot promote an invalid Card or Aadhaar checksum into CARD/AADHAAR
      if (item.type === 'CARD') {
        const luhn = validateLuhn(item.quote);
        if (!luhn.valid) {
          rejectedMandatoryPromotions.push(spanKey);
          effectiveType = 'OTHER_SENSITIVE';
          validationNote = `Gemma proposed CARD, downgraded to OTHER_SENSITIVE (${luhn.reason}).`;
        }
      } else if (item.type === 'AADHAAR') {
        const aad = validateAadhaar(item.quote);
        if (!aad.valid) {
          rejectedMandatoryPromotions.push(spanKey);
          effectiveType = 'OTHER_SENSITIVE';
          validationNote = `Gemma proposed AADHAAR, downgraded to OTHER_SENSITIVE (${aad.reason}).`;
        }
      }

      grounded.push({
        id: `gemma_${effectiveType.toLowerCase()}_${start}_${end}`,
        sourceId,
        sourceRevision,
        type: effectiveType,
        start,
        end,
        rawText: item.quote,
        canonicalKey: item.quote.trim(),
        reasonCode: item.reasonCode,
        reviewRequired: item.reviewRequired || ambiguousMulti,
        validationNote,
        detector: 'gemma',
      });
    }
  }

  return { grounded, ungroundedQuotes, rejectedMandatoryPromotions };
}
