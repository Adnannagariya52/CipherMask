import { describe, it, expect } from 'vitest';
import { BENCHMARK_FIXTURES } from '../../src/engine/benchmark/fixtures.ts';
import { runSyntheticBenchmark } from '../../src/engine/benchmark/runner.ts';

describe('Synthetic Benchmark Suite', () => {
  it('contains >= 65 labeled synthetic fixtures and computes genuine TP/FP/FN metrics', () => {
    expect(BENCHMARK_FIXTURES.length).toBeGreaterThanOrEqual(65);
    const report = runSyntheticBenchmark(BENCHMARK_FIXTURES, 'rule_only');
    expect(report.totalFixtures).toBe(BENCHMARK_FIXTURES.length);
    expect(report.overall.tp).toBeGreaterThan(30);
    expect(report.overall.precision).not.toBeNull();
    expect(report.overall.recall).not.toBeNull();
    expect(report.failures.length).toBe(0);
  });
});
