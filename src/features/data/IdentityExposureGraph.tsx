import React, { useState } from 'react';
import type { CsvColumnMeta, CsvColumnRole } from '../../engine/csv/classify.ts';
import type { KAnonymityAssessment } from '../../engine/csv/risk.ts';

interface IdentityExposureGraphProps {
  columns: CsvColumnMeta[];
  beforeRisk: KAnonymityAssessment;
  afterRisk: KAnonymityAssessment | null;
}

const ROLE_COLOR: Record<CsvColumnRole, { stroke: string; fill: string; label: string }> = {
  direct_id: { stroke: '#DC2626', fill: '#FEF2F2', label: 'Direct ID (Masked)' },
  quasi_id: { stroke: '#B45309', fill: '#FFFBEB', label: 'Quasi-ID (Linkable)' },
  sensitive: { stroke: '#6366F1', fill: '#EEF2FF', label: 'Sensitive Attribute' },
  utility: { stroke: '#087F6D', fill: '#E1F5EF', label: 'Utility Field' },
  excluded: { stroke: '#64748B', fill: '#F1F5F9', label: 'Excluded' },
};

/**
 * Evidence-based Identity Exposure Map (Privacy Digital Twin).
 * Visualizes actual session column roles, equivalence-class linkage, and before/after singleton reduction.
 * Contains zero raw values and zero fabricated cross-person links.
 */
