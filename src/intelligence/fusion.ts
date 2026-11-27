import type { DetectionCandidate, DetectionResult, EntityType, ValidationStatus } from '../engine/types.ts';
import type { SemanticCategory } from './schemas.ts';
import type { GroundedAiFinding } from './grounding.ts';

export type ProvenanceSource = 'rules' | 'ner' | 'gemma' | 'ocr' | 'manual';
export type ProvenanceChipLabel = 'Rules' | 'NER' | 'Gemma' | 'Both' | 'Vision' | 'Manual';

export interface HybridFinding {
  id: string;
  sourceId: string;
  sourceRevision: number;
  type: EntityType | SemanticCategory;
  start: number;
  end: number;
  rawText: string;
  maskedPreview: string;
  canonicalKey: string;
  provenance: ProvenanceSource[];
  provenanceLabel: ProvenanceChipLabel;
  validationStatus: ValidationStatus;
  mandatoryFloor: boolean;
  reviewRequired: boolean;
  included: boolean;
  reasonCode: string;
  evidence: string;
}

export interface HybridFusionMetrics {
  ruleFindingsCount: number;
  gemmaGroundedCount: number;
  overlapCount: number;
  aiOnlyAdditions: number;
  ungroundedRejectedCount: number;
  finalFindingCount: number;
  uniqueIdentitiesCount: number;
  hybridModeActive: boolean;
}

export interface HybridFusionResult {
  findings: HybridFinding[];
  /** Non-overlapping subset chosen for deterministic source slicing/redaction */
  editFindings: HybridFinding[];
  metrics: HybridFusionMetrics;
}

const MANDATORY_TYPES = new Set<string>(['EMAIL', 'PHONE', 'IPV4', 'IPV6', 'PAN', 'AADHAAR', 'CARD']);

function mapMethodToProvenance(method: DetectionCandidate['method']): ProvenanceSource {
  switch (method) {
    case 'ner':
      return 'ner';
    case 'ocr':
      return 'ocr';
    case 'manual':
      return 'manual';
    default:
      return 'rules';
  }
}

function formatChipLabel(prov: ProvenanceSource[]): ProvenanceChipLabel {
  const hasRule = prov.includes('rules') || prov.includes('ner');
  const hasGemma = prov.includes('gemma');
  if (prov.includes('manual')) return 'Manual';
  if (prov.includes('ocr')) return hasGemma ? 'Both' : 'Vision';
  if (hasRule && hasGemma) return 'Both';
  if (hasGemma) return 'Gemma';
  if (prov.includes('ner')) return 'NER';
  return 'Rules';
}

function safePreview(raw: string): string {
  if (raw.length <= 4) return '****';
  return `${raw[0]}***${raw[raw.length - 1]}`;
}

