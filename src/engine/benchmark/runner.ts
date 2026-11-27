import type { EntityType } from '../types.ts';
import { createDefaultPolicy } from '../redaction.ts';
import { runDetectionPipeline } from '../pipeline.ts';
import { BENCHMARK_FIXTURES, type BenchmarkFixture } from './fixtures.ts';

export interface CategoryMetrics {
  type: EntityType | 'OVERALL';
  tp: number;
  fp: number;
  fn: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
}

export interface BenchmarkFailureCase {
  fixtureId: string;
  categoryGroup: string;
  description: string;
  expected: Array<{ type: EntityType; start: number; end: number; slice: string }>;
  actual: Array<{ type: EntityType; start: number; end: number; slice: string }>;
  fpCount: number;
  fnCount: number;
}

export interface BenchmarkRunReport {
  totalFixtures: number;
  mode: 'rule_only' | 'enhanced';
  totalDurationMs: number;
  medianFixtureMs: number;
  overall: CategoryMetrics;
  byCategory: CategoryMetrics[];
  failures: BenchmarkFailureCase[];
  rejectedTotal: number;
  executedAt: string;
}

function calcMetrics(type: EntityType | 'OVERALL', tp: number, fp: number, fn: number): CategoryMetrics {
  const precision = tp + fp > 0 ? Number((tp / (tp + fp)).toFixed(4)) : null;
  const recall = tp + fn > 0 ? Number((tp / (tp + fn)).toFixed(4)) : null;
  const f1 =
    precision !== null && recall !== null && precision + recall > 0
      ? Number(((2 * precision * recall) / (precision + recall)).toFixed(4))
      : null;
  return { type, tp, fp, fn, precision, recall, f1 };
}

export function runSyntheticBenchmark(
  fixtures: BenchmarkFixture[] = BENCHMARK_FIXTURES,
  mode: 'rule_only' | 'enhanced' = 'rule_only',
  onProgress?: (done: number, total: number) => void,
): BenchmarkRunReport {
  const startAll = performance.now();
  const policy = createDefaultPolicy('AI_SAFE');
  policy.enableLeakHunter = true;
  policy.enableNer = mode === 'enhanced';

  const catCounts = new Map<EntityType, { tp: number; fp: number; fn: number }>();
  const ensureCat = (t: EntityType) => {
    let entry = catCounts.get(t);
    if (!entry) {
      entry = { tp: 0, fp: 0, fn: 0 };
      catCounts.set(t, entry);
    }
    return entry;
  };

  let totalTp = 0;
  let totalFp = 0;
  let totalFn = 0;
  let rejectedTotal = 0;
  const durations: number[] = [];
  const failures: BenchmarkFailureCase[] = [];

  for (let i = 0; i < fixtures.length; i += 1) {
    const f = fixtures[i];
    if (f.requiresNer && mode === 'rule_only') {
      continue;
    }

    const t0 = performance.now();
    const det = runDetectionPipeline(f.text, { policy, revision: 1 });
    durations.push(performance.now() - t0);
    rejectedTotal += det.rejected.length;

    const matchedExp = new Set<number>();
    const matchedAct = new Set<number>();

    // Exact span AND type one-to-one matching
    for (let ai = 0; ai < det.accepted.length; ai += 1) {
      const act = det.accepted[ai];
      const ei = f.expected.findIndex(
        (exp, idx) =>
          !matchedExp.has(idx) &&
          exp.type === act.type &&
          exp.start === act.start &&
          exp.end === act.end,
      );
      if (ei !== -1) {
        matchedExp.add(ei);
        matchedAct.add(ai);
        totalTp += 1;
        ensureCat(act.type).tp += 1;
      }
    }

    let caseFp = 0;
    let caseFn = 0;

    for (let ai = 0; ai < det.accepted.length; ai += 1) {
      if (!matchedAct.has(ai)) {
        const act = det.accepted[ai];
        totalFp += 1;
        caseFp += 1;
        ensureCat(act.type).fp += 1;
      }
    }

    for (let ei = 0; ei < f.expected.length; ei += 1) {
      if (!matchedExp.has(ei)) {
        const exp = f.expected[ei];
        totalFn += 1;
        caseFn += 1;
        ensureCat(exp.type).fn += 1;
      }
    }

    if (caseFp > 0 || caseFn > 0) {
      failures.push({
        fixtureId: f.id,
        categoryGroup: f.categoryGroup,
        description: f.description,
        expected: f.expected.map((e) => ({
          ...e,
          slice: f.text.slice(e.start, e.end),
        })),
        actual: det.accepted.map((a) => ({
          type: a.type,
          start: a.start,
          end: a.end,
          slice: a.rawText,
        })),
        fpCount: caseFp,
        fnCount: caseFn,
      });
    }

    onProgress?.(i + 1, fixtures.length);
  }

  durations.sort((a, b) => a - b);
  const medianFixtureMs =
    durations.length > 0 ? Number(durations[Math.floor(durations.length / 2)].toFixed(3)) : 0;

  const byCategory: CategoryMetrics[] = Array.from(catCounts.entries()).map(([type, c]) =>
    calcMetrics(type, c.tp, c.fp, c.fn),
  );

  return {
    totalFixtures: durations.length,
    mode,
    totalDurationMs: Number((performance.now() - startAll).toFixed(2)),
    medianFixtureMs,
    overall: calcMetrics('OVERALL', totalTp, totalFp, totalFn),
    byCategory,
    failures,
    rejectedTotal,
    executedAt: new Date().toISOString(),
  };
}
