import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Upload,
  Sparkles,
  Download,
  ShieldCheck,
  AlertTriangle,
  Sliders,
  Play,
  RotateCcw,
  KeyRound,
  FileCheck2,
  ChevronDown,
  ChevronUp,
  XCircle,
} from 'lucide-react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useSession } from '../../state/session.tsx';
import { createDefaultPolicy } from '../../engine/redaction.ts';
import type { CoreRedactionMode } from '../../engine/types.ts';
import { parseCsvSafe, type CsvParseDiagnostics } from '../../engine/csv/parse.ts';
import { inspectCsvFormulas, serializeCsvSafe } from '../../engine/csv/serialize.ts';
import {
  redactCsvRows,
  suggestColumnRoles,
  type CsvColumnMeta,
  type CsvColumnRole,
} from '../../engine/csv/classify.ts';
import { assessKAnonymity } from '../../engine/csv/risk.ts';
import {
  applyColumnTransformsToRows,
  inferColumnTransformKind,
  optimizeGeneralizationPolicy,
  type CandidatePolicyResult,
  type OptimizerResult,
} from '../../engine/csv/optimizer.ts';
import { SAMPLE_CSV_EDGE, SAMPLE_CSV_RISK } from '../../fixtures/samples.ts';
import { sha256Text } from '../../engine/crypto/hash.ts';
import { createAuditReceipt } from '../../engine/audit.ts';
import type { VaultPayload } from '../../engine/crypto/vault.ts';
import { IdentityExposureGraph } from './IdentityExposureGraph.tsx';
import { PageHeader } from '../../components/ui/PageHeader.tsx';
import { sharedGemmaReasoner } from '../../intelligence/localReasoner.ts';
import { formatGemma3TurnPrompt, neutralizeGemmaControlTokens } from '../../intelligence/prompts.ts';

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

const PAGE_SIZE = 25;