export function fuseDetectionsWithGemma(
  sourceText: string,
  sourceId: string,
  sourceRevision: number,
  deterministic: DetectionResult,
  groundedAi: GroundedAiFinding[],
  ungroundedRejectedCount: number,
  hybridModeActive: boolean,
): HybridFusionResult {
  const combined: HybridFinding[] = [];
  const ruleKeys = new Map<string, number>();

  for (const c of deterministic.accepted) {
    const prov: ProvenanceSource[] = [mapMethodToProvenance(c.method)];
    const idx = combined.length;
    ruleKeys.set(`${c.start}:${c.end}`, idx);

    combined.push({
      id: c.id,
      sourceId,
      sourceRevision,
      type: c.type,
      start: c.start,
      end: c.end,
      rawText: c.rawText,
      maskedPreview: c.maskedPreview || safePreview(c.rawText),
      canonicalKey: c.canonicalKey,
      provenance: prov,
      provenanceLabel: formatChipLabel(prov),
      validationStatus: c.validationStatus,
      mandatoryFloor: MANDATORY_TYPES.has(c.type),
      reviewRequired: c.reviewStatus === 'pending',
      included: c.reviewStatus === 'included',
      reasonCode: c.method.toUpperCase(),
      evidence: c.evidence,
    });
  }

  let overlapCount = 0;
  let aiOnlyAdditions = 0;

  for (const g of groundedAi) {
    if (g.start < 0 || g.end <= g.start || g.end > sourceText.length) continue;

    const exactIdx = ruleKeys.get(`${g.start}:${g.end}`);
    if (exactIdx !== undefined) {
      // Exact duplicate span: merge provenance into 'Both', preserve stronger deterministic classification
      const existing = combined[exactIdx];
      if (!existing.provenance.includes('gemma')) {
        existing.provenance.push('gemma');
        existing.provenanceLabel = formatChipLabel(existing.provenance);
        existing.evidence = `${existing.evidence} | Confirmed by Gemma (${g.reasonCode}).`;
        overlapCount += 1;
      }
      continue;
    }

    // Check if Gemma span completely covers or overlaps a rule span
    const overlappingRule = combined.find((r) => g.start < r.end && g.end > r.start);
    if (overlappingRule) {
      if (overlappingRule.start <= g.start && overlappingRule.end >= g.end) {
        // AI subset inside an already-protected deterministic span -> merge evidence, don't double count as AI-only addition
        if (!overlappingRule.provenance.includes('gemma')) {
          overlappingRule.provenance.push('gemma');
          overlappingRule.provenanceLabel = formatChipLabel(overlappingRule.provenance);
          overlapCount += 1;
        }
        continue;
      }
    }

    aiOnlyAdditions += 1;
    combined.push({
      id: g.id,
      sourceId,
      sourceRevision,
      type: g.type,
      start: g.start,
      end: g.end,
      rawText: g.rawText,
      maskedPreview: safePreview(g.rawText),
      canonicalKey: g.canonicalKey,
      provenance: ['gemma'],
      provenanceLabel: 'Gemma',
      validationStatus: g.reviewRequired ? 'uncertain' : 'pattern_match',
      mandatoryFloor: MANDATORY_TYPES.has(g.type),
      reviewRequired: g.reviewRequired,
      included: true,
      reasonCode: g.reasonCode,
      evidence: g.validationNote,
    });
  }

  // Deterministic sort by start ascending, mandatoryFloor priority, then longer span
  combined.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    if (a.mandatoryFloor !== b.mandatoryFloor) return a.mandatoryFloor ? -1 : 1;
    return b.end - a.end;
  });

  // Build non-overlapping editFindings so mandatory rule spans are never weakened or double-replaced
  const editFindings: HybridFinding[] = [];
  const sortedByPriority = [...combined].sort((a, b) => {
    if (a.mandatoryFloor !== b.mandatoryFloor) return a.mandatoryFloor ? -1 : 1;
    if (a.provenance.includes('manual') !== b.provenance.includes('manual')) {
      return a.provenance.includes('manual') ? -1 : 1;
    }
    const la = a.end - a.start;
    const lb = b.end - b.start;
    if (lb !== la) return lb - la;
    return a.start - b.start;
  });

  for (const cand of sortedByPriority) {
    if (!cand.included) continue;
    const conflict = editFindings.some((chosen) => cand.start < chosen.end && cand.end > chosen.start);
    if (!conflict) {
      editFindings.push(cand);
    }
  }
  editFindings.sort((a, b) => a.start - b.start);

  const uniqueKeys = new Set<string>();
  for (const f of combined) {
    uniqueKeys.add(`${f.type}::${f.canonicalKey}`);
  }

  return {
    findings: combined,
    editFindings,
    metrics: {
      ruleFindingsCount: deterministic.accepted.length,
      gemmaGroundedCount: groundedAi.length,
      overlapCount,
      aiOnlyAdditions,
      ungroundedRejectedCount,
      finalFindingCount: combined.length,
      uniqueIdentitiesCount: uniqueKeys.size,
      hybridModeActive,
    },
  };
}
