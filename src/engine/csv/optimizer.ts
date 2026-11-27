import {
  SYNTHETIC_SAMPLE_GEOGRAPHY_MAP,
  SYNTHETIC_SAMPLE_OCCUPATION_MAP,
} from '../../fixtures/samples.ts';
import { assessKAnonymity, type KAnonymityAssessment } from './risk.ts';

export type TransformColumnKind = 'age' | 'date' | 'geography_sample' | 'occupation_sample' | 'generic';

export interface ColumnTransformOption {
  id: string;
  kind: TransformColumnKind;
  level: number;
  label: string;
  description: string;
  /** Normalized per-cell cost in [0, 1]. Retain=0, coarsening=0.2..0.6, suppress=1.0 */
  unitCost: number;
  isSuppression: boolean;
  customHierarchy?: Record<string, string>;
}

export interface ColumnOptimizerConfig {
  columnIndex: number;
  columnLabel: string;
  kind: TransformColumnKind;
  importanceWeight: number;
  allowSuppression: boolean;
  customHierarchy?: Record<string, string>;
}

export interface CandidatePolicyResult {
  id: string;
  transformsByColumn: Record<number, ColumnTransformOption>;
  assessment: KAnonymityAssessment;
  feasible: boolean;
  utilityLoss: number;
  changedCellFraction: number;
  suppressedCellCount: number;
  allSuppressedDegenerate: boolean;
  distinctBefore: Record<number, number>;
  distinctAfter: Record<number, number>;
}

export interface OptimizerResult {
  feasiblePolicies: CandidatePolicyResult[];
  bestPolicy: CandidatePolicyResult | null;
  bestAttempt: CandidatePolicyResult | null;
  evaluationsRun: number;
  searchBudget: number;
  searchExhaustive: boolean;
  cancelled: boolean;
  warnings: string[];
}

export const SUPPRESSED_TOKEN = '[SUPPRESSED]';

function bucketAge(value: string, width: number): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  if (!/^\d{1,3}$/.test(trimmed)) return trimmed; // Don't silently coerce invalid ages
  const age = Number(trimmed);
  if (!Number.isFinite(age) || age < 0 || age > 125) return trimmed;
  const low = Math.floor(age / width) * width;
  const high = low + width - 1;
  return `${low}–${high}`;
}

function generalizeIsoDate(value: string, mode: 'year_month' | 'year'): string {
  const trimmed = value.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!m) return trimmed;
  return mode === 'year_month' ? `${m[1]}-${m[2]}` : m[1];
}

export function applyColumnTransformOption(opt: ColumnTransformOption, value: string): string {
  switch (opt.id) {
    case 'retain':
      return value;
    case 'age_5':
      return bucketAge(value, 5);
    case 'age_10':
      return bucketAge(value, 10);
    case 'age_20':
      return bucketAge(value, 20);
    case 'date_ym':
      return generalizeIsoDate(value, 'year_month');
    case 'date_y':
      return generalizeIsoDate(value, 'year');
    case 'geo_region': {
      const map = opt.customHierarchy ?? SYNTHETIC_SAMPLE_GEOGRAPHY_MAP;
      return map[value.trim()] ?? value;
    }
    case 'occ_sector': {
      const map = opt.customHierarchy ?? SYNTHETIC_SAMPLE_OCCUPATION_MAP;
      return map[value.trim()] ?? value;
    }
    case 'custom_map': {
      const map = opt.customHierarchy ?? {};
      return map[value.trim()] ?? value;
    }
    case 'suppress':
      return value.trim() === '' ? value : SUPPRESSED_TOKEN;
    default:
      return value;
  }
}

