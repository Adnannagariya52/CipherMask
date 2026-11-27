import type { DetectionCandidate, EntityType } from '../types.ts';
import { chunkTextUnicodeSafe } from './chunking.ts';

export interface NerTokenOutput {
  entity?: string;
  entity_group?: string;
  score: number;
  word: string;
  index?: number;
  start?: number | null;
  end?: number | null;
}

function mapNerTagToEntityType(tag: string): EntityType | null {
  const clean = tag.replace(/^[BI]-/, '').toUpperCase();
  if (clean === 'PER' || clean === 'PERSON') return 'PERSON';
  if (clean === 'LOC' || clean === 'LOCATION') return 'LOCATION';
  if (clean === 'ORG' || clean === 'ORGANIZATION') return 'ORGANIZATION';
  return null;
}

/**
 * Aggregates raw BERT token-classification outputs into verified original UTF-16 spans.
 * Never guesses offsets when alignment fails.
 */
export function aggregateNerTokensToCandidates(
  chunkText: string,
  chunkGlobalStart: number,
  tokens: NerTokenOutput[],
  minConfidence = 0.65,
): DetectionCandidate[] {
  const groups: Array<{
    type: EntityType;
    words: string[];
    scores: number[];
    start?: number;
    end?: number;
  }> = [];

  let current: (typeof groups)[number] | null = null;

  for (const tok of tokens) {
    const rawTag = tok.entity_group || tok.entity || '';
    const mappedType = mapNerTagToEntityType(rawTag);
    if (!mappedType) {
      if (current) {
        groups.push(current);
        current = null;
      }
      continue;
    }

    const isBegin = rawTag.startsWith('B-') || !current || current.type !== mappedType;
    if (isBegin) {
      if (current) groups.push(current);
      current = {
        type: mappedType,
        words: [tok.word],
        scores: [tok.score],
        start: typeof tok.start === 'number' ? tok.start : undefined,
        end: typeof tok.end === 'number' ? tok.end : undefined,
      };
    } else if (current) {
      current.words.push(tok.word);
      current.scores.push(tok.score);
      if (typeof tok.end === 'number') {
        current.end = tok.end;
      }
    }
  }
  if (current) groups.push(current);

  const candidates: DetectionCandidate[] = [];
  let searchCursor = 0;

  for (const g of groups) {
    const avgScore = g.scores.reduce((a, b) => a + b, 0) / g.scores.length;
    if (avgScore < minConfidence) continue;

    // Reconstruct surface string from WordPiece tokens
    let phrase = '';
    for (const w of g.words) {
      if (w.startsWith('##')) {
        phrase += w.slice(2);
      } else if (phrase === '' || /^['’.,-]$/.test(w)) {
        phrase += w;
      } else {
        phrase += ` ${w}`;
      }
    }
    phrase = phrase.trim();
    if (phrase.length < 2) continue;

    let localStart = g.start;
    let localEnd = g.end;

    if (localStart === undefined || localEnd === undefined || localEnd <= localStart) {
      // Locate exact case-insensitive substring match near searchCursor
      const exactIdx = chunkText.indexOf(phrase, searchCursor);
      if (exactIdx !== -1) {
        localStart = exactIdx;
        localEnd = exactIdx + phrase.length;
      } else {
        const lowerIdx = chunkText.toLowerCase().indexOf(phrase.toLowerCase(), searchCursor);
        if (lowerIdx !== -1) {
          localStart = lowerIdx;
          localEnd = lowerIdx + phrase.length;
        }
      }
    }

    if (localStart === undefined || localEnd === undefined || localEnd <= localStart || localEnd > chunkText.length) {
      continue;
    }

    searchCursor = localEnd;
    const globalStart = chunkGlobalStart + localStart;
    const globalEnd = chunkGlobalStart + localEnd;
    const rawSlice = chunkText.slice(localStart, localEnd);

    // Require high confidence for automatic inclusion; lower confidence stays pending review
    const highConf = avgScore >= 0.82;

    candidates.push({
      id: `ner_${g.type.toLowerCase()}_${globalStart}_${globalEnd}`,
      type: g.type,
      start: globalStart,
      end: globalEnd,
      rawText: rawSlice,
      maskedPreview: '',
      canonicalKey: rawSlice.trim(),
      method: 'ner',
      validationStatus: highConf ? 'pattern_match' : 'uncertain',
      evidence: `Local BERT-NER (${g.type}, confidence ${(avgScore * 100).toFixed(1)}%). Review recommended; training bias may miss non-Western names.`,
      confidence: Number(avgScore.toFixed(3)),
      reviewStatus: highConf ? 'pending' : 'pending', // Contextual NER requires user review/opt-in by default
    });
  }

  return candidates;
}

export function mergeChunkNerCandidates(candidates: DetectionCandidate[]): DetectionCandidate[] {
  const dedup = new Map<string, DetectionCandidate>();
  for (const c of candidates) {
    const key = `${c.type}:${c.start}:${c.end}`;
    const existing = dedup.get(key);
    if (!existing || (c.confidence ?? 0) > (existing.confidence ?? 0)) {
      dedup.set(key, c);
    }
  }
  return Array.from(dedup.values()).sort((a, b) => a.start - b.start);
}

export { chunkTextUnicodeSafe };
