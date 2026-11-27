import React, { useState } from 'react';
import { FileCheck2, Download, Printer, Copy, CheckCircle2, ShieldAlert } from 'lucide-react';
import { useSession } from '../../state/session.tsx';
import { verifyArtifactAgainstReceipt, type ReceiptVerifyResult } from '../../engine/audit.ts';
import type { AuditReceipt } from '../../engine/types.ts';
import { PageHeader } from '../../components/ui/PageHeader.tsx';

export const AuditPanel: React.FC = () => {
  const { lastAuditReceipt, pushToast } = useSession();

  const [artifactFile, setArtifactFile] = useState<File | null>(null);
  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const [verifyOutcome, setVerifyOutcome] = useState<{ receipt: AuditReceipt; result: ReceiptVerifyResult } | null>(null);
  const [verifyError, setVerifyError] = useState<string>('');

  const handleDownloadReceipt = () => {
    if (!lastAuditReceipt) return;
    const bytes = new TextEncoder().encode(JSON.stringify(lastAuditReceipt, null, 2));
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ciphermask-receipt-${lastAuditReceipt.outputSha256.slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    pushToast('success', 'Downloaded local SHA-256 audit receipt JSON.');
  };

  const handleCopyDigest = async () => {
    if (!lastAuditReceipt) return;
    try {
      await navigator.clipboard.writeText(lastAuditReceipt.outputSha256);
      pushToast('success', 'Copied SHA-256 digest to clipboard.');
    } catch {
      pushToast('error', 'Clipboard copy failed.');
    }
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setVerifyError('');
    setVerifyOutcome(null);
    if (!artifactFile || !receiptFile) {
      setVerifyError('Select both a sanitized output file and its .json receipt file.');
      return;
    }
    try {
      const artifactBytes = new Uint8Array(await artifactFile.arrayBuffer());
      const receiptText = await receiptFile.text();
      const res = await verifyArtifactAgainstReceipt(artifactBytes, receiptText);
      setVerifyOutcome(res);
    } catch (err) {
      setVerifyError(err instanceof Error ? err.message : 'Verification failed.');
    }
  };

  return (
    <div className="space-y-8 ae-fade-in">
      <PageHeader
        eyebrow="Cryptographic Verification"
        title="Audit &amp; Verify"
        description="Inspect aggregate SHA-256 export receipts without raw PII and verify sanitized files locally."
        actions={
          lastAuditReceipt ? (
            <div className="flex flex-wrap gap-2.5">
              <button
                type="button"
                onClick={handleCopyDigest}
                className="ae-btn-secondary inline-flex items-center gap-2 rounded-xl px-4 h-11 text-sm cursor-pointer"
              >
                <Copy className="w-4 h-4 text-[#087F6D]" /> Copy SHA-256
              </button>
              <button
                type="button"
                onClick={() => window.print()}
                className="ae-btn-secondary inline-flex items-center gap-2 rounded-xl px-4 h-11 text-sm cursor-pointer"
              >
                <Printer className="w-4 h-4 text-[#475569]" /> Print Report
              </button>
              <button
                type="button"
                data-testid="download-receipt-btn"
                onClick={handleDownloadReceipt}
                className="ae-btn-primary inline-flex items-center gap-2 rounded-xl px-5 h-11 text-sm cursor-pointer"
              >
                <Download className="w-4 h-4" /> Download Receipt JSON
              </button>
            </div>
          ) : undefined
        }
      />

      {/* Latest Session Receipt */}
      <section className="ae-card p-6 sm:p-8 space-y-5">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-[#E1F5EF] text-[#087F6D] flex items-center justify-center shrink-0">
            <FileCheck2 className="w-5 h-5" aria-hidden="true" />
          </div>
          <div>
            <h2 className="text-xl font-semibold text-[#101828]">Latest Session Receipt</h2>
            <p className="text-sm text-[#475569]">
              Aggregate counts and SHA-256 digest of exact exported bytes. Zero raw PII, filenames, GPS, or mappings.
            </p>
          </div>
        </div>

        {!lastAuditReceipt ? (
          <div className="rounded-2xl border border-dashed border-[#CBD5E1] bg-[#F7F9FC] p-12 text-center text-base text-[#64748B]">
            Export a sanitized TXT, CSV, or PNG/JPEG in any module to generate a cryptographic SHA-256 audit receipt for this session.
          </div>
        ) : (
          <div className="space-y-4">
            <div className="ae-well p-4 font-mono">
              <div className="text-[#64748B] text-xs font-sans font-medium uppercase tracking-wider">Exported Output SHA-256 Digest</div>
              <div data-testid="receipt-sha256" className="text-[#087F6D] text-sm font-semibold break-all mt-1.5">
                {lastAuditReceipt.outputSha256}
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div className="ae-well p-4">
                <div className="text-xs font-medium text-[#64748B]">Format</div>
                <div className="font-mono font-semibold text-[#101828] text-sm mt-1">
                  {lastAuditReceipt.inputFormat} → {lastAuditReceipt.outputFormat}
                </div>
              </div>
              <div className="ae-well p-4">
                <div className="text-xs font-medium text-[#64748B]">Output Size</div>
                <div className="font-mono font-semibold text-[#101828] text-sm mt-1">{lastAuditReceipt.outputByteSize} bytes</div>
              </div>
              <div className="ae-well p-4">
                <div className="text-xs font-medium text-[#64748B]">Applied / Excluded</div>
                <div className="font-mono font-semibold text-[#087F6D] text-sm mt-1">
                  {lastAuditReceipt.counts.applied} / {lastAuditReceipt.counts.excluded}
                </div>
              </div>
              <div className="ae-well p-4">
                <div className="text-xs font-medium text-[#64748B]">Verification</div>
                <div className="font-semibold text-[#15803D] text-sm mt-1 truncate">
                  {lastAuditReceipt.verification.statusLabel}
                </div>
              </div>
            </div>

            <pre className="ae-well p-4 font-mono text-[13px] leading-relaxed max-h-80 overflow-y-auto text-[#334155]">
              {JSON.stringify(lastAuditReceipt, null, 2)}
            </pre>
          </div>
        )}
      </section>

      {/* Local Receipt Checker */}
      <section className="ae-card p-6 sm:p-8 space-y-5">
        <div>
          <h2 className="text-xl font-semibold text-[#101828]">Local Receipt Integrity Checker</h2>
          <p className="text-sm text-[#475569] mt-1">
            Verify locally that a sanitized artifact matches its exported receipt SHA-256 digest. (Proves file integrity against the receipt, not external authority or zero transmission.)
          </p>
        </div>

        <form onSubmit={handleVerify} className="grid grid-cols-1 sm:grid-cols-3 gap-4 items-end">
          <label className="space-y-1.5 text-sm">
            <span className="text-[#101828] font-medium block">1. Sanitized Artifact File</span>
            <input
              type="file"
              data-testid="verify-artifact-input"
              onChange={(e) => setArtifactFile(e.target.files?.[0] ?? null)}
              className="ae-input w-full p-2.5 text-sm text-[#475569]"
            />
          </label>
          <label className="space-y-1.5 text-sm">
            <span className="text-[#101828] font-medium block">2. Audit Receipt JSON</span>
            <input
              type="file"
              accept=".json,application/json"
              data-testid="verify-receipt-input"
              onChange={(e) => setReceiptFile(e.target.files?.[0] ?? null)}
              className="ae-input w-full p-2.5 text-sm text-[#475569]"
            />
          </label>
          <button
            type="submit"
            data-testid="verify-receipt-submit"
            className="ae-btn-primary rounded-xl px-5 h-11 text-[15px] cursor-pointer"
          >
            Verify SHA-256 Match
          </button>
        </form>

        {verifyError && (
          <div className="rounded-xl border border-[#FECACA] bg-[#FEF2F2] p-4 text-sm font-medium text-[#DC2626]">
            {verifyError}
          </div>
        )}

        {verifyOutcome && (
          <div
            data-testid="verify-receipt-outcome"
            className={`rounded-xl border p-4 space-y-1.5 text-sm ${
              verifyOutcome.result.matched
                ? 'border-[#BBF7D0] bg-[#ECFDF3] text-[#15803D]'
                : 'border-[#FECACA] bg-[#FEF2F2] text-[#DC2626]'
            }`}
          >
            <div className="flex items-center gap-2 font-semibold text-base">
              {verifyOutcome.result.matched ? (
                <CheckCircle2 className="w-5 h-5" />
              ) : (
                <ShieldAlert className="w-5 h-5" />
              )}
              <span>{verifyOutcome.result.message}</span>
            </div>
            <div className="font-mono text-xs opacity-90">
              Actual: {verifyOutcome.result.actualSha256} ({verifyOutcome.result.actualBytes} bytes)
            </div>
            <div className="font-mono text-xs opacity-90">
              Expected: {verifyOutcome.result.expectedSha256} ({verifyOutcome.result.expectedBytes} bytes)
            </div>
          </div>
        )}
      </section>
    </div>
  );
};