export function buildTransformOptionsForColumn(
  kind: TransformColumnKind,
  allowSuppression: boolean,
  customHierarchy?: Record<string, string>,
): ColumnTransformOption[] {
  const retain: ColumnTransformOption = {
    id: 'retain',
    kind,
    level: 0,
    label: 'Retain exact',
    description: 'Keep value unchanged',
    unitCost: 0,
    isSuppression: false,
  };

  const opts: ColumnTransformOption[] = [retain];

  if (kind === 'age') {
    opts.push(
      {
        id: 'age_5',
        kind,
        level: 1,
        label: '5-year bucket',
        description: 'Bucket plausible integer age into 5-year ranges (e.g. 30–34)',
        unitCost: 0.25,
        isSuppression: false,
      },
      {
        id: 'age_10',
        kind,
        level: 2,
        label: '10-year bucket',
        description: 'Bucket plausible integer age into 10-year ranges (e.g. 30–39)',
        unitCost: 0.45,
        isSuppression: false,
      },
      {
        id: 'age_20',
        kind,
        level: 3,
        label: '20-year bucket',
        description: 'Bucket plausible integer age into 20-year ranges (e.g. 20–39)',
        unitCost: 0.7,
        isSuppression: false,
      },
    );
  } else if (kind === 'date') {
    opts.push(
      {
        id: 'date_ym',
        kind,
        level: 1,
        label: 'Year-Month',
        description: 'Generalize strict YYYY-MM-DD to YYYY-MM',
        unitCost: 0.35,
        isSuppression: false,
      },
      {
        id: 'date_y',
        kind,
        level: 2,
        label: 'Year only',
        description: 'Generalize strict YYYY-MM-DD to YYYY',
        unitCost: 0.6,
        isSuppression: false,
      },
    );
  } else if (kind === 'geography_sample') {
    opts.push({
      id: 'geo_region',
      kind,
      level: 1,
      label: 'City -> Region/State',
      description: 'Map sample cities via explicit hierarchy (unknown values retained)',
      unitCost: 0.45,
      isSuppression: false,
      customHierarchy,
    });
  } else if (kind === 'occupation_sample') {
    opts.push({
      id: 'occ_sector',
      kind,
      level: 1,
      label: 'Role -> Broad Category',
      description: 'Map sample occupations via explicit hierarchy (unknown values retained)',
      unitCost: 0.45,
      isSuppression: false,
      customHierarchy,
    });
  } else if (customHierarchy && Object.keys(customHierarchy).length > 0) {
    opts.push({
      id: 'custom_map',
      kind,
      level: 1,
      label: 'Custom mapping',
      description: 'Apply user-supplied category mapping',
      unitCost: 0.45,
      isSuppression: false,
      customHierarchy,
    });
  }

  if (allowSuppression) {
    opts.push({
      id: 'suppress',
      kind,
      level: 9,
      label: 'Suppress ([SUPPRESSED])',
      description: 'Replace column values with [SUPPRESSED]',
      unitCost: 1.0,
      isSuppression: true,
    });
  }

  return opts;
}

export function inferColumnTransformKind(headerLabel: string, sampleValues: string[]): TransformColumnKind {
  const h = headerLabel.toLowerCase();
  if (/\bage\b/.test(h)) return 'age';
  if (/\b(date|dob|birth)\b/.test(h)) return 'date';
  if (/\b(city|town|location|region)\b/.test(h)) {
    const hits = sampleValues.filter((v) => v.trim() in SYNTHETIC_SAMPLE_GEOGRAPHY_MAP).length;
    if (hits > 0) return 'geography_sample';
  }
  if (/\b(occupation|job|role|profession)\b/.test(h)) {
    const hits = sampleValues.filter((v) => v.trim() in SYNTHETIC_SAMPLE_OCCUPATION_MAP).length;
    if (hits > 0) return 'occupation_sample';
  }
  return 'generic';
}

export function applyColumnTransformsToRows(
  dataRows: string[][],
  transformsByColumn: Record<number, ColumnTransformOption>,
): string[][] {
  return dataRows.map((row) =>
    row.map((cell, colIdx) => {
      const tr = transformsByColumn[colIdx];
      return tr ? applyColumnTransformOption(tr, cell) : cell;
    }),
  );
}

export interface OptimizeParams {
  dataRows: string[][];
  configs: ColumnOptimizerConfig[];
  targetK: number;
  sensitiveColumnIndex?: number | null;
  searchBudget?: number;
  shouldCancel?: () => boolean;
}

