export interface EquivalenceClassSummary {
  keyTuple: string[];
  size: number;
  rowIndices: number[];
  lDiversity?: number;
}

export interface GroupSizeDistributionBucket {
  groupSize: number;
  groupCount: number;
  rowCount: number;
}

export interface KAnonymityAssessment {
  applicable: boolean;
  totalRows: number;
  selectedQiCount: number;
  targetK: number;
  targetImpossible: boolean;
  kMin: number | null;
  groupCount: number;
  largestClassSize: number;
  averageClassSize: number | null;
  singletonRows: number;
  singletonRate: number | null;
  rowsBelowTarget: number;
  rowsBelowTargetRate: number | null;
  minLDiversity: number | null;
  distribution: GroupSizeDistributionBucket[];
  classes: EquivalenceClassSummary[];
  notes: string[];
}

const MISSING_TOKEN = '__MISSING__';

export function normalizeMissingCell(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim();
  return trimmed === '' ? MISSING_TOKEN : trimmed;
}

export function assessKAnonymity(
  dataRows: string[][],
  qiColumnIndices: number[],
  targetK: number,
  sensitiveColumnIndex?: number | null,
): KAnonymityAssessment {
  const totalRows = dataRows.length;
  const selectedQiCount = qiColumnIndices.length;
  const safeTargetK = Math.max(1, Math.floor(targetK));
  const notes: string[] = [
    'Group sizes are conditional on the selected quasi-identifier columns and current dataset sample; they are not probabilities of re-identification.',
  ];

  if (totalRows === 0 || selectedQiCount === 0) {
    if (totalRows === 0) notes.push('Dataset contains 0 data rows.');
    if (selectedQiCount === 0) notes.push('Select at least one quasi-identifier column to evaluate equivalence classes.');
    return {
      applicable: false,
      totalRows,
      selectedQiCount,
      targetK: safeTargetK,
      targetImpossible: false,
      kMin: null,
      groupCount: 0,
      largestClassSize: 0,
      averageClassSize: null,
      singletonRows: 0,
      singletonRate: null,
      rowsBelowTarget: 0,
      rowsBelowTargetRate: null,
      minLDiversity: null,
      distribution: [],
      classes: [],
      notes,
    };
  }

  const targetImpossible = safeTargetK > totalRows;
  if (targetImpossible) {
    notes.push(`Target k=${safeTargetK} exceeds total data rows (${totalRows}); no grouping without merging beyond sample size is possible.`);
  }

  const groups = new Map<string, { tuple: string[]; rowIndices: number[]; sensitiveValues: Set<string> }>();

  for (let r = 0; r < dataRows.length; r += 1) {
    const row = dataRows[r];
    const tuple = qiColumnIndices.map((colIdx) => normalizeMissingCell(row[colIdx]));
    // JSON.stringify guarantees collision-free keys regardless of commas/pipes inside cells
    const key = JSON.stringify(tuple);
    let bucket = groups.get(key);
    if (!bucket) {
      bucket = { tuple, rowIndices: [], sensitiveValues: new Set() };
      groups.set(key, bucket);
    }
    bucket.rowIndices.push(r);

    if (sensitiveColumnIndex != null && sensitiveColumnIndex >= 0) {
      const sVal = (row[sensitiveColumnIndex] ?? '').trim();
      if (sVal !== '') {
        bucket.sensitiveValues.add(sVal);
      }
    }
  }

  const classes: EquivalenceClassSummary[] = [];
  let kMin = Infinity;
  let largestClassSize = 0;
  let singletonRows = 0;
  let rowsBelowTarget = 0;
  let minLDiversity: number | null = sensitiveColumnIndex != null && sensitiveColumnIndex >= 0 ? Infinity : null;
  const distMap = new Map<number, { groupCount: number; rowCount: number }>();

  for (const g of groups.values()) {
    const size = g.rowIndices.length;
    if (size < kMin) kMin = size;
    if (size > largestClassSize) largestClassSize = size;
    if (size === 1) singletonRows += 1;
    if (size < safeTargetK) rowsBelowTarget += size;

    const lDiv = sensitiveColumnIndex != null && sensitiveColumnIndex >= 0 ? g.sensitiveValues.size : undefined;
    if (lDiv !== undefined && minLDiversity !== null && lDiv < minLDiversity) {
      minLDiversity = lDiv;
    }

    const d = distMap.get(size) ?? { groupCount: 0, rowCount: 0 };
    d.groupCount += 1;
    d.rowCount += size;
    distMap.set(size, d);

    classes.push({
      keyTuple: g.tuple,
      size,
      rowIndices: g.rowIndices,
      lDiversity: lDiv,
    });
  }

  classes.sort((a, b) => a.size - b.size);
  const distribution: GroupSizeDistributionBucket[] = Array.from(distMap.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([groupSize, counts]) => ({
      groupSize,
      groupCount: counts.groupCount,
      rowCount: counts.rowCount,
    }));

  if (minLDiversity === Infinity) minLDiversity = null;

  return {
    applicable: true,
    totalRows,
    selectedQiCount,
    targetK: safeTargetK,
    targetImpossible,
    kMin: kMin === Infinity ? null : kMin,
    groupCount: classes.length,
    largestClassSize,
    averageClassSize: Number((totalRows / classes.length).toFixed(2)),
    singletonRows,
    singletonRate: Number((singletonRows / totalRows).toFixed(4)),
    rowsBelowTarget,
    rowsBelowTargetRate: Number((rowsBelowTarget / totalRows).toFixed(4)),
    minLDiversity,
    distribution,
    classes,
    notes,
  };
}