export const DataShield: React.FC = () => {
  const { setLastAuditReceipt, setStagedVaultPayload, setActiveModule, pushToast, announce } = useSession();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const dataWorkerRef = useRef<Worker | null>(null);
  const latestOptReqId = useRef<string>('');

  const [rawText, setRawText] = useState<string>('');
  const [filename, setFilename] = useState<string>('dataset.csv');
  const [delimiter, setDelimiter] = useState<string>('');
  const [hasHeader, setHasHeader] = useState<boolean>(true);
  const [rows, setRows] = useState<string[][]>([]);
  const [diagnostics, setDiagnostics] = useState<CsvParseDiagnostics | null>(null);
  const [columns, setColumns] = useState<CsvColumnMeta[]>([]);
  const [mode, setMode] = useState<CoreRedactionMode>('PSEUDONYM');
  const [maskWholeDirectCols, setMaskWholeDirectCols] = useState<boolean>(true);
  const [spreadsheetSafeEscape, setSpreadsheetSafeEscape] = useState<boolean>(false);

  const [showRiskLab, setShowRiskLab] = useState<boolean>(true);
  const [targetK, setTargetK] = useState<number>(2);
  const [sensitiveColIdx, setSensitiveColIdx] = useState<number | null>(null);
  const [allowSuppression, setAllowSuppression] = useState<boolean>(true);

  const [optBusy, setOptBusy] = useState<boolean>(false);
  const [optimizerResult, setOptimizerResult] = useState<OptimizerResult | null>(null);
  const [appliedPolicy, setAppliedPolicy] = useState<CandidatePolicyResult | null>(null);
  const [tableViewMode, setTableViewMode] = useState<'sanitized' | 'original'>('sanitized');
  const [page, setPage] = useState<number>(0);
  const [gemmaCsvAdvice, setGemmaCsvAdvice] = useState<string>('');
  const [gemmaCsvBusy, setGemmaCsvBusy] = useState<boolean>(false);

  useEffect(() => {
    return () => {
      dataWorkerRef.current?.terminate();
    };
  }, []);

  const loadCsvText = (csvContent: string, name: string, explicitDelim = '') => {
    try {
      const parsed = parseCsvSafe(csvContent, explicitDelim || undefined);
      const suggested = suggestColumnRoles(parsed.rows, hasHeader);
      setRawText(csvContent);
      setFilename(name.replace(/[^A-Za-z0-9._-]/g, '_'));
      setRows(parsed.rows);
      setDiagnostics(parsed.diagnostics);
      setColumns(suggested);
      setAppliedPolicy(null);
      setOptimizerResult(null);
      setPage(0);
      announce(`Loaded ${name} with ${parsed.rows.length} rows.`);
      pushToast('success', `Parsed ${name}: ${parsed.rows.length} rows × ${parsed.diagnostics.columnCount} columns.`);
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : 'Failed to parse CSV.');
    }
  };

  const handleFileUpload = async (file: File) => {
    const buf = new Uint8Array(await file.arrayBuffer());
    const text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    loadCsvText(text, file.name, delimiter);
  };

  // Run direct-identifier redaction across cells
  const directRedaction = useMemo(() => {
    if (rows.length === 0) return null;
    const policy = createDefaultPolicy(mode === 'FULL' ? 'AI_SAFE' : mode === 'PARTIAL' ? 'SUPPORT' : 'RESEARCH');
    policy.defaultMode = mode;
    if (mode === 'PARTIAL') {
      policy.categoryModes = {
        AADHAAR: 'FULL',
        CARD: 'FULL',
        PAN: 'PARTIAL',
        PHONE: 'PARTIAL',
        EMAIL: 'PARTIAL',
        IPV4: 'PARTIAL',
        IPV6: 'FULL',
      };
    } else {
      policy.categoryModes = {};
    }
    const colsClone = columns.map((c) => ({ ...c, detectedTypes: [...c.detectedTypes] }));
    return redactCsvRows(rows, hasHeader, colsClone, policy, maskWholeDirectCols);
  }, [rows, hasHeader, columns, mode, maskWholeDirectCols]);

  const directSanitizedRows = directRedaction?.sanitizedRows ?? rows;
  const dataRowStart = hasHeader && rows.length > 0 ? 1 : 0;

  // Apply chosen generalization policy on top of direct-redacted data rows
  const finalSanitizedRows = useMemo(() => {
    if (!appliedPolicy || directSanitizedRows.length === 0) return directSanitizedRows;
    const headerSlice = hasHeader ? [directSanitizedRows[0]] : [];
    const body = directSanitizedRows.slice(dataRowStart);
    const generalizedBody = applyColumnTransformsToRows(body, appliedPolicy.transformsByColumn);
    return [...headerSlice, ...generalizedBody];
  }, [directSanitizedRows, appliedPolicy, hasHeader, dataRowStart]);

  const qiColumnIndices = useMemo(
    () => columns.filter((c) => c.role === 'quasi_id').map((c) => c.index),
    [columns],
  );

  const beforeRisk = useMemo(() => {
    const body = directSanitizedRows.slice(dataRowStart);
    return assessKAnonymity(body, qiColumnIndices, targetK, sensitiveColIdx);
  }, [directSanitizedRows, dataRowStart, qiColumnIndices, targetK, sensitiveColIdx]);

  const afterRisk = useMemo(() => {
    if (!appliedPolicy) return null;
    const body = finalSanitizedRows.slice(dataRowStart);
    return assessKAnonymity(body, qiColumnIndices, targetK, sensitiveColIdx);
  }, [appliedPolicy, finalSanitizedRows, dataRowStart, qiColumnIndices, targetK, sensitiveColIdx]);

  const formulaInfo = useMemo(() => inspectCsvFormulas(finalSanitizedRows), [finalSanitizedRows]);

  const chartData = useMemo(() => {
    const sizes = new Set<number>();
    for (const b of beforeRisk.distribution) sizes.add(b.groupSize);
    if (afterRisk) {
      for (const a of afterRisk.distribution) sizes.add(a.groupSize);
    }
    return Array.from(sizes)
      .sort((a, b) => a - b)
      .map((size) => ({
        groupSize: `k=${size}`,
        beforeRows: beforeRisk.distribution.find((d) => d.groupSize === size)?.rowCount ?? 0,
        afterRows: afterRisk?.distribution.find((d) => d.groupSize === size)?.rowCount ?? 0,
      }));
  }, [beforeRisk, afterRisk]);

  const handleRunOptimizer = () => {
    if (qiColumnIndices.length === 0) {
      pushToast('warning', 'Mark at least one column as Quasi-ID before running the optimizer.');
      return;
    }
    const body = directSanitizedRows.slice(dataRowStart);
    const configs = qiColumnIndices.map((idx) => ({
      columnIndex: idx,
      columnLabel: columns[idx]?.headerLabel || `Col ${idx + 1}`,
      kind: inferColumnTransformKind(
        columns[idx]?.headerLabel || '',
        body.map((r) => r[idx] ?? ''),
      ),
      importanceWeight: 1,
      allowSuppression,
    }));

    const reqId = `opt_${Date.now()}`;
    latestOptReqId.current = reqId;
    setOptBusy(true);

    if (typeof Worker !== 'undefined') {
      if (!dataWorkerRef.current) {
        dataWorkerRef.current = new Worker(new URL('../../workers/data.worker.ts', import.meta.url), {
          type: 'module',
        });
      }
      const w = dataWorkerRef.current;
      w.onerror = (err) => {
        setOptBusy(false);
        pushToast('error', `Optimizer worker error: ${err.message}`);
      };
      w.onmessage = (ev: MessageEvent) => {
        const msg = ev.data;
        if (!msg || msg.requestId !== latestOptReqId.current) return;
        setOptBusy(false);
        if (msg.type === 'result') {
          setOptimizerResult(msg.result);
          if (msg.result.bestPolicy) {
            setAppliedPolicy(msg.result.bestPolicy);
            pushToast(
              'success',
              `Found feasible policy (k_min=${msg.result.bestPolicy.assessment.kMin}, utility loss ${(msg.result.bestPolicy.utilityLoss * 100).toFixed(1)}%).`,
            );
          } else {
            pushToast('warning', 'No feasible policy found under current constraints.');
          }
        } else if (msg.type === 'error') {
          pushToast('error', msg.message || 'Optimizer error.');
        }
      };
      w.postMessage({
        requestId: reqId,
        revision: 1,
        action: 'optimize',
        dataRows: body,
        configs,
        targetK,
        sensitiveColumnIndex: sensitiveColIdx,
        searchBudget: 600,
      });
    } else {
      const res = optimizeGeneralizationPolicy({
        dataRows: body,
        configs,
        targetK,
        sensitiveColumnIndex: sensitiveColIdx,
      });
      setOptimizerResult(res);
      if (res.bestPolicy) setAppliedPolicy(res.bestPolicy);
      setOptBusy(false);
    }
  };

  const handleExportCsv = async () => {
    if (finalSanitizedRows.length === 0) return;
    const csvOut = serializeCsvSafe(finalSanitizedRows, {
      delimiter: diagnostics?.delimiter || ',',
      lineEnding: diagnostics?.lineEnding || '\n',
      spreadsheetSafeEscape,
    });
    const { bytes } = await sha256Text(csvOut);
    const outName = filename.replace(/\.csv$/i, '') + '.sanitized.csv';
    triggerDownload(outName, bytes, 'text/csv; charset=utf-8');

    const byType: Record<string, number> = {};
    for (const [k, v] of Object.entries(directRedaction?.countsByType ?? {})) {
      if (typeof v === 'number') byType[k] = v;
    }

    const receipt = await createAuditReceipt({
      inputFormat: 'csv',
      inputByteSize: new TextEncoder().encode(rawText).byteLength,
      outputFormat: 'text/csv; charset=utf-8',
      outputBytes: bytes,
      policyPreset: 'CUSTOM',
      defaultMode: mode,
      enabledMethods: ['regex', 'checksum', 'parser', 'csv_cell_scan', ...(appliedPolicy ? ['k_anonymity_optimizer'] : [])],
      counts: {
        totalDetected: directRedaction?.appliedCount ?? 0,
        uniqueEntities: directRedaction?.uniquePseudonyms ?? 0,
        applied: directRedaction?.appliedCount ?? 0,
        excluded: directRedaction?.excludedCount ?? 0,
        rejected: directRedaction?.rejectedCount ?? 0,
        uncertain: 0,
        byType,
      },
      durationsMs: {
        detection: directRedaction?.durationMs ?? 0,
        redaction: 0,
      },
      statusLabel: appliedPolicy
        ? `Sanitized CSV exported (k_min=${afterRisk?.kMin ?? 'N/A'})`
        : 'Direct-redacted CSV exported',
      remainingFindings: afterRisk ? afterRisk.rowsBelowTarget : beforeRisk.rowsBelowTarget,
      limitations: [
        'Group size k is conditional on selected quasi-identifiers and current sample only.',
        'Exact-match pseudonyms preserve cross-row linkage across repeated identifiers.',
      ],
      csvSummary: {
        rows: finalSanitizedRows.length,
        columns: diagnostics?.columnCount ?? 0,
        selectedQiCount: qiColumnIndices.length,
        targetK,
        beforeKMin: beforeRisk.kMin,
        afterKMin: afterRisk?.kMin ?? beforeRisk.kMin,
        beforeSingletons: beforeRisk.singletonRows,
        afterSingletons: afterRisk?.singletonRows ?? beforeRisk.singletonRows,
        beforeRowsBelowTarget: beforeRisk.rowsBelowTarget,
        afterRowsBelowTarget: afterRisk?.rowsBelowTarget ?? beforeRisk.rowsBelowTarget,
        appliedTransforms: appliedPolicy
          ? Object.entries(appliedPolicy.transformsByColumn).map(([cIdx, tr]) => ({
              columnLabel: `Col_${Number(cIdx) + 1}`, // Omit raw headers by default in audit
              transformDescription: tr.label,
            }))
          : [],
        utilityLoss: appliedPolicy?.utilityLoss,
      },
      offlineAssetStatus: { csvEngine: 'ready' },
    });
    setLastAuditReceipt(receipt);
    pushToast('success', `Downloaded ${outName} with SHA-256 audit receipt.`);
  };

  const handleStageCsvVault = async () => {
    if (!directRedaction || mode !== 'PSEUDONYM' || appliedPolicy) {
      pushToast('warning', 'CSV Vault is available in Consistent Pseudonym mode without generalized QI rewrites.');
      return;
    }
    const csvOut = serializeCsvSafe(finalSanitizedRows, {
      delimiter: diagnostics?.delimiter || ',',
      lineEnding: diagnostics?.lineEnding || '\n',
      spreadsheetSafeEscape,
    });
    const { sha256Hex } = await sha256Text(csvOut);
    const records = directRedaction.cellTransformations
      .filter((t) => t.applied && t.mode === 'PSEUDONYM')
      .map((t) => ({
        type: t.type,
        token: t.replacement,
        originalSlice: t.originalSlice,
        outStart: t.outStart,
        outEnd: t.outEnd,
        row: t.row,
        column: t.column,
        cellStart: t.cellStart,
        cellEnd: t.cellEnd,
      }));
    const payload: VaultPayload = {
      schemaVersion: 1,
      format: 'csv',
      sanitizedSha256: sha256Hex,
      csvDelimiter: diagnostics?.delimiter || ',',
      csvLineEnding: diagnostics?.lineEnding || '\n',
      records,
    };
    setStagedVaultPayload(payload);
    setActiveModule('vault');
  };

  const activeDisplayRows = tableViewMode === 'sanitized' ? finalSanitizedRows : rows;
  const headerRow = hasHeader && activeDisplayRows.length > 0 ? activeDisplayRows[0] : null;
  const bodyDisplayRows = activeDisplayRows.slice(dataRowStart);
  const totalPages = Math.max(1, Math.ceil(bodyDisplayRows.length / PAGE_SIZE));
  const pageRows = bodyDisplayRows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <div className="space-y-8 ae-fade-in">
      <PageHeader
        eyebrow="Structured Dataset Sanitization"
        title="Data Shield"
        description="Mask direct identifiers in CSV datasets, inspect k-anonymity equivalence classes, and optimize utility-preserving generalization rules locally."
        actions={
          <div className="inline-flex rounded-xl border border-[#E2E8F0] bg-white p-1 gap-1 shadow-2xs">
            {(['FULL', 'PARTIAL', 'PSEUDONYM'] as CoreRedactionMode[]).map((m) => (
              <button
                key={m}
                type="button"
                data-testid={`csv-mode-${m.toLowerCase()}`}
                onClick={() => setMode(m)}
                className={`rounded-lg px-3.5 h-9 text-sm font-semibold transition cursor-pointer ${
                  mode === m
                    ? 'bg-[#E1F5EF] text-[#087F6D]'
                    : 'text-[#475569] hover:text-[#101828] hover:bg-[#F7F9FC]'
                }`}
              >
                {m === 'FULL' ? 'Full Mask' : m === 'PARTIAL' ? 'Partial Mask' : 'Consistent Pseudonym'}
              </button>
            ))}
          </div>
        }
      />

      {/* Primary Action Bar */}
      <section className="ae-card p-5 sm:p-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.tsv,text/csv"
            className="hidden"
            data-testid="csv-file-input"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFileUpload(f);
              e.target.value = '';
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="ae-btn-secondary inline-flex items-center gap-2 rounded-xl px-4 h-11 text-[15px] cursor-pointer"
          >
            <Upload className="w-4 h-4 text-[#087F6D]" aria-hidden="true" />
            <span>Upload .CSV</span>
          </button>

          <button
            type="button"
            data-testid="load-csv-risk-btn"
            onClick={() => loadCsvText(SAMPLE_CSV_RISK, 'sample-risk-cohort.csv')}
            className="ae-btn-primary inline-flex items-center gap-2 rounded-xl px-4 h-11 text-[15px] cursor-pointer"
          >
            <Sparkles className="w-4 h-4" aria-hidden="true" />
            <span>Load Risk &amp; K-Anonymity Sample</span>
          </button>

          <button
            type="button"
            data-testid="load-csv-edge-btn"
            onClick={() => loadCsvText(SAMPLE_CSV_EDGE, 'sample-edge-cases.csv')}
            className="ae-btn-secondary inline-flex items-center gap-2 rounded-xl px-4 h-11 text-[15px] cursor-pointer"
          >
            <span>Edge Format Sample</span>
          </button>
        </div>

        <select
          aria-label="CSV delimiter"
          value={delimiter}
          onChange={(e) => {
            const d = e.target.value;
            setDelimiter(d);
            if (rawText) loadCsvText(rawText, filename, d);
          }}
          className="ae-input px-3.5 h-11 text-sm font-medium"
        >
          <option value="">Delimiter: Auto</option>
          <option value=",">Comma (,)</option>
          <option value=";">Semicolon (;)</option>
          <option value={'\t'}>Tab (\t)</option>
        </select>
      </section>

      {rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-[#CBD5E1] bg-white p-16 text-center space-y-4">
          <div className="mx-auto w-14 h-14 rounded-2xl bg-[#E1F5EF] text-[#087F6D] flex items-center justify-center">
            <Sliders className="w-7 h-7" aria-hidden="true" />
          </div>
          <p className="text-lg font-semibold text-[#101828]">
            Upload a CSV spreadsheet or load the Risk &amp; K-Anonymity sample
          </p>
          <p className="text-base text-[#475569] max-w-2xl mx-auto leading-relaxed">
            CipherMask masks direct identifiers per cell and quantifies indirect re-identification exposure (k-anonymity) across quasi-identifiers before optimizing generalization rules.
          </p>
        </div>
      ) : (
        <>
          {/* Parse Diagnostics & Formula Safety Warnings */}
          {diagnostics && (
            <section className="ae-card px-5 py-4 flex flex-wrap items-center justify-between gap-3 text-sm">
              <div className="flex flex-wrap items-center gap-4 text-[#475569]">
                <span>
                  File: <strong className="font-mono text-[#101828]">{filename}</strong>
                </span>
                <span className="font-mono text-[13px] text-[#64748B]">
                  {diagnostics.rowCount} rows × {diagnostics.columnCount} cols (delimiter: {diagnostics.delimiter === '\t' ? 'TAB' : `"${diagnostics.delimiter}"`})
                </span>
                {diagnostics.hadBom && <span className="text-[#15803D] font-medium">UTF-8 BOM stripped</span>}
                {diagnostics.inconsistentRowWidths.length > 0 && (
                  <span className="text-[#B45309] font-medium">
                    Warning: {diagnostics.inconsistentRowWidths.length} row(s) have uneven column widths
                  </span>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-5">
                <label className="inline-flex items-center gap-2 cursor-pointer text-[#475569] font-medium">
                  <input
                    type="checkbox"
                    checked={hasHeader}
                    onChange={(e) => {
                      const next = e.target.checked;
                      setHasHeader(next);
                      setColumns(suggestColumnRoles(rows, next));
                    }}
                    className="h-4 w-4 accent-[#087F6D]"
                  />
                  <span>First row is header</span>
                </label>

                <label className="inline-flex items-center gap-2 cursor-pointer text-[#475569] font-medium">
                  <input
                    type="checkbox"
                    checked={maskWholeDirectCols}
                    onChange={(e) => setMaskWholeDirectCols(e.target.checked)}
                    className="h-4 w-4 accent-[#087F6D]"
                  />
                  <span>Mask whole Direct-ID columns</span>
                </label>
              </div>
            </section>
          )}

          {formulaInfo.formulaCellCount > 0 && (
            <div className="rounded-xl border border-[#FDE68A] bg-[#FFFBEB] px-5 py-3.5 text-sm flex flex-wrap items-center justify-between gap-3 text-[#B45309]">
              <div className="flex items-center gap-2.5 font-medium">
                <AlertTriangle className="w-5 h-5 shrink-0" />
                <span>
                  Detected {formulaInfo.formulaCellCount} cell(s) starting with spreadsheet formula characters (=, +, -, @).
                </span>
              </div>
              <label className="inline-flex items-center gap-2 cursor-pointer font-medium">
                <input
                  type="checkbox"
                  checked={spreadsheetSafeEscape}
                  onChange={(e) => setSpreadsheetSafeEscape(e.target.checked)}
                  className="h-4 w-4 accent-[#B45309]"
                />
                <span>Spreadsheet-Safe Escape (prefix &apos;; alters cell values)</span>
              </label>
            </div>
          )}

          {/* CSV Data Table */}
          <section className="ae-card overflow-hidden">
            <div className="px-5 py-4 border-b border-[#EDF0F4] bg-[#F8FAFC] flex flex-wrap items-center justify-between gap-3 text-sm">
              <div className="flex items-center gap-4">
                <h2 className="text-lg font-semibold text-[#101828]">Dataset Preview</h2>
                <div className="inline-flex rounded-xl border border-[#E2E8F0] bg-[#FFFFFF] p-1">
                  <button
                    type="button"
                    onClick={() => setTableViewMode('sanitized')}
                    className={`rounded-lg px-3 py-1 font-medium cursor-pointer transition-colors ${
                      tableViewMode === 'sanitized' ? 'bg-[#E1F5EF] text-[#087F6D] font-semibold' : 'text-[#64748B] hover:text-[#101828]'
                    }`}
                  >
                    Sanitized ({directRedaction?.appliedCount ?? 0} masked)
                  </button>
                  <button
                    type="button"
                    onClick={() => setTableViewMode('original')}
                    className={`rounded-lg px-3 py-1 font-medium cursor-pointer transition-colors ${
                      tableViewMode === 'original' ? 'bg-[#F1F5F9] text-[#101828] font-semibold' : 'text-[#64748B] hover:text-[#101828]'
                    }`}
                  >
                    Original
                  </button>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <span className="font-mono text-[13px] text-[#64748B] mr-1">
                  Page {page + 1}/{totalPages}
                </span>
                <button
                  type="button"
                  disabled={page === 0}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  className="ae-btn-secondary rounded-lg px-3 h-9 text-sm disabled:opacity-45 cursor-pointer"
                >
                  Prev
                </button>
                <button
                  type="button"
                  disabled={page + 1 >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                  className="ae-btn-secondary rounded-lg px-3 h-9 text-sm disabled:opacity-45 cursor-pointer"
                >
                  Next
                </button>
              </div>
            </div>

            <div className="overflow-x-auto max-h-96">
              <table data-testid="csv-data-table" className="w-full text-left text-sm border-collapse">
                <thead className="sticky top-0 bg-[#F8FAFC] border-b border-[#E2E8F0]">
                  <tr>
                    <th className="py-3 px-4 text-[#64748B] font-mono text-xs w-12">#</th>
                    {(headerRow ?? columns.map((c) => c.headerLabel)).map((h, i) => (
                      <th key={i} className="py-3 px-4 font-semibold text-[#101828] whitespace-nowrap">
                        <div>{h}</div>
                        <div className="text-[11px] font-medium text-[#64748B] uppercase tracking-wider">
                          {columns[i]?.role.replace('_', ' ')}
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#EDF0F4]">
                  {pageRows.map((row, rIdx) => (
                    <tr key={rIdx} className="hover:bg-[#F7F9FC]">
                      <td className="py-2.5 px-4 font-mono text-xs text-[#64748B]">{page * PAGE_SIZE + rIdx + 1}</td>
                      {row.map((cell, cIdx) => (
                        <td key={cIdx} className="py-2.5 px-4 font-mono text-[13px] text-[#334155] whitespace-pre-wrap max-w-[260px] truncate">
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* Privacy Risk & Digital Twin Section */}
          <section className="ae-card overflow-hidden">
            <button
              type="button"
              onClick={() => setShowRiskLab((v) => !v)}
              className="w-full px-6 py-4 flex items-center justify-between border-b border-[#EDF0F4] text-left cursor-pointer hover:bg-[#F7F9FC] transition-colors"
            >
              <div className="flex items-center gap-3">
                <Sliders className="w-5 h-5 text-[#087F6D]" aria-hidden="true" />
                <span className="text-lg font-semibold text-[#101828]">
                  Privacy Risk Analytics, K-Anonymity Optimizer &amp; Exposure Map
                </span>
              </div>
              {showRiskLab ? <ChevronUp className="w-5 h-5 text-[#64748B]" /> : <ChevronDown className="w-5 h-5 text-[#64748B]" />}
            </button>

            {showRiskLab && (
              <div className="p-6 space-y-6">
                {/* Column Roles + Optimizer Controls */}
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
                  <div className="lg:col-span-7 ae-well p-5 space-y-3.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="text-[15px] font-semibold text-[#101828]">
                        1. Confirm Column Roles (Select Quasi-Identifiers)
                      </div>
                      <button
                        type="button"
                        disabled={gemmaCsvBusy || columns.length === 0}
                        onClick={async () => {
                          if (sharedGemmaReasoner.getStatus().state !== 'ready') {
                            pushToast('info', 'Load Gemma 3 4B in Local AI & Cloud Setup to get column-level privacy recommendations.');
                            return;
                          }
                          setGemmaCsvBusy(true);
                          try {
                            const colMetaSummary = columns.map((c) => ({
                              header: neutralizeGemmaControlTokens(c.headerLabel),
                              currentRole: c.role,
                              distinctCount: c.distinctCount,
                              missingCount: c.missingCount,
                              detectedTypes: c.detectedTypes,
                            }));
                            const prompt = formatGemma3TurnPrompt(
                              `Given ONLY these CSV column metadata summaries (no raw rows), recommend in 2-3 concise sentences which columns should be Direct ID, Quasi-ID, or Sensitive to reduce re-identification risk:\n${JSON.stringify(colMetaSummary)}`,
                            );
                            const res = await sharedGemmaReasoner.run({
                              jobId: `csv_adv_${Date.now()}`,
                              task: 'csv_column_advisor',
                              prompt,
                              maxOutputTokens: 200,
                            });
                            if (res.status === 'completed') {
                              setGemmaCsvAdvice(res.text.trim());
                            } else {
                              pushToast('warning', res.errorMessage || 'Column advisor failed.');
                            }
                          } finally {
                            setGemmaCsvBusy(false);
                          }
                        }}
                        className="ae-btn-indigo rounded-lg px-3.5 h-9 text-[13px] cursor-pointer"
                      >
                        {gemmaCsvBusy ? 'Advising...' : 'Ask Gemma Advisor'}
                      </button>
                    </div>
                    {gemmaCsvAdvice && (
                      <div className="rounded-xl border border-[#C7D2FE] bg-[#EEF2FF] p-3.5 text-sm text-[#312E81]">
                        <strong className="text-[#4338CA]">Gemma Column Recommendation:</strong> {gemmaCsvAdvice}
                      </div>
                    )}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 max-h-60 overflow-y-auto">
                      {columns.map((col) => (
                        <div
                          key={col.index}
                          className="rounded-xl border border-[#E2E8F0] bg-white px-3.5 py-2.5 flex items-center justify-between gap-2 text-sm"
                        >
                          <div className="min-w-0">
                            <div className="font-mono font-semibold text-[#101828] truncate">{col.headerLabel}</div>
                            <div className="text-xs text-[#64748B]">{col.distinctCount} distinct</div>
                          </div>
                          <select
                            aria-label={`Role for ${col.headerLabel}`}
                            value={col.role}
                            onChange={(e) => {
                              const role = e.target.value as CsvColumnRole;
                              setColumns((prev) =>
                                prev.map((c) => (c.index === col.index ? { ...c, role } : c)),
                              );
                              setAppliedPolicy(null);
                              setOptimizerResult(null);
                            }}
                            className="ae-input px-2.5 py-1.5 text-[13px]"
                          >
                            <option value="direct_id">Direct ID</option>
                            <option value="quasi_id">Quasi-ID</option>
                            <option value="sensitive">Sensitive</option>
                            <option value="utility">Utility</option>
                            <option value="excluded">Excluded</option>
                          </select>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="lg:col-span-5 ae-well p-5 space-y-4 text-sm">
                    <div className="text-[15px] font-semibold text-[#101828]">2. Target K-Anonymity &amp; Optimizer</div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[#475569] font-medium">Target k:</span>
                      {[2, 3, 5, 10].map((k) => (
                        <button
                          key={k}
                          type="button"
                          data-testid={`target-k-${k}`}
                          onClick={() => setTargetK(k)}
                          className={`rounded-lg px-3 h-9 border font-mono text-sm font-medium cursor-pointer transition-colors ${
                            targetK === k
                              ? 'border-[#087F6D] bg-[#E1F5EF] text-[#087F6D] font-semibold'
                              : 'border-[#E2E8F0] bg-white text-[#475569]'
                          }`}
                        >
                          k={k}
                        </button>
                      ))}
                      <input
                        type="number"
                        min={2}
                        max={1000}
                        aria-label="Custom target k"
                        value={targetK}
                        onChange={(e) => setTargetK(Math.max(2, Number(e.target.value) || 2))}
                        className="ae-input w-20 px-2.5 h-9 font-mono text-sm"
                      />
                    </div>

                    <div className="flex flex-wrap items-center gap-3">
                      <label className="inline-flex items-center gap-2 cursor-pointer text-[#475569] font-medium">
                        <input
                          type="checkbox"
                          checked={allowSuppression}
                          onChange={(e) => setAllowSuppression(e.target.checked)}
                          className="h-4 w-4 accent-[#087F6D]"
                        />
                        <span>Allow [SUPPRESSED] fallback</span>
                      </label>

                      <select
                        aria-label="Sensitive attribute for l-diversity"
                        value={sensitiveColIdx ?? ''}
                        onChange={(e) =>
                          setSensitiveColIdx(e.target.value === '' ? null : Number(e.target.value))
                        }
                        className="ae-input px-3 h-9 text-[13px]"
                      >
                        <option value="">l-diversity: None selected</option>
                        {columns.map((c) => (
                          <option key={c.index} value={c.index}>
                            Sensitive: {c.headerLabel}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="flex flex-wrap gap-2.5 pt-1">
                      <button
                        type="button"
                        data-testid="run-optimizer-btn"
                        disabled={optBusy || qiColumnIndices.length === 0}
                        onClick={handleRunOptimizer}
                        className="ae-btn-primary inline-flex items-center gap-2 rounded-xl px-4 h-11 text-[15px] disabled:opacity-45 cursor-pointer"
                      >
                        <Play className="w-4 h-4" aria-hidden="true" />
                        <span>{optBusy ? 'Optimizing...' : 'Run Generalization Optimizer'}</span>
                      </button>

                      {optBusy && (
                        <button
                          type="button"
                          onClick={() => {
                            dataWorkerRef.current?.postMessage({
                              requestId: latestOptReqId.current,
                              action: 'cancel',
                            });
                            setOptBusy(false);
                          }}
                          className="ae-btn-danger inline-flex items-center gap-1.5 rounded-xl px-3.5 h-11 text-sm cursor-pointer"
                        >
                          <XCircle className="w-4 h-4" /> Cancel
                        </button>
                      )}

                      {appliedPolicy && (
                        <button
                          type="button"
                          onClick={() => setAppliedPolicy(null)}
                          className="ae-btn-secondary inline-flex items-center gap-1.5 rounded-xl px-3.5 h-11 text-sm cursor-pointer"
                        >
                          <RotateCcw className="w-4 h-4" /> Reset Baseline
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                {/* Before / After K-Anonymity Risk Cards */}
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
                  <div className="ae-card p-4">
                    <div className="text-[13px] font-medium text-[#64748B]">k_min (Before → After)</div>
                    <div data-testid="csv-kmin-stat" className="text-xl font-semibold font-mono tabular-nums mt-1 text-[#101828]">
                      {beforeRisk.applicable ? beforeRisk.kMin : 'N/A'} →{' '}
                      <span className="text-[#087F6D]">
                        {afterRisk?.applicable ? afterRisk.kMin : beforeRisk.applicable ? beforeRisk.kMin : 'N/A'}
                      </span>
                    </div>
                  </div>

                  <div className="ae-card p-4">
                    <div className="text-[13px] font-medium text-[#64748B]">Singleton Rows (k=1)</div>
                    <div data-testid="csv-singletons-stat" className="text-xl font-semibold font-mono tabular-nums mt-1 text-[#B45309]">
                      {beforeRisk.applicable ? beforeRisk.singletonRows : 'N/A'} →{' '}
                      <span className="text-[#15803D]">
                        {afterRisk?.applicable ? afterRisk.singletonRows : beforeRisk.singletonRows}
                      </span>
                    </div>
                  </div>

                  <div className="ae-card p-4">
                    <div className="text-[13px] font-medium text-[#64748B]">Rows &lt; target k ({targetK})</div>
                    <div className="text-xl font-semibold font-mono tabular-nums mt-1 text-[#DC2626]">
                      {beforeRisk.applicable ? beforeRisk.rowsBelowTarget : 'N/A'} →{' '}
                      <span className="text-[#15803D]">
                        {afterRisk?.applicable ? afterRisk.rowsBelowTarget : beforeRisk.rowsBelowTarget}
                      </span>
                    </div>
                  </div>

                  <div className="ae-card p-4">
                    <div className="text-[13px] font-medium text-[#64748B]">Utility Loss</div>
                    <div className="text-xl font-semibold font-mono tabular-nums mt-1 text-[#101828]">
                      {appliedPolicy ? `${(appliedPolicy.utilityLoss * 100).toFixed(1)}%` : '0.0%'}
                    </div>
                  </div>

                  <div className="ae-card p-4">
                    <div className="text-[13px] font-medium text-[#64748B]">Min l-diversity</div>
                    <div className="text-xl font-semibold font-mono tabular-nums mt-1 text-[#475569]">
                      {(afterRisk ?? beforeRisk).minLDiversity ?? 'N/A'}
                    </div>
                  </div>
                </div>

                {/* Group-Size Chart & Candidate Policies */}
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
                  <div className="lg:col-span-6 ae-well p-5 space-y-3">
                    <div className="text-base font-semibold text-[#101828]">
                      Equivalence Group Size Distribution
                    </div>
                    {chartData.length === 0 ? (
                      <div className="h-52 flex items-center justify-center text-sm text-[#64748B]">
                        Select Quasi-ID columns to inspect distribution.
                      </div>
                    ) : (
                      <div className="h-56 bg-white rounded-xl border border-[#E2E8F0] p-3">
                        <ResponsiveContainer width="100%" height="100%">
                          <BarChart data={chartData}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                            <XAxis dataKey="groupSize" stroke="#64748B" fontSize={12} />
                            <YAxis stroke="#64748B" fontSize={12} allowDecimals={false} />
                            <Tooltip
                              contentStyle={{
                                backgroundColor: '#FFFFFF',
                                borderColor: '#E2E8F0',
                                borderRadius: '10px',
                                color: '#101828',
                                fontSize: '13px',
                              }}
                            />
                            <Bar dataKey="beforeRows" name="Before Optimization" fill="#D97706" radius={[4, 4, 0, 0]} />
                            {afterRisk && (
                              <Bar dataKey="afterRows" name="After Optimization" fill="#087F6D" radius={[4, 4, 0, 0]} />
                            )}
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    )}
                  </div>

                  <div className="lg:col-span-6 ae-well p-5 space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-base font-semibold text-[#101828]">
                        Candidate Generalization Policies
                      </span>
                      {optimizerResult && (
                        <span className="font-mono text-xs text-[#64748B]">
                          {optimizerResult.evaluationsRun} evaluated ({optimizerResult.searchExhaustive ? 'exhaustive' : 'bounded'})
                        </span>
                      )}
                    </div>

                    {!optimizerResult ? (
                      <div className="h-56 bg-white rounded-xl border border-[#E2E8F0] flex items-center justify-center text-sm text-[#64748B] text-center px-6">
                        Click <strong>Run Generalization Optimizer</strong> to search low-loss transformations satisfying k ≥ {targetK}.
                      </div>
                    ) : optimizerResult.feasiblePolicies.length === 0 ? (
                      <div className="text-sm text-[#B45309] space-y-2 p-2">
                        {optimizerResult.warnings.map((w, i) => (
                          <p key={i}>{w}</p>
                        ))}
                      </div>
                    ) : (
                      <div className="max-h-56 overflow-y-auto space-y-2.5">
                        {optimizerResult.feasiblePolicies.map((pol) => {
                          const isSelected = appliedPolicy?.id === pol.id;
                          return (
                            <button
                              key={pol.id}
                              type="button"
                              onClick={() => setAppliedPolicy(pol)}
                              className={`w-full text-left rounded-xl border p-3.5 text-sm transition cursor-pointer ${
                                isSelected
                                  ? 'border-[#087F6D] bg-[#E1F5EF]'
                                  : 'border-[#E2E8F0] bg-white hover:border-[#087F6D]/45'
                              }`}
                            >
                              <div className="flex items-center justify-between font-mono text-[13px]">
                                <span className="font-semibold text-[#087F6D]">
                                  k_min={pol.assessment.kMin} | Loss {(pol.utilityLoss * 100).toFixed(1)}%
                                </span>
                                <span className="text-[#64748B]">
                                  Changed {(pol.changedCellFraction * 100).toFixed(0)}% | Suppressed {pol.suppressedCellCount}
                                </span>
                              </div>
                              <div className="mt-2 text-xs text-[#475569] flex flex-wrap gap-1.5">
                                {Object.entries(pol.transformsByColumn).map(([cIdx, tr]) => (
                                  <span key={cIdx} className="rounded-md bg-[#F7F9FC] px-2.5 py-1 border border-[#E2E8F0]">
                                    {columns[Number(cIdx)]?.headerLabel}: <strong className="text-[#101828]">{tr.label}</strong>
                                  </span>
                                ))}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>

                {/* Identity Exposure Map */}
                <IdentityExposureGraph
                  columns={columns}
                  beforeRisk={beforeRisk}
                  afterRisk={afterRisk}
                />
              </div>
            )}
          </section>

          {/* Export Footer */}
          <section className="ae-card p-5 sm:p-6 flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-2.5 text-[15px] text-[#475569]">
              <ShieldCheck className="w-5 h-5 text-[#15803D]" aria-hidden="true" />
              <span>
                Row &amp; column count preserved ({finalSanitizedRows.length} rows × {diagnostics?.columnCount ?? 0} cols). Direct-ID cells masked locally.
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                data-testid="download-csv-btn"
                onClick={handleExportCsv}
                className="ae-btn-primary inline-flex items-center gap-2 rounded-xl px-5 h-11 text-[15px] cursor-pointer"
              >
                <Download className="w-4 h-4" aria-hidden="true" />
                <span>Export Sanitized .CSV</span>
              </button>

              {mode === 'PSEUDONYM' && !appliedPolicy && (
                <button
                  type="button"
                  onClick={handleStageCsvVault}
                  className="ae-btn-secondary inline-flex items-center gap-2 rounded-xl px-4 h-11 text-[15px] text-[#087F6D] border-[#087F6D]/35 hover:bg-[#E1F5EF] cursor-pointer"
                >
                  <KeyRound className="w-4 h-4" aria-hidden="true" />
                  <span>Save CSV Vault</span>
                </button>
              )}

              <button
                type="button"
                onClick={() => setActiveModule('audit')}
                className="ae-btn-secondary inline-flex items-center gap-2 rounded-xl px-4 h-11 text-[15px] cursor-pointer"
              >
                <FileCheck2 className="w-4 h-4 text-[#087F6D]" aria-hidden="true" />
                <span>Audit Receipt</span>
              </button>
            </div>
          </section>
        </>
      )}
    </div>
  );
};