export const IdentityExposureGraph: React.FC<IdentityExposureGraphProps> = ({
  columns,
  beforeRisk,
  afterRisk,
}) => {
  const [selectedColIdx, setSelectedColIdx] = useState<number | null>(null);
  const [tableView, setTableView] = useState<boolean>(false);

  const activeRisk = afterRisk ?? beforeRisk;
  const width = 760;
  const height = Math.max(260, Math.min(420, 90 + columns.length * 42));
  const hubX = 380;
  const hubY = height / 2;

  const leftCols = columns.filter((c) => c.role === 'direct_id' || c.role === 'quasi_id');
  const rightCols = columns.filter((c) => c.role === 'sensitive' || c.role === 'utility' || c.role === 'excluded');

  const positionColumn = (idx: number, total: number, x: number) => {
    const span = Math.max(1, total - 1);
    const padY = 46;
    const avail = height - padY * 2;
    const y = total === 1 ? height / 2 : padY + (idx / span) * avail;
    return { x, y };
  };

  const selectedCol = columns.find((c) => c.index === selectedColIdx) ?? null;

  return (
    <div className="ae-well p-5 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="text-base font-semibold text-[#101828]">
            Identity Exposure Map (Privacy Digital Twin)
          </h4>
          <p className="text-sm text-[#64748B]">
            Edges represent attribute co-occurrence in the same CSV records—not inferred real-world identity.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setTableView((v) => !v)}
          className="ae-btn-secondary rounded-lg px-3.5 h-9 text-sm cursor-pointer"
        >
          {tableView ? 'Show Graph View' : 'Accessible Table View'}
        </button>
      </div>

      {tableView ? (
        <div className="overflow-x-auto bg-white rounded-xl border border-[#E2E8F0]">
          <table className="w-full text-left text-sm border-collapse">
            <thead>
              <tr className="border-b border-[#E2E8F0] bg-[#F8FAFC] text-[#64748B]">
                <th className="py-2.5 px-3.5 font-semibold">Column</th>
                <th className="py-2.5 px-3.5 font-semibold">Role</th>
                <th className="py-2.5 px-3.5 font-semibold">Distinct Values</th>
                <th className="py-2.5 px-3.5 font-semibold">Detected Direct PII Types</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#EDF0F4]">
              {columns.map((c) => (
                <tr key={c.index}>
                  <td className="py-2.5 px-3.5 font-mono text-[#101828]">{c.headerLabel}</td>
                  <td className="py-2.5 px-3.5 text-[#475569]">{ROLE_COLOR[c.role].label}</td>
                  <td className="py-2.5 px-3.5 font-mono text-[#475569]">{c.distinctCount}</td>
                  <td className="py-2.5 px-3.5 font-mono text-[#64748B]">
                    {c.detectedTypes.length > 0 ? c.detectedTypes.join(', ') : 'None'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="overflow-x-auto bg-white rounded-xl border border-[#E2E8F0] p-3">
          <svg
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label="Identity Exposure Map showing record groups connected to direct, quasi-identifier, and sensitive columns"
            className="w-full max-w-[760px] mx-auto block"
          >
            {leftCols.map((c, i) => {
              const pos = positionColumn(i, leftCols.length, 130);
              const style = ROLE_COLOR[c.role];
              return (
                <line
                  key={`el_${c.index}`}
                  x1={pos.x + 85}
                  y1={pos.y}
                  x2={hubX - 78}
                  y2={hubY}
                  stroke={style.stroke}
                  strokeOpacity={0.5}
                  strokeWidth={c.role === 'quasi_id' ? 2.5 : 1.5}
                  strokeDasharray={c.role === 'direct_id' ? '4 4' : undefined}
                />
              );
            })}

            {rightCols.map((c, i) => {
              const pos = positionColumn(i, rightCols.length, 630);
              const style = ROLE_COLOR[c.role];
              return (
                <line
                  key={`er_${c.index}`}
                  x1={hubX + 78}
                  y1={hubY}
                  x2={pos.x - 85}
                  y2={pos.y}
                  stroke={style.stroke}
                  strokeOpacity={0.45}
                  strokeWidth={c.role === 'sensitive' ? 2 : 1.2}
                />
              );
            })}

            <g>
              <rect
                x={hubX - 78}
                y={hubY - 42}
                width={156}
                height={84}
                rx={12}
                fill="#FFFFFF"
                stroke={activeRisk.singletonRows > 0 ? '#B45309' : '#087F6D'}
                strokeWidth={2}
              />
              <text x={hubX} y={hubY - 14} textAnchor="middle" fill="#101828" fontSize={12} fontWeight="bold">
                Record Groups
              </text>
              <text x={hubX} y={hubY + 6} textAnchor="middle" fill="#087F6D" fontSize={11} fontFamily="monospace">
                {activeRisk.applicable ? `k_min = ${activeRisk.kMin} | ${activeRisk.groupCount} groups` : 'Select QIs'}
              </text>
              <text x={hubX} y={hubY + 24} textAnchor="middle" fill={activeRisk.singletonRows > 0 ? '#B45309' : '#64748B'} fontSize={10}>
                {activeRisk.applicable ? `${activeRisk.singletonRows} singleton row(s)` : 'N/A'}
              </text>
            </g>

            {leftCols.map((c, i) => {
              const pos = positionColumn(i, leftCols.length, 130);
              const style = ROLE_COLOR[c.role];
              const isSel = selectedColIdx === c.index;
              return (
                <g
                  key={`nl_${c.index}`}
                  tabIndex={0}
                  role="button"
                  aria-label={`${c.headerLabel}: ${style.label}, ${c.distinctCount} distinct values`}
                  onClick={() => setSelectedColIdx(c.index)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') setSelectedColIdx(c.index);
                  }}
                  className="cursor-pointer"
                >
                  <rect
                    x={pos.x - 85}
                    y={pos.y - 17}
                    width={170}
                    height={34}
                    rx={8}
                    fill={style.fill}
                    stroke={isSel ? '#101828' : style.stroke}
                    strokeWidth={isSel ? 2 : 1.2}
                  />
                  <text x={pos.x} y={pos.y - 1} textAnchor="middle" fill="#101828" fontSize={11} fontWeight="600">
                    {c.headerLabel.slice(0, 20)}
                  </text>
                  <text x={pos.x} y={pos.y + 11} textAnchor="middle" fill="#475569" fontSize={9}>
                    {c.role === 'direct_id' ? 'Direct ID' : 'Quasi-ID'} ({c.distinctCount} distinct)
                  </text>
                </g>
              );
            })}

            {rightCols.map((c, i) => {
              const pos = positionColumn(i, rightCols.length, 630);
              const style = ROLE_COLOR[c.role];
              const isSel = selectedColIdx === c.index;
              return (
                <g
                  key={`nr_${c.index}`}
                  tabIndex={0}
                  role="button"
                  aria-label={`${c.headerLabel}: ${style.label}, ${c.distinctCount} distinct values`}
                  onClick={() => setSelectedColIdx(c.index)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') setSelectedColIdx(c.index);
                  }}
                  className="cursor-pointer"
                >
                  <rect
                    x={pos.x - 85}
                    y={pos.y - 17}
                    width={170}
                    height={34}
                    rx={8}
                    fill={style.fill}
                    stroke={isSel ? '#101828' : style.stroke}
                    strokeWidth={isSel ? 2 : 1.2}
                  />
                  <text x={pos.x} y={pos.y - 1} textAnchor="middle" fill="#101828" fontSize={11} fontWeight="600">
                    {c.headerLabel.slice(0, 20)}
                  </text>
                  <text x={pos.x} y={pos.y + 11} textAnchor="middle" fill="#475569" fontSize={9}>
                    {c.role} ({c.distinctCount} distinct)
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      )}

      {selectedCol && (
        <div className="rounded-xl border border-[#E2E8F0] bg-white px-4 py-3 text-sm flex flex-wrap items-center justify-between gap-2">
          <span>
            Selected: <strong className="font-mono text-[#087F6D]">{selectedCol.headerLabel}</strong> ({ROLE_COLOR[selectedCol.role].label})
          </span>
          <span className="text-[#64748B] font-mono text-[13px]">
            Distinct: {selectedCol.distinctCount} | Missing: {selectedCol.missingCount}
            {selectedCol.detectedTypes.length > 0 ? ` | PII: ${selectedCol.detectedTypes.join(', ')}` : ''}
          </span>
        </div>
      )}
    </div>
  );
};
