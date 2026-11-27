import React, { useState } from 'react';
import { Play, Download, CheckCircle2, AlertTriangle } from 'lucide-react';
import { BENCHMARK_FIXTURES } from '../../engine/benchmark/fixtures.ts';
import { runSyntheticBenchmark, type BenchmarkRunReport } from '../../engine/benchmark/runner.ts';
import { useSession } from '../../state/session.tsx';
import { PageHeader } from '../../components/ui/PageHeader.tsx';

function formatPct(val: number | null): string {
  if (val === null) return 'N/A';
  return `${(val * 100).toFixed(1)}%`;
}

export const BenchmarkLab: React.FC = () => {
  const { pushToast } = useSession();
  const [report, setReport] = useState<BenchmarkRunReport | null>(null);
  const [running, setRunning] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState<string>('ALL');

  const handleRun = () => {
    setRunning(true);
    setTimeout(() => {
      try {
        const res = runSyntheticBenchmark(BENCHMARK_FIXTURES, 'rule_only');
        setReport(res);
        pushToast(
          res.failures.length === 0 ? 'success' : 'warning',
          `Evaluated ${res.totalFixtures} synthetic fixtures in ${res.totalDurationMs} ms.`,
        );
      } finally {
        setRunning(false);
      }
    }, 20);
  };

  const handleExportJson = () => {
    if (!report) return;
    const bytes = new TextEncoder().encode(JSON.stringify(report, null, 2));
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ciphermask-benchmark-report.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const filteredFailures =
    report?.failures.filter((f) => categoryFilter === 'ALL' || f.categoryGroup === categoryFilter) ?? [];

  return (
    <div className="space-y-8 ae-fade-in">
      <PageHeader
        eyebrow="Engine Evaluation"
        title="Benchmark Lab"
        description={`Exact-span evaluation across ${BENCHMARK_FIXTURES.length} synthetic labeled cases covering positives, negatives, checksum rejections, and Leak Hunter obfuscations.`}
        actions={
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              data-testid="run-benchmark-btn"
              disabled={running}
              onClick={handleRun}
              className="ae-btn-primary inline-flex items-center gap-2 rounded-xl px-5 h-11 text-[15px] disabled:opacity-45 cursor-pointer"
            >
              <Play className="w-4 h-4" aria-hidden="true" />
              <span>{running ? 'Running...' : 'Run Benchmark Suite'}</span>
            </button>

            {report && (
              <button
                type="button"
                onClick={handleExportJson}
                className="ae-btn-secondary inline-flex items-center gap-2 rounded-xl px-4 h-11 text-sm cursor-pointer"
              >
                <Download className="w-4 h-4 text-[#087F6D]" aria-hidden="true" />
                <span>Export JSON</span>
              </button>
            )}
          </div>
        }
      />

      {!report ? (
        <div className="rounded-2xl border border-dashed border-[#CBD5E1] bg-white p-14 text-center text-base text-[#64748B]">
          Click <strong>Run Benchmark Suite</strong> to execute live exact-span evaluation on your current browser engine. Synthetic fixtures do not measure real-world generalization.
        </div>
      ) : (
        <>
          <section className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
            {[
              { label: 'Fixtures Run', val: report.totalFixtures },
              { label: 'Overall Precision', val: formatPct(report.overall.precision), accent: 'text-[#15803D]' },
              { label: 'Overall Recall', val: formatPct(report.overall.recall), accent: 'text-[#15803D]' },
              { label: 'Overall F1', val: formatPct(report.overall.f1), accent: 'text-[#087F6D]' },
              { label: 'Median / Case', val: `${report.medianFixtureMs} ms` },
              { label: 'Total Elapsed', val: `${report.totalDurationMs} ms` },
            ].map((c) => (
              <div key={c.label} className="ae-card p-5">
                <div className="text-[13px] font-medium text-[#64748B]">{c.label}</div>
                <div className={`text-2xl font-semibold font-mono tabular-nums mt-1 ${c.accent || 'text-[#101828]'}`}>
                  {c.val}
                </div>
              </div>
            ))}
          </section>

          <section className="ae-card overflow-hidden">
            <div className="px-6 py-4 border-b border-[#EDF0F4] bg-[#F8FAFC] text-base font-semibold text-[#101828]">
              Per-Category Breakdown (Exact Span + Type Match)
            </div>
            <div className="overflow-x-auto">
              <table data-testid="benchmark-table" className="w-full text-left text-sm border-collapse">
                <thead className="bg-[#F8FAFC] border-b border-[#E2E8F0] text-[#64748B]">
                  <tr>
                    <th className="py-3 px-4 font-semibold">Category</th>
                    <th className="py-3 px-4 font-semibold">TP</th>
                    <th className="py-3 px-4 font-semibold">FP</th>
                    <th className="py-3 px-4 font-semibold">FN</th>
                    <th className="py-3 px-4 font-semibold">Precision</th>
                    <th className="py-3 px-4 font-semibold">Recall</th>
                    <th className="py-3 px-4 font-semibold">F1</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#EDF0F4] font-mono">
                  {[report.overall, ...report.byCategory].map((row) => (
                    <tr key={row.type} className={row.type === 'OVERALL' ? 'bg-[#E1F5EF]/50 font-semibold' : 'hover:bg-[#F7F9FC]'}>
                      <td className="py-3 px-4 text-[#101828]">{row.type}</td>
                      <td className="py-3 px-4 text-[#15803D]">{row.tp}</td>
                      <td className="py-3 px-4 text-[#DC2626]">{row.fp}</td>
                      <td className="py-3 px-4 text-[#B45309]">{row.fn}</td>
                      <td className="py-3 px-4 text-[#475569]">{formatPct(row.precision)}</td>
                      <td className="py-3 px-4 text-[#475569]">{formatPct(row.recall)}</td>
                      <td className="py-3 px-4 text-[#087F6D] font-semibold">{formatPct(row.f1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="ae-card p-6 space-y-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2.5 font-semibold text-[#101828]">
                {report.failures.length === 0 ? (
                  <>
                    <CheckCircle2 className="w-5 h-5 text-[#15803D]" />
                    <span>0 Mismatches Across {report.totalFixtures} Synthetic Rule-Engine Cases (Rejected Candidates Tracked Separately: {report.rejectedTotal})</span>
                  </>
                ) : (
                  <>
                    <AlertTriangle className="w-5 h-5 text-[#B45309]" />
                    <span>{report.failures.length} Case(s) With Mismatches</span>
                  </>
                )}
              </div>

              {report.failures.length > 0 && (
                <select
                  aria-label="Filter benchmark failures"
                  value={categoryFilter}
                  onChange={(e) => setCategoryFilter(e.target.value)}
                  className="ae-input px-3 py-1.5 text-sm"
                >
                  <option value="ALL">All Groups</option>
                  {Array.from(new Set(report.failures.map((f) => f.categoryGroup))).map((g) => (
                    <option key={g} value={g}>{g}</option>
                  ))}
                </select>
              )}
            </div>

            {filteredFailures.length > 0 && (
              <div className="space-y-2.5 max-h-64 overflow-y-auto pt-2">
                {filteredFailures.map((f) => (
                  <div key={f.fixtureId} className="ae-well p-4 font-mono text-xs">
                    <div className="text-[#B45309] font-semibold">
                      [{f.fixtureId}] {f.description} (FP: {f.fpCount}, FN: {f.fnCount})
                    </div>
                    <div className="text-[#64748B] mt-1">
                      Expected: {JSON.stringify(f.expected)} | Actual: {JSON.stringify(f.actual)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
};
