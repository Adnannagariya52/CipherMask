import React, { useMemo, useRef, useState } from 'react';
import {
  Upload,
  Sparkles,
  Copy,
  Download,
  Trash2,
  Eye,
  EyeOff,
  AlertTriangle,
  CheckCircle2,
  ShieldAlert,
  Brain,
  SlidersHorizontal,
  PlusSquare,
  FileCheck2,
  KeyRound,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { useSession } from '../../state/session.tsx';
import { createDefaultPolicy } from '../../engine/redaction.ts';
import {
  ENTITY_LABELS,
  type CoreRedactionMode,
  type DetectionCandidate,
  type EntityType,
  type PresetId,
  type RedactionMode,
} from '../../engine/types.ts';
import { MIXED_FORMATS_SAMPLE, NOISY_TEXT_SAMPLE } from '../../fixtures/samples.ts';
import { DiffViewer } from '../../components/DiffViewer.tsx';
import { EntityBadge, ValidationBadge } from '../../components/EntityBadge.tsx';
import { PageHeader } from '../../components/ui/PageHeader.tsx';
import { sha256Text } from '../../engine/crypto/hash.ts';
import { createAuditReceipt } from '../../engine/audit.ts';
import type { VaultPayload } from '../../engine/crypto/vault.ts';
import { sharedGemmaReasoner } from '../../intelligence/localReasoner.ts';
import { runGemmaSemanticDetection } from '../../intelligence/semanticDetector.ts';
import { fuseDetectionsWithGemma, type HybridFusionResult } from '../../intelligence/fusion.ts';

const TXT_MAX_BYTES = 2 * 1024 * 1024;
const MANDATORY_TYPES: EntityType[] = ['EMAIL', 'PHONE', 'IPV4', 'IPV6', 'PAN', 'AADHAAR', 'CARD'];

function triggerDownload(filename: string, bytes: Uint8Array, mime: string) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const blob = new Blob([copy.buffer], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const TextShield: React.FC = () => {
  const {
    textInput,
    setTextInput,
    textFilename,
    setTextFilename,
    textPolicy,
    setTextPolicy,
    textDetection,
    textRedaction,
    textBusy,
    nerStatus,
    nerProgress,
    nerMessage,
    runNerScan,
    setLastAuditReceipt,
    setStagedVaultPayload,
    setActiveModule,
    pushToast,
    announce,
  } = useSession();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  const [inspectorTab, setInspectorTab] = useState<'accepted' | 'rejected' | 'uncertain'>('accepted');
  const [revealRawInInspector, setRevealRawInInspector] = useState<boolean>(false);
  const [syncScroll, setSyncScroll] = useState<boolean>(true);
  const [showAdvancedControls, setShowAdvancedControls] = useState<boolean>(false);
  const [typeFilter, setTypeFilter] = useState<EntityType | 'ALL'>('ALL');
  const [dragActive, setDragActive] = useState<boolean>(false);
  const [pendingConfirmSample, setPendingConfirmSample] = useState<'noisy' | 'mixed' | null>(null);
  const [gemmaHybridBusy, setGemmaHybridBusy] = useState<boolean>(false);
  const [hybridResult, setHybridResult] = useState<HybridFusionResult | null>(null);

  const allCandidates = useMemo(
    () => [...textDetection.accepted, ...textDetection.rejected, ...textDetection.uncertain],
    [textDetection],
  );

  const selectedCandidate: DetectionCandidate | null = useMemo(() => {
    if (!selectedCandidateId) return null;
    return allCandidates.find((c) => c.id === selectedCandidateId) ?? null;
  }, [allCandidates, selectedCandidateId]);

  const filteredInspectorList = useMemo(() => {
    const base =
      inspectorTab === 'accepted'
        ? textDetection.accepted
        : inspectorTab === 'rejected'
          ? textDetection.rejected
          : textDetection.uncertain;
    if (typeFilter === 'ALL') return base;
    return base.filter((c) => c.type === typeFilter);
  }, [inspectorTab, textDetection, typeFilter]);

  const handleLoadFile = async (file: File) => {
    if (file.size > TXT_MAX_BYTES) {
      pushToast('error', `File "${file.name}" exceeds 2 MiB limit.`);
      return;
    }
    const lower = file.name.toLowerCase();
    if (!lower.endsWith('.txt') && !lower.endsWith('.log') && !lower.endsWith('.md') && file.type !== 'text/plain') {
      pushToast('warning', 'Unsupported extension; attempting UTF-8 plain text decode.');
    }
    const buf = new Uint8Array(await file.arrayBuffer());
    const text = new TextDecoder('utf-8', { fatal: false }).decode(buf).replace(/^\uFEFF/, '');
    setTextFilename(file.name.replace(/[^A-Za-z0-9._-]/g, '_'));
    setTextInput(text);
    setSelectedCandidateId(null);
    announce(`Loaded ${file.name} locally (${buf.byteLength} bytes).`);
    pushToast('success', `Loaded ${file.name} locally.`);
  };

  const applySample = (kind: 'noisy' | 'mixed', bypassConfirm = false) => {
    if (
      !bypassConfirm &&
      textInput.trim().length > 0 &&
      textInput !== NOISY_TEXT_SAMPLE &&
      textInput !== MIXED_FORMATS_SAMPLE
    ) {
      setPendingConfirmSample(kind);
      return;
    }
    setPendingConfirmSample(null);
    const sampleText = kind === 'noisy' ? NOISY_TEXT_SAMPLE : MIXED_FORMATS_SAMPLE;
    setTextFilename(kind === 'noisy' ? 'sample-noisy-ticket.txt' : 'sample-mixed-formats.txt');
    setTextInput(sampleText);
    setSelectedCandidateId(null);
    announce(`Loaded ${kind} synthetic sample.`);
  };

  const switchPreset = (preset: PresetId) => {
    const base = createDefaultPolicy(preset);
    setTextPolicy((prev) => ({
      ...base,
      enableLeakHunter: prev.enableLeakHunter,
      enableNer: prev.enableNer,
      conservativeMaskInvalid: prev.conservativeMaskInvalid,
      entityOverrides: prev.entityOverrides,
      manualSpans: prev.manualSpans,
    }));
  };

  const switchMode = (mode: CoreRedactionMode) => {
    setTextPolicy((prev) => ({
      ...prev,
      preset: prev.preset === 'CUSTOM' ? 'CUSTOM' : mode === 'FULL' ? 'AI_SAFE' : mode === 'PARTIAL' ? 'SUPPORT' : 'RESEARCH',
      defaultMode: mode,
      categoryModes: mode === 'PARTIAL' && prev.preset === 'SUPPORT' ? prev.categoryModes : {},
    }));
  };

  const updateCategoryMode = (type: EntityType, mode: RedactionMode | 'DEFAULT') => {
    setTextPolicy((prev) => {
      const nextCats = { ...prev.categoryModes };
      if (mode === 'DEFAULT') delete nextCats[type];
      else nextCats[type] = mode;
      return { ...prev, preset: 'CUSTOM', categoryModes: nextCats };
    });
  };

  const updateEntityOverride = (id: string, patch: { reviewStatus?: 'included' | 'excluded' | 'pending'; mode?: RedactionMode }) => {
    setTextPolicy((prev) => ({
      ...prev,
      entityOverrides: {
        ...prev.entityOverrides,
        [id]: {
          ...prev.entityOverrides[id],
          ...patch,
        },
      },
    }));
  };

  const handleRunHybridGemma = async () => {
    if (!textInput.trim()) return;
    if (sharedGemmaReasoner.getStatus().state !== 'ready') {
      pushToast('info', 'Local Gemma 3 4B is not loaded yet; open Local AI & Cloud Setup to load weights. Rule engine remains active.');
      return;
    }
    setGemmaHybridBusy(true);
    try {
      const semRes = await runGemmaSemanticDetection(sharedGemmaReasoner, textInput, 'text_shield', 1);
      const fused = fuseDetectionsWithGemma(
        textInput,
        'text_shield',
        1,
        textDetection,
        semRes.grounded,
        semRes.ungroundedCount,
        true,
      );
      setHybridResult(fused);
      pushToast(
        'success',
        `Hybrid scan complete: ${fused.metrics.ruleFindingsCount} rule + ${fused.metrics.aiOnlyAdditions} Gemma-only (${fused.metrics.ungroundedRejectedCount} ungrounded rejected).`,
      );
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : 'Hybrid Gemma scan failed.');
    } finally {
      setGemmaHybridBusy(false);
    }
  };

  const handleMarkSelectedManually = () => {
    const el = textareaRef.current;
    if (!el) return;
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    if (end <= start) {
      pushToast('info', 'Highlight a span in the raw text box first to mark it manually.');
      return;
    }
    const id = `manual_${start}_${end}`;
    setTextPolicy((prev) => ({
      ...prev,
      manualSpans: [
        ...prev.manualSpans.filter((m) => !(m.start === start && m.end === end)),
        { id, start, end, type: 'MANUAL', label: 'Manual user selection' },
      ],
    }));
    setSelectedCandidateId(id);
    pushToast('success', `Added manual span (${start}–${end}).`);
  };

  const buildCurrentReceipt = async (outputBytes: Uint8Array) => {
    const enabledMethods = ['regex', 'checksum', 'parser'];
    if (textPolicy.enableLeakHunter) enabledMethods.push('leak_hunter');
    if (textPolicy.enableNer) enabledMethods.push('ner');

    const byType: Record<string, number> = {};
    for (const [k, v] of Object.entries(textDetection.countsByType)) {
      if (typeof v === 'number') byType[k] = v;
    }

    const receipt = await createAuditReceipt({
      inputFormat: textFilename === 'pasted-note.txt' ? 'paste' : 'txt',
      inputByteSize: new TextEncoder().encode(textInput).byteLength,
      outputFormat: 'text/plain; charset=utf-8',
      outputBytes,
      policyPreset: textPolicy.preset,
      defaultMode: textPolicy.defaultMode,
      enabledMethods,
      counts: {
        totalDetected: textDetection.totalAcceptedOccurrences,
        uniqueEntities: textDetection.uniqueAcceptedCount,
        applied: textRedaction.appliedCount,
        excluded: textRedaction.excludedCount,
        rejected: textDetection.rejected.length,
        uncertain: textDetection.uncertain.length,
        byType,
      },
      durationsMs: {
        detection: textDetection.durationMs,
        redaction: textRedaction.durationMs,
      },
      statusLabel: textRedaction.verification.statusLabel,
      remainingFindings: textRedaction.verification.remainingCount,
      limitations: [
        'Local rules & optional BERT-NER do not guarantee 100% recall.',
        'Luhn/Verhoeff validate checksums only, not live identity existence.',
        ...(textPolicy.defaultMode === 'PARTIAL'
          ? ['Partial Mask mode intentionally retains configured prefix/suffix characters.']
          : []),
      ],
      offlineAssetStatus: {
        rulesEngine: 'ready',
        ner: nerStatus,
      },
    });
    setLastAuditReceipt(receipt);
    return receipt;
  };

  const handleCopySanitized = async () => {
    if (!textRedaction.sanitizedText || textBusy) return;
    try {
      await navigator.clipboard.writeText(textRedaction.sanitizedText);
      pushToast('success', 'Copied sanitized text to clipboard.');
    } catch {
      pushToast('error', 'Clipboard write failed. Use Download TXT instead.');
    }
  };

  const handleDownloadSanitized = async () => {
    if (!textRedaction.sanitizedText || textBusy) return;
    const { bytes } = await sha256Text(textRedaction.sanitizedText);
    const outName = textFilename.replace(/\.txt$/i, '') + '.sanitized.txt';
    triggerDownload(outName, bytes, 'text/plain; charset=utf-8');
    await buildCurrentReceipt(bytes);
    pushToast('success', `Downloaded ${outName} and generated SHA-256 audit receipt.`);
  };

  const handleStageVault = async () => {
    if (!textRedaction.sanitizedText || textBusy) return;
    const pseudoRecords = textRedaction.transformations
      .filter((t) => t.applied && t.mode === 'PSEUDONYM')
      .map((t) => ({
        type: t.type,
        token: t.replacement,
        originalSlice: t.originalSlice,
        outStart: t.outStart,
        outEnd: t.outEnd,
      }));
    if (pseudoRecords.length === 0) {
      pushToast('warning', 'Switch to Consistent Pseudonym mode first to create a reversible vault.');
      return;
    }
    const { sha256Hex } = await sha256Text(textRedaction.sanitizedText);
    const payload: VaultPayload = {
      schemaVersion: 1,
      format: 'text',
      sanitizedSha256: sha256Hex,
      records: pseudoRecords,
    };
    setStagedVaultPayload(payload);
    setActiveModule('vault');
    pushToast('info', `Staged ${pseudoRecords.length} pseudonym record(s) for encrypted vault export.`);
  };

  const exportDisabled = !textInput || textBusy;

  return (
    <div className="space-y-8 ae-fade-in">
      <PageHeader
        eyebrow="Text Sanitization Workspace"
        title="Text Shield"
        description="Detect, validate, and redact structured identifiers and contextual entities locally in browser memory."
        actions={
          <div className="inline-flex items-center rounded-xl border border-[#E2E8F0] bg-[#FFFFFF] p-1 gap-1 shadow-2xs">
            {(['FULL', 'PARTIAL', 'PSEUDONYM'] as CoreRedactionMode[]).map((mode) => {
              const active = textPolicy.defaultMode === mode;
              const label =
                mode === 'FULL' ? 'Full Mask' : mode === 'PARTIAL' ? 'Partial Mask' : 'Consistent Pseudonym';
              return (
                <button
                  key={mode}
                  type="button"
                  data-testid={`mode-${mode.toLowerCase()}`}
                  onClick={() => switchMode(mode)}
                  className={`rounded-lg px-3.5 h-9 text-sm font-semibold transition cursor-pointer ${
                    active
                      ? 'bg-[#E1F5EF] text-[#087F6D]'
                      : 'text-[#475569] hover:text-[#101828] hover:bg-[#F7F9FC]'
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        }
      />

      {/* Primary Toolbar */}
      <section className="ae-card p-5 sm:p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2.5">
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt,.log,.md,text/plain"
              className="hidden"
              data-testid="text-file-input"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleLoadFile(f);
                e.target.value = '';
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="ae-btn-secondary inline-flex items-center gap-2 rounded-xl px-4 h-11 text-[15px] cursor-pointer"
            >
              <Upload className="w-4 h-4 text-[#087F6D]" aria-hidden="true" />
              <span>Upload .TXT</span>
            </button>

            <button
              type="button"
              data-testid="load-noisy-sample-btn"
              onClick={() => applySample('noisy')}
              className="ae-btn-primary inline-flex items-center gap-2 rounded-xl px-4 h-11 text-[15px] cursor-pointer"
            >
              <Sparkles className="w-4 h-4" aria-hidden="true" />
              <span>Load Noisy Sample</span>
            </button>

            <button
              type="button"
              data-testid="load-mixed-sample-btn"
              onClick={() => applySample('mixed')}
              className="ae-btn-secondary inline-flex items-center gap-2 rounded-xl px-4 h-11 text-[15px] cursor-pointer"
            >
              <span>Mixed &amp; Obfuscated Sample</span>
            </button>

            {textInput && (
              <button
                type="button"
                onClick={() => {
                  setTextInput('');
                  setSelectedCandidateId(null);
                }}
                className="inline-flex items-center gap-1.5 rounded-xl border border-[#E2E8F0] px-3.5 h-11 text-sm font-medium text-[#64748B] hover:text-[#DC2626] hover:border-[#FECACA] hover:bg-[#FEF2F2] transition cursor-pointer"
              >
                <Trash2 className="w-4 h-4" aria-hidden="true" />
                <span>Clear</span>
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <select
              aria-label="Redaction preset"
              value={textPolicy.preset}
              onChange={(e) => switchPreset(e.target.value as PresetId)}
              className="ae-input px-3.5 h-11 text-sm font-medium"
            >
              <option value="AI_SAFE">Preset: AI Safe Sharing (Full Mask)</option>
              <option value="SUPPORT">Preset: Customer Support (Partial + Full)</option>
              <option value="RESEARCH">Preset: Research / Analytics (Pseudonyms)</option>
              <option value="CUSTOM">Preset: Custom Policy</option>
            </select>

            <button
              type="button"
              onClick={runNerScan}
              disabled={nerStatus === 'loading' || !textInput.trim()}
              className="ae-btn-indigo inline-flex items-center gap-2 rounded-xl px-4 h-11 text-sm disabled:opacity-45 cursor-pointer"
            >
              <Brain className="w-4 h-4" aria-hidden="true" />
              <span>{nerStatus === 'loading' ? `NER ${Math.round(nerProgress * 100)}%` : 'Run Local BERT-NER'}</span>
            </button>

            <button
              type="button"
              data-testid="run-hybrid-gemma-btn"
              onClick={handleRunHybridGemma}
              disabled={gemmaHybridBusy || !textInput.trim()}
              className="ae-btn-indigo inline-flex items-center gap-2 rounded-xl px-4 h-11 text-sm disabled:opacity-45 cursor-pointer"
            >
              <Sparkles className="w-4 h-4" aria-hidden="true" />
              <span>{gemmaHybridBusy ? 'Running Gemma 3 4B...' : 'Hybrid Gemma Scan'}</span>
            </button>

            <button
              type="button"
              onClick={() => setShowAdvancedControls((v) => !v)}
              className="ae-btn-secondary inline-flex items-center gap-2 rounded-xl px-4 h-11 text-sm cursor-pointer"
            >
              <SlidersHorizontal className="w-4 h-4 text-[#475569]" aria-hidden="true" />
              <span>Overrides</span>
              {showAdvancedControls ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>
          </div>
        </div>

        {/* Collapsible Advanced Drawer */}
        {showAdvancedControls && (
          <div className="pt-5 border-t border-[#EDF0F4] space-y-4 text-sm">
            <div className="flex flex-wrap items-center gap-6">
              <label className="inline-flex items-center gap-2.5 cursor-pointer text-[#475569] font-medium">
                <input
                  type="checkbox"
                  checked={textPolicy.enableLeakHunter}
                  onChange={(e) =>
                    setTextPolicy((prev) => ({ ...prev, enableLeakHunter: e.target.checked }))
                  }
                  className="h-4 w-4 accent-[#087F6D]"
                />
                <span>Leak Hunter (Zero-width chars, Unicode digits &amp; obfuscated emails)</span>
              </label>

              <label className="inline-flex items-center gap-2.5 cursor-pointer text-[#475569] font-medium">
                <input
                  type="checkbox"
                  checked={textPolicy.conservativeMaskInvalid}
                  onChange={(e) =>
                    setTextPolicy((prev) => ({ ...prev, conservativeMaskInvalid: e.target.checked }))
                  }
                  className="h-4 w-4 accent-[#087F6D]"
                />
                <span>Flag Invalid Checksums for Manual Review</span>
              </label>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
              {MANDATORY_TYPES.map((t) => (
                <div key={t} className="ae-well p-3 space-y-1.5">
                  <div className="font-semibold text-[#101828] text-[13px]">{ENTITY_LABELS[t]}</div>
                  <select
                    aria-label={`${ENTITY_LABELS[t]} mode override`}
                    value={textPolicy.categoryModes[t] ?? 'DEFAULT'}
                    onChange={(e) => updateCategoryMode(t, e.target.value as RedactionMode | 'DEFAULT')}
                    className="ae-input w-full px-2.5 py-1.5 text-[13px]"
                  >
                    <option value="DEFAULT">Default ({textPolicy.defaultMode})</option>
                    <option value="FULL">Full Mask</option>
                    <option value="PARTIAL">Partial Mask</option>
                    <option value="PSEUDONYM">Pseudonym</option>
                    <option value="KEEP">Keep Unmasked</option>
                  </select>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      {pendingConfirmSample && (
        <div className="rounded-xl border border-[#FDE68A] bg-[#FFFBEB] p-4 flex flex-wrap items-center justify-between gap-3 text-sm">
          <span className="text-[#B45309] font-medium">Replace your current unsaved text with the synthetic sample?</span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => applySample(pendingConfirmSample, true)}
              className="rounded-lg px-4 h-9 bg-[#B45309] text-white font-semibold cursor-pointer"
            >
              Replace Text
            </button>
            <button
              type="button"
              onClick={() => setPendingConfirmSample(null)}
              className="ae-btn-secondary rounded-lg px-4 h-9 cursor-pointer"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {nerStatus === 'loading' && (
        <div className="ae-card p-4 text-sm flex items-center justify-between gap-4 border-[#C7D2FE] bg-[#EEF2FF]/60">
          <span className="font-medium text-[#4338CA]">{nerMessage}</span>
          <div className="w-48 h-2 rounded-full bg-[#E2E8F0] overflow-hidden">
            <div
              className="h-full bg-[#6366F1] transition-all"
              style={{ width: `${Math.max(5, Math.round(nerProgress * 100))}%` }}
            />
          </div>
        </div>
      )}

      {/* Clean KPI Strip */}
      <section className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4" aria-label="Detection summary metrics">
        {[
          { label: 'Detected', val: textDetection.totalAcceptedOccurrences, testId: 'stat-total' },
          { label: 'Unique Entities', val: textDetection.uniqueAcceptedCount, testId: 'stat-unique' },
          { label: 'Protected', val: textRedaction.appliedCount, testId: 'stat-applied', accent: 'text-[#087F6D]' },
          { label: 'Rejected', val: textDetection.rejected.length, testId: 'stat-rejected', accent: 'text-[#DC2626]' },
          { label: 'Review Queue', val: textDetection.uncertain.length, testId: 'stat-pending', accent: 'text-[#B45309]' },
          { label: 'Latency', val: `${textDetection.durationMs} ms`, testId: 'stat-time' },
        ].map((card) => (
          <div key={card.label} className="ae-card px-5 py-4">
            <div className="text-[13px] font-medium text-[#64748B]">{card.label}</div>
            <div data-testid={card.testId} className={`text-2xl font-semibold font-mono tabular-nums mt-1 ${card.accent || 'text-[#101828]'}`}>
              {card.val}
            </div>
          </div>
        ))}
      </section>

      {/* Category Filter Strip */}
      <section className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setTypeFilter('ALL')}
          className={`rounded-lg border px-3 py-1.5 text-[13px] font-medium transition cursor-pointer ${
            typeFilter === 'ALL'
              ? 'border-[#087F6D] bg-[#E1F5EF] text-[#087F6D]'
              : 'border-[#E2E8F0] bg-white text-[#475569] hover:text-[#101828]'
          }`}
        >
          All ({textDetection.totalAcceptedOccurrences})
        </button>
        {MANDATORY_TYPES.map((t) => (
          <EntityBadge
            key={t}
            type={t}
            count={textDetection.countsByType[t] ?? 0}
            active={typeFilter === 'ALL' || typeFilter === t}
            onClick={() => setTypeFilter((prev) => (prev === t ? 'ALL' : t))}
          />
        ))}
        {(['PERSON', 'LOCATION', 'ORGANIZATION', 'MANUAL'] as EntityType[]).map((t) => {
          const cnt = textDetection.countsByType[t] ?? 0;
          if (cnt === 0) return null;
          return (
            <EntityBadge
              key={t}
              type={t}
              count={cnt}
              active={typeFilter === 'ALL' || typeFilter === t}
              onClick={() => setTypeFilter((prev) => (prev === t ? 'ALL' : t))}
            />
          );
        })}
      </section>

      {hybridResult && (
        <section className="rounded-xl border border-[#C7D2FE] bg-[#EEF2FF] px-5 py-3.5 text-sm flex flex-wrap items-center justify-between gap-2">
          <div className="font-mono text-[13px] text-[#4338CA] font-medium">
            Hybrid Fusion — Rules: {hybridResult.metrics.ruleFindingsCount} | Gemma Grounded: {hybridResult.metrics.gemmaGroundedCount} | Both: {hybridResult.metrics.overlapCount} | AI-Only: {hybridResult.metrics.aiOnlyAdditions} | Ungrounded Rejected: {hybridResult.metrics.ungroundedRejectedCount}
          </div>
          <button
            type="button"
            onClick={() => setHybridResult(null)}
            className="text-sm font-medium text-[#475569] hover:text-[#101828] cursor-pointer"
          >
            Dismiss
          </button>
        </section>
      )}

      {/* Main 2-Column Document Workspace */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
        <div className="xl:col-span-8 space-y-6">
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragActive(false);
              const f = e.dataTransfer.files?.[0];
              if (f) handleLoadFile(f);
            }}
            className={`ae-card transition overflow-hidden ${
              dragActive ? 'border-[#087F6D] ring-4 ring-[#087F6D]/15' : ''
            }`}
          >
            <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5 border-b border-[#EDF0F4] bg-[#F8FAFC]">
              <div className="flex items-center gap-3">
                <span className="text-sm font-semibold text-[#101828]">Source Input</span>
                <span className="font-mono text-[13px] text-[#64748B]">{textFilename}</span>
                {textBusy && <span className="text-[#087F6D] font-mono text-[13px] font-medium">Scanning...</span>}
              </div>
              <div className="flex items-center gap-4">
                <button
                  type="button"
                  onClick={handleMarkSelectedManually}
                  className="ae-btn-secondary inline-flex items-center gap-1.5 rounded-lg px-3 h-8 text-[13px] cursor-pointer"
                >
                  <PlusSquare className="w-3.5 h-3.5 text-[#087F6D]" aria-hidden="true" />
                  <span>Mark Selection</span>
                </button>
                <label className="inline-flex items-center gap-2 text-[13px] text-[#475569] font-medium cursor-pointer">
                  <input
                    type="checkbox"
                    checked={syncScroll}
                    onChange={(e) => setSyncScroll(e.target.checked)}
                    className="h-4 w-4 accent-[#087F6D]"
                  />
                  <span>Sync Scroll</span>
                </label>
              </div>
            </div>
            <textarea
              ref={textareaRef}
              data-testid="raw-text-input"
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              placeholder="Paste logs, support tickets, or drop a .txt file here — or click 'Load Noisy Sample' above..."
              rows={8}
              aria-label="Raw sensitive input text"
              className="w-full bg-white p-5 font-mono text-[14px] leading-7 text-[#101828] placeholder-[#94A3B8] focus:outline-none resize-y"
            />
          </div>

          <DiffViewer
            originalText={textInput}
            sanitizedText={textRedaction.sanitizedText}
            candidates={
              typeFilter === 'ALL'
                ? textDetection.accepted
                : textDetection.accepted.filter((c) => c.type === typeFilter)
            }
            transformations={textRedaction.transformations}
            selectedId={selectedCandidateId}
            onSelectCandidate={(id) => {
              setSelectedCandidateId(id);
              setRevealRawInInspector(false);
            }}
            syncScroll={syncScroll}
          />
        </div>

        {/* Entity & Validation Inspector */}
        <aside className="xl:col-span-4 ae-card flex flex-col overflow-hidden">
          <div className="p-5 border-b border-[#EDF0F4] space-y-3">
            <h2 className="text-lg font-semibold text-[#101828]">Entity Inspector</h2>
            <div className="grid grid-cols-3 gap-1 rounded-xl border border-[#E2E8F0] bg-[#F7F9FC] p-1 text-[13px]">
              {(
                [
                  { id: 'accepted', label: `Valid (${textDetection.accepted.length})` },
                  { id: 'rejected', label: `Rejected (${textDetection.rejected.length})` },
                  { id: 'uncertain', label: `Review (${textDetection.uncertain.length})` },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  data-testid={`inspector-tab-${tab.id}`}
                  onClick={() => setInspectorTab(tab.id)}
                  className={`rounded-lg py-1.5 font-medium transition cursor-pointer ${
                    inspectorTab === tab.id
                      ? 'bg-[#FFFFFF] text-[#087F6D] shadow-2xs border border-[#E2E8F0]'
                      : 'text-[#64748B] hover:text-[#101828] border border-transparent'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          {selectedCandidate && (
            <div className="p-5 border-b border-[#EDF0F4] bg-[#F8FAFC] space-y-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <EntityBadge type={selectedCandidate.type} />
                <ValidationBadge status={selectedCandidate.validationStatus} />
              </div>

              <div className="flex items-center justify-between gap-2 rounded-xl border border-[#E2E8F0] bg-white px-3.5 py-2.5">
                <span className="font-mono text-[#101828] truncate">
                  {revealRawInInspector ? selectedCandidate.rawText : selectedCandidate.maskedPreview}
                </span>
                <button
                  type="button"
                  onClick={() => setRevealRawInInspector((v) => !v)}
                  className="inline-flex items-center gap-1.5 text-[13px] font-medium text-[#087F6D] shrink-0 cursor-pointer"
                >
                  {revealRawInInspector ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  {revealRawInInspector ? 'Hide' : 'Reveal'}
                </button>
              </div>

              <p className="text-sm text-[#475569] leading-relaxed">{selectedCandidate.evidence}</p>
              <div className="text-xs font-mono text-[#64748B]">
                Method: {selectedCandidate.method} | Span: [{selectedCandidate.start}, {selectedCandidate.end})
              </div>

              <div className="flex flex-wrap items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => updateEntityOverride(selectedCandidate.id, { reviewStatus: 'included' })}
                  className="rounded-lg border border-[#BBF7D0] bg-[#ECFDF3] px-3 py-1.5 text-[13px] font-medium text-[#15803D] cursor-pointer"
                >
                  Include
                </button>
                <button
                  type="button"
                  onClick={() => updateEntityOverride(selectedCandidate.id, { reviewStatus: 'excluded' })}
                  className="rounded-lg border border-[#FDE68A] bg-[#FFFBEB] px-3 py-1.5 text-[13px] font-medium text-[#B45309] cursor-pointer"
                >
                  Exclude
                </button>
                <select
                  aria-label="Per-entity mode override"
                  value={textPolicy.entityOverrides[selectedCandidate.id]?.mode ?? ''}
                  onChange={(e) => {
                    const val = e.target.value as RedactionMode | '';
                    updateEntityOverride(selectedCandidate.id, {
                      reviewStatus: val === 'KEEP' ? 'excluded' : 'included',
                      mode: val || undefined,
                    });
                  }}
                  className="ae-input px-2.5 py-1.5 text-[13px]"
                >
                  <option value="">Policy Default</option>
                  <option value="FULL">Full Mask</option>
                  <option value="PARTIAL">Partial Mask</option>
                  <option value="PSEUDONYM">Pseudonym</option>
                </select>
              </div>
            </div>
          )}

          <div className="flex-1 overflow-y-auto divide-y divide-[#EDF0F4] max-h-[520px]">
            {filteredInspectorList.length === 0 ? (
              <div className="p-10 text-sm text-[#64748B] text-center">
                No {inspectorTab} candidates for the current filter.
              </div>
            ) : (
              filteredInspectorList.map((c) => {
                const isSelected = selectedCandidateId === c.id;
                const ov = textPolicy.entityOverrides[c.id];
                const effectiveExcluded = (ov?.reviewStatus ?? c.reviewStatus) === 'excluded';
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => {
                      setSelectedCandidateId(c.id);
                      setRevealRawInInspector(false);
                    }}
                    className={`w-full text-left px-5 py-3.5 text-sm transition hover:bg-[#F7F9FC] cursor-pointer ${
                      isSelected ? 'bg-[#E1F5EF]/60 border-l-4 border-l-[#087F6D]' : ''
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <EntityBadge type={c.type} />
                        {c.fromLeakHunter && (
                          <span className="rounded-md bg-[#FFFBEB] border border-[#FDE68A] px-2 py-0.5 text-[11px] font-medium text-[#B45309]">
                            Leak Hunter
                          </span>
                        )}
                      </div>
                      <ValidationBadge status={c.validationStatus} />
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-2 font-mono text-[13px]">
                      <span className={`truncate ${effectiveExcluded ? 'line-through text-[#64748B]' : 'text-[#101828]'}`}>
                        {c.maskedPreview}
                      </span>
                      <span className="text-[#64748B] shrink-0 text-xs">[{c.start}:{c.end}]</span>
                    </div>
                    <div className="mt-1 text-[13px] text-[#475569] line-clamp-2">{c.evidence}</div>
                  </button>
                );
              })
            )}
          </div>
        </aside>
      </div>

      {/* Verification & Export Footer */}
      <section className="ae-card p-5 sm:p-6 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-start gap-3">
          {textRedaction.verification.remainingCount > 0 ? (
            <ShieldAlert className="w-5 h-5 text-[#DC2626] shrink-0 mt-0.5" aria-hidden="true" />
          ) : textRedaction.verification.excludedCount > 0 || textRedaction.verification.pendingCount > 0 ? (
            <AlertTriangle className="w-5 h-5 text-[#B45309] shrink-0 mt-0.5" aria-hidden="true" />
          ) : (
            <CheckCircle2 className="w-5 h-5 text-[#15803D] shrink-0 mt-0.5" aria-hidden="true" />
          )}
          <div>
            <div data-testid="verification-status" className="text-[15px] font-semibold text-[#101828]">
              {textInput ? textRedaction.verification.statusLabel : 'Ready — paste text or load a synthetic sample'}
            </div>
            <div className="text-sm text-[#64748B] mt-0.5">
              Output verified with secondary rule + Leak Hunter passes; does not guarantee 100% recall.
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            disabled={exportDisabled}
            onClick={handleCopySanitized}
            data-testid="copy-sanitized-btn"
            className="ae-btn-secondary inline-flex items-center gap-2 rounded-xl px-4 h-11 text-[15px] disabled:opacity-45 cursor-pointer"
          >
            <Copy className="w-4 h-4 text-[#475569]" aria-hidden="true" />
            <span>Copy Sanitized</span>
          </button>

          <button
            type="button"
            disabled={exportDisabled}
            onClick={handleDownloadSanitized}
            data-testid="download-txt-btn"
            className="ae-btn-primary inline-flex items-center gap-2 rounded-xl px-5 h-11 text-[15px] disabled:opacity-45 cursor-pointer"
          >
            <Download className="w-4 h-4" aria-hidden="true" />
            <span>Download Sanitized .TXT</span>
          </button>

          {textPolicy.defaultMode === 'PSEUDONYM' && textRedaction.appliedCount > 0 && (
            <button
              type="button"
              disabled={exportDisabled}
              onClick={handleStageVault}
              className="ae-btn-secondary inline-flex items-center gap-2 rounded-xl px-4 h-11 text-[15px] text-[#087F6D] border-[#087F6D]/35 hover:bg-[#E1F5EF] cursor-pointer"
            >
              <KeyRound className="w-4 h-4" aria-hidden="true" />
              <span>Save Vault</span>
            </button>
          )}

          <button
            type="button"
            disabled={exportDisabled}
            onClick={async () => {
              const { bytes } = await sha256Text(textRedaction.sanitizedText);
              await buildCurrentReceipt(bytes);
              setActiveModule('audit');
            }}
            className="ae-btn-secondary inline-flex items-center gap-2 rounded-xl px-4 h-11 text-[15px] disabled:opacity-45 cursor-pointer"
          >
            <FileCheck2 className="w-4 h-4 text-[#087F6D]" aria-hidden="true" />
            <span>Audit Receipt</span>
          </button>
        </div>
      </section>
    </div>
  );
};
