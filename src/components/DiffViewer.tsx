import React, { useRef } from 'react';
import type { DetectionCandidate, TransformationRecord } from '../engine/types.ts';
import { CATEGORY_COLORS } from './EntityBadge.tsx';

interface DiffViewerProps {
  originalText: string;
  sanitizedText: string;
  candidates: DetectionCandidate[];
  transformations: TransformationRecord[];
  selectedId: string | null;
  onSelectCandidate: (id: string) => void;
  syncScroll: boolean;
}

/**
 * Renders original & sanitized panes strictly as React text nodes (never HTML).
 * Supports clicking any highlighted span or redacted replacement to open the inspector.
 */
export const DiffViewer: React.FC<DiffViewerProps> = ({
  originalText,
  sanitizedText,
  candidates,
  transformations,
  selectedId,
  onSelectCandidate,
  syncScroll,
}) => {
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const syncing = useRef(false);

  const handleScroll = (source: 'left' | 'right') => {
    if (!syncScroll || syncing.current) return;
    const src = source === 'left' ? leftRef.current : rightRef.current;
    const dst = source === 'left' ? rightRef.current : leftRef.current;
    if (!src || !dst) return;
    syncing.current = true;
    const maxSrc = Math.max(1, src.scrollHeight - src.clientHeight);
    const ratio = src.scrollTop / maxSrc;
    dst.scrollTop = ratio * Math.max(1, dst.scrollHeight - dst.clientHeight);
    requestAnimationFrame(() => {
      syncing.current = false;
    });
  };

  const renderOriginalNodes = () => {
    if (!originalText) {
      return <span className="text-[#64748B]">Annotated original text appears here once loaded.</span>;
    }
    const sorted = [...candidates].sort((a, b) => a.start - b.start);
    const nodes: React.ReactNode[] = [];
    let cursor = 0;

    for (const c of sorted) {
      if (c.start < cursor || c.end > originalText.length) continue;
      if (c.start > cursor) {
        nodes.push(<span key={`plain_${cursor}`}>{originalText.slice(cursor, c.start)}</span>);
      }
      const color = CATEGORY_COLORS[c.type];
      const isSelected = selectedId === c.id;
      const isExcluded = c.reviewStatus === 'excluded';
      nodes.push(
        <button
          key={c.id}
          type="button"
          onClick={() => onSelectCandidate(c.id)}
          title={`${c.type}: ${c.validationStatus}`}
          className={`inline rounded-md px-1.5 py-0.5 border text-left font-mono transition cursor-pointer ${color.bg} ${color.border} ${color.text} ${
            isSelected ? 'ring-2 ring-[#087F6D]' : ''
          } ${isExcluded ? 'line-through opacity-55' : ''}`}
        >
          {originalText.slice(c.start, c.end)}
        </button>,
      );
      cursor = c.end;
    }
    if (cursor < originalText.length) {
      nodes.push(<span key={`tail_${cursor}`}>{originalText.slice(cursor)}</span>);
    }
    return nodes;
  };

  const renderSanitizedNodes = () => {
    if (!sanitizedText) {
      return <span className="text-[#64748B]">Sanitized output renders here live.</span>;
    }
    const sorted = [...transformations].sort((a, b) => a.outStart - b.outStart);
    const nodes: React.ReactNode[] = [];
    let cursor = 0;

    for (const t of sorted) {
      if (t.outStart < cursor || t.outEnd > sanitizedText.length) continue;
      if (t.outStart > cursor) {
        nodes.push(<span key={`splain_${cursor}`}>{sanitizedText.slice(cursor, t.outStart)}</span>);
      }
      const color = CATEGORY_COLORS[t.type];
      const isSelected = selectedId === t.candidateId;
      nodes.push(
        <button
          key={`out_${t.candidateId}`}
          type="button"
          onClick={() => onSelectCandidate(t.candidateId)}
          title={`${t.type} (${t.mode})`}
          className={`inline rounded-md px-1.5 py-0.5 border text-left font-mono transition cursor-pointer ${
            t.applied
              ? `${color.bg} ${color.border} ${color.text}`
              : 'bg-[#FFFBEB] border-[#FDE68A] text-[#B45309]'
          } ${isSelected ? 'ring-2 ring-[#087F6D]' : ''}`}
        >
          {sanitizedText.slice(t.outStart, t.outEnd)}
        </button>,
      );
      cursor = t.outEnd;
    }
    if (cursor < sanitizedText.length) {
      nodes.push(<span key={`stail_${cursor}`}>{sanitizedText.slice(cursor)}</span>);
    }
    return nodes;
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
      <div className="ae-card flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-[#EDF0F4] bg-[#F8FAFC] text-sm">
          <span className="font-semibold text-[#101828]">Annotated Original</span>
          <span className="text-[#64748B] font-mono text-[13px]">{candidates.length} highlighted</span>
        </div>
        <div
          ref={leftRef}
          onScroll={() => handleScroll('left')}
          data-testid="annotated-original-pane"
          className="p-5 font-mono text-[14px] leading-7 whitespace-pre-wrap break-words h-80 overflow-y-auto select-text text-[#1E293B] bg-white"
        >
          {renderOriginalNodes()}
        </div>
      </div>

      <div className="ae-card flex flex-col overflow-hidden border-[#087F6D]/30">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-[#EDF0F4] bg-[#E1F5EF]/55 text-sm">
          <span className="font-semibold text-[#087F6D]">Sanitized Output</span>
          <span className="text-[#15803D] font-mono text-[13px] font-medium">
            {transformations.filter((t) => t.applied).length} protected
          </span>
        </div>
        <div
          ref={rightRef}
          onScroll={() => handleScroll('right')}
          data-testid="sanitized-output-pane"
          className="p-5 font-mono text-[14px] leading-7 whitespace-pre-wrap break-words h-80 overflow-y-auto select-text text-[#101828] bg-white"
        >
          {renderSanitizedNodes()}
        </div>
      </div>
    </div>
  );
};