export function optimizeGeneralizationPolicy(params: OptimizeParams): OptimizerResult {
  const {
    dataRows,
    configs,
    targetK,
    sensitiveColumnIndex = null,
    searchBudget = 600,
    shouldCancel,
  } = params;

  const warnings: string[] = [];
  if (dataRows.length === 0 || configs.length === 0) {
    return {
      feasiblePolicies: [],
      bestPolicy: null,
      bestAttempt: null,
      evaluationsRun: 0,
      searchBudget,
      searchExhaustive: true,
      cancelled: false,
      warnings: ['Select at least one quasi-identifier column on a non-empty dataset.'],
    };
  }

  const optionsPerCol = configs.map((cfg) => ({
    cfg,
    options: buildTransformOptionsForColumn(cfg.kind, cfg.allowSuppression, cfg.customHierarchy),
  }));

  const distinctBefore: Record<number, number> = {};
  for (const { cfg } of optionsPerCol) {
    const s = new Set<string>();
    for (const r of dataRows) {
      const val = (r[cfg.columnIndex] ?? '').trim();
      if (val) s.add(val);
    }
    distinctBefore[cfg.columnIndex] = s.size;
  }

  const totalCombinations = optionsPerCol.reduce((acc, item) => acc * item.options.length, 1);
  const qiIndices = configs.map((c) => c.columnIndex);
  const totalWeight = configs.reduce((acc, c) => acc + Math.max(0.1, c.importanceWeight), 0);

  // Enumerate combinations cleanly up to searchBudget; if larger, enumerate by increasing total transform cost
  const candidates: Array<Record<number, ColumnTransformOption>> = [];
  const current: Record<number, ColumnTransformOption> = {};

  function dfs(idx: number) {
    if (candidates.length >= searchBudget) return;
    if (idx === optionsPerCol.length) {
      candidates.push({ ...current });
      return;
    }
    const { cfg, options } = optionsPerCol[idx];
    for (const opt of options) {
      current[cfg.columnIndex] = opt;
      dfs(idx + 1);
      if (candidates.length >= searchBudget) return;
    }
  }

  // Sort options per column by cost ascending so bounded enumeration explores lowest-loss combinations first
  for (const entry of optionsPerCol) {
    entry.options.sort((a, b) => a.unitCost - b.unitCost);
  }
  dfs(0);

  const searchExhaustive = totalCombinations <= searchBudget;
  if (!searchExhaustive) {
    warnings.push(
      `Search space (${totalCombinations} combinations) exceeded budget (${searchBudget}); evaluated lowest-cost ${searchBudget} combinations.`,
    );
  }

  const evaluated: CandidatePolicyResult[] = [];
  let evaluationsRun = 0;
  let cancelled = false;

  for (let i = 0; i < candidates.length; i += 1) {
    if (shouldCancel?.()) {
      cancelled = true;
      break;
    }
    const map = candidates[i];
    const transformedRows = applyColumnTransformsToRows(dataRows, map);
    const assessment = assessKAnonymity(transformedRows, qiIndices, targetK, sensitiveColumnIndex);
    evaluationsRun += 1;

    let weightedCostSum = 0;
    let changedCells = 0;
    let suppressedCellCount = 0;
    let totalEvaluatedCells = 0;
    const distinctAfter: Record<number, number> = {};

    for (const { cfg } of optionsPerCol) {
      const opt = map[cfg.columnIndex];
      const w = Math.max(0.1, cfg.importanceWeight);
      const colSet = new Set<string>();
      for (let r = 0; r < dataRows.length; r += 1) {
        const orig = dataRows[r][cfg.columnIndex] ?? '';
        const next = transformedRows[r][cfg.columnIndex] ?? '';
        totalEvaluatedCells += 1;
        if (orig !== next) changedCells += 1;
        if (opt.isSuppression && next === SUPPRESSED_TOKEN) suppressedCellCount += 1;
        if (next.trim()) colSet.add(next.trim());
      }
      distinctAfter[cfg.columnIndex] = colSet.size;
      weightedCostSum += opt.unitCost * w;
    }

    const utilityLoss = totalWeight > 0 ? Number((weightedCostSum / totalWeight).toFixed(4)) : 0;
    const changedCellFraction = totalEvaluatedCells > 0 ? Number((changedCells / totalEvaluatedCells).toFixed(4)) : 0;
    const allSuppressedDegenerate = optionsPerCol.every(({ cfg }) => map[cfg.columnIndex].isSuppression);
    const feasible = assessment.applicable && assessment.kMin !== null && assessment.kMin >= targetK;

    evaluated.push({
      id: `pol_${i}`,
      transformsByColumn: map,
      assessment,
      feasible,
      utilityLoss,
      changedCellFraction,
      suppressedCellCount,
      allSuppressedDegenerate,
      distinctBefore,
      distinctAfter,
    });
  }

  const feasiblePolicies = evaluated
    .filter((p) => p.feasible)
    .sort((a, b) => {
      // Prefer non-degenerate policies over all-suppressed degeneracy
      if (a.allSuppressedDegenerate !== b.allSuppressedDegenerate) {
        return a.allSuppressedDegenerate ? 1 : -1;
      }
      if (a.utilityLoss !== b.utilityLoss) return a.utilityLoss - b.utilityLoss;
      if (a.suppressedCellCount !== b.suppressedCellCount) return a.suppressedCellCount - b.suppressedCellCount;
      return a.changedCellFraction - b.changedCellFraction;
    });

  const bestPolicy = feasiblePolicies[0] ?? null;
  if (bestPolicy?.allSuppressedDegenerate) {
    warnings.push('Only all-suppressed policy reached target k; utility is trivially lost across all selected QIs.');
  }

  const bestAttempt =
    bestPolicy ??
    [...evaluated].sort((a, b) => {
      const ka = a.assessment.kMin ?? 0;
      const kb = b.assessment.kMin ?? 0;
      if (kb !== ka) return kb - ka;
      if (a.assessment.rowsBelowTarget !== b.assessment.rowsBelowTarget) {
        return a.assessment.rowsBelowTarget - b.assessment.rowsBelowTarget;
      }
      return a.utilityLoss - b.utilityLoss;
    })[0] ??
    null;

  if (!bestPolicy && !cancelled) {
    warnings.push(
      searchExhaustive
        ? `No policy satisfied k >= ${targetK} under the enabled transformations.`
        : `No feasible policy found within search budget (${searchBudget} evaluations). Try enabling more generalizations or lowering target k.`,
    );
  }

  return {
    feasiblePolicies: feasiblePolicies.slice(0, 12),
    bestPolicy,
    bestAttempt,
    evaluationsRun,
    searchBudget,
    searchExhaustive,
    cancelled,
    warnings,
  };
}
