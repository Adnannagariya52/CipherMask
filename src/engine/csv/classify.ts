import type { DetectionCandidate, EntityType, RedactionPolicy, TransformationRecord } from '../types.ts';
import { applyRedactionPolicy, runDetectionPipeline } from '../pipeline.ts';
import { SessionPseudonymAllocator } from '../pseudonyms.ts';

export type CsvColumnRole = 'direct_id' | 'quasi_id' | 'sensitive' | 'utility' | 'excluded';

export interface CsvColumnMeta {
  index: number;
  headerLabel: string;
  suggestedRole: CsvColumnRole;
  role: CsvColumnRole;
  distinctCount: number;
  missingCount: number;
  detectedTypes: EntityType[];
}

export interface CsvCellHit {
  row: number;
  column: number;
  candidates: DetectionCandidate[];
  transformations: TransformationRecord[];
}

export interface CsvRedactionResult {
  sanitizedRows: string[][];
  countsByType: Partial<Record<EntityType, number>>;
  rejectedCount: number;
  appliedCount: number;
  excludedCount: number;
  uniquePseudonyms: number;
  cellTransformations: TransformationRecord[];
  durationMs: number;
}

const DIRECT_ID_HEADER_RE = /\b(email|e-mail|phone|mobile|pan|aadhaar|aadhar|card|ssn|passport|emp(?:loyee)?_?id|cust(?:omer)?_?id|user_?id|full_?name|first_?name|last_?name|name|ip_?addr(?:ess)?)\b/i;
const QUASI_ID_HEADER_RE = /\b(age|dob|birth|gender|sex|city|town|district|state|country|zip|postal|pin_?code|occupation|job|role|profession|marital|education)\b/i;
const SENSITIVE_HEADER_RE = /\b(diagnosis|condition|disease|salary|income|medical|health|treatment|religion|caste)\b/i;

export function suggestColumnRoles(rows: string[][], hasHeader: boolean): CsvColumnMeta[] {
  if (rows.length === 0) return [];
  const colCount = Math.max(...rows.map((r) => r.length));
  const dataStart = hasHeader ? 1 : 0;
  const cols: CsvColumnMeta[] = [];

  for (let c = 0; c < colCount; c += 1) {
    const headerLabel = hasHeader ? (rows[0][c] ?? `Column ${c + 1}`) : `Column ${c + 1}`;
    const distinct = new Set<string>();
    let missingCount = 0;

    for (let r = dataStart; r < rows.length; r += 1) {
      const val = (rows[r][c] ?? '').trim();
      if (!val) {
        missingCount += 1;
      } else {
        distinct.add(val);
      }
    }

    let suggestedRole: CsvColumnRole = 'utility';
    if (DIRECT_ID_HEADER_RE.test(headerLabel)) {
      suggestedRole = 'direct_id';
    } else if (QUASI_ID_HEADER_RE.test(headerLabel)) {
      suggestedRole = 'quasi_id';
    } else if (SENSITIVE_HEADER_RE.test(headerLabel)) {
      suggestedRole = 'sensitive';
    }

    cols.push({
      index: c,
      headerLabel,
      suggestedRole,
      role: suggestedRole,
      distinctCount: distinct.size,
      missingCount,
      detectedTypes: [],
    });
  }

  return cols;
}

export function redactCsvRows(
  rows: string[][],
  hasHeader: boolean,
  columns: CsvColumnMeta[],
  policy: RedactionPolicy,
  maskWholeDirectColumns = true,
): CsvRedactionResult {
  const startMs = performance.now();
  const allocator = new SessionPseudonymAllocator();
  const sanitizedRows: string[][] = [];
  const countsByType: Partial<Record<EntityType, number>> = {};
  let rejectedCount = 0;
  let appliedCount = 0;
  let excludedCount = 0;
  const cellTransformations: TransformationRecord[] = [];
  const colDetectedTypes = new Map<number, Set<EntityType>>();

  for (let r = 0; r < rows.length; r += 1) {
    const row = rows[r];
    const outRow: string[] = [];

    for (let c = 0; c < row.length; c += 1) {
      const cell = row[c] ?? '';
      const colMeta = columns[c];
      const isHeaderRow = hasHeader && r === 0;

      // Never treat ordinary column labels as PII unless explicit pattern inside header
      const det = runDetectionPipeline(cell, { policy, revision: 1 });
      rejectedCount += det.rejected.length;

      if (!isHeaderRow && det.accepted.length > 0) {
        let typeSet = colDetectedTypes.get(c);
        if (!typeSet) {
          typeSet = new Set();
          colDetectedTypes.set(c, typeSet);
        }
        for (const cand of det.accepted) {
          typeSet.add(cand.type);
          countsByType[cand.type] = (countsByType[cand.type] ?? 0) + 1;
        }
      }

      if (!isHeaderRow && det.accepted.length === 0 && maskWholeDirectColumns && colMeta?.role === 'direct_id' && cell.trim() !== '') {
        // Manual direct-identifier column (e.g., Full_Name, Employee_ID) with no structured regex hit
        const mode = policy.categoryModes.CONTEXT_ID ?? policy.defaultMode;
        if (mode === 'KEEP') {
          outRow.push(cell);
          excludedCount += 1;
        } else {
          const replacement =
            mode === 'FULL'
              ? '[REDACTED]'
              : mode === 'PSEUDONYM'
                ? allocator.allocate('CONTEXT_ID', `${c}::${cell.trim()}`)
                : `${cell.trim().slice(0, 1)}***`;
          outRow.push(replacement);
          appliedCount += 1;
          countsByType.CONTEXT_ID = (countsByType.CONTEXT_ID ?? 0) + 1;
          cellTransformations.push({
            candidateId: `csv_col_${r}_${c}`,
            type: 'CONTEXT_ID',
            mode,
            origStart: 0,
            origEnd: cell.length,
            outStart: 0,
            outEnd: replacement.length,
            replacement,
            originalSlice: cell,
            canonicalKey: `${c}::${cell.trim()}`,
            applied: true,
            row: r,
            column: c,
            cellStart: 0,
            cellEnd: replacement.length,
          });
        }
        continue;
      }

      if (det.accepted.length === 0) {
        outRow.push(cell);
        continue;
      }

      const out = applyRedactionPolicy(cell, det, policy, allocator);
      outRow.push(out.sanitizedText);
      appliedCount += out.appliedCount;
      excludedCount += out.excludedCount;

      for (const t of out.transformations) {
        cellTransformations.push({
          ...t,
          candidateId: `csv_${r}_${c}_${t.candidateId}`,
          row: r,
          column: c,
          cellStart: t.outStart,
          cellEnd: t.outEnd,
        });
      }
    }

    sanitizedRows.push(outRow);
  }

  for (const col of columns) {
    const s = colDetectedTypes.get(col.index);
    if (s) col.detectedTypes = Array.from(s);
  }

  return {
    sanitizedRows,
    countsByType,
    rejectedCount,
    appliedCount,
    excludedCount,
    uniquePseudonyms: allocator.size(),
    cellTransformations,
    durationMs: Number((performance.now() - startMs).toFixed(2)),
  };
}
