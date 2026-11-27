import { BENCHMARK_FIXTURES } from './fixtures.ts';
import { runSyntheticBenchmark } from './runner.ts';

const report = runSyntheticBenchmark(BENCHMARK_FIXTURES, 'rule_only');
console.log(JSON.stringify(report, null, 2));
