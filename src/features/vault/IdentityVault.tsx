import React, { useState } from 'react';
import { KeyRound, Lock, Unlock, Download, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useSession } from '../../state/session.tsx';
import {
  decryptVaultEnvelope,
  encryptVaultPayload,
  VAULT_DEFAULT_ITERATIONS,
} from '../../engine/crypto/vault.ts';
import { restoreFromVault, type RestoreResult } from '../../engine/crypto/restore.ts';
import { PageHeader } from '../../components/ui/PageHeader.tsx';

export const IdentityVault: React.FC = () => {
  const { stagedVaultPayload, pushToast } = useSession();

  const [passphrase, setPassphrase] = useState('');
  const [confirmPassphrase, setConfirmPassphrase] = useState('');
  const [encryptBusy, setEncryptBusy] = useState(false);

  const [sanitizedFile, setSanitizedFile] = useState<File | null>(null);
  const [vaultFile, setVaultFile] = useState<File | null>(null);
  const [restorePassphrase, setRestorePassphrase] = useState('');
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreResult, setRestoreResult] = useState<RestoreResult | null>(null);
  const [restoreError, setRestoreError] = useState('');

  const handleExportVault = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stagedVaultPayload) return;
    if (passphrase.length < 8) {
      pushToast('warning', 'Use a passphrase of at least 8 characters.');
      return;
    }
    if (passphrase !== confirmPassphrase) {
      pushToast('error', 'Passphrases do not match.');
      return;
    }

    setEncryptBusy(true);
    try {
      const envelope = await encryptVaultPayload(
        stagedVaultPayload,
        passphrase,
        VAULT_DEFAULT_ITERATIONS,
      );
      const bytes = new TextEncoder().encode(JSON.stringify(envelope, null, 2));
      const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ciphermask-mapping-${stagedVaultPayload.sanitizedSha256.slice(0, 8)}.ciphermask-vault.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setPassphrase('');
      setConfirmPassphrase('');
      pushToast('success', 'Encrypted vault downloaded. Keep this file private—never share it alongside the sanitized file.');
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : 'Vault encryption failed.');
    } finally {
      setEncryptBusy(false);
    }
  };

  const handleRestore = async (e: React.FormEvent) => {
    e.preventDefault();
    setRestoreError('');
    setRestoreResult(null);
    if (!sanitizedFile || !vaultFile || !restorePassphrase) {
      setRestoreError('Provide the sanitized file, encrypted vault JSON, and passphrase.');
      return;
    }

    setRestoreBusy(true);
    try {
      const sanBytes = new Uint8Array(await sanitizedFile.arrayBuffer());
      const vaultJson = await vaultFile.text();
      const payload = await decryptVaultEnvelope(vaultJson, restorePassphrase);
      const restored = await restoreFromVault(sanBytes, payload);
      setRestoreResult(restored);
      setRestorePassphrase('');
      pushToast('success', `Restored ${restored.restoredCount} pseudonym occurrence(s) locally.`);
    } catch (err) {
      setRestoreError(err instanceof Error ? err.message : 'Restoration failed.');
      setRestorePassphrase('');
    } finally {
      setRestoreBusy(false);
    }
  };

  const handleDownloadRestored = () => {
    if (!restoreResult) return;
    const bytes = new TextEncoder().encode(restoreResult.restoredText);
    const mime = restoreResult.format === 'csv' ? 'text/csv; charset=utf-8' : 'text/plain; charset=utf-8';
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `restored-output.${restoreResult.format === 'csv' ? 'csv' : 'txt'}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="space-y-8 ae-fade-in">
      <PageHeader
        eyebrow="Encrypted Pseudonym Recovery"
        title="Identity Vault"
        description="Optionally encrypt reversible TXT/CSV pseudonym mappings locally with PBKDF2-HMAC-SHA256 + AES-GCM-256 and restore them on demand."
      />

      <div className="rounded-xl border border-[#FDE68A] bg-[#FFFBEB] p-4 sm:p-5 text-sm text-[#B45309] flex items-start gap-3">
        <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" aria-hidden="true" />
        <div className="leading-relaxed">
          <strong>Optional Reversible Pseudonymization (Not Anonymization):</strong> The Encrypted Identity Vault stores occurrence-specific mappings for <strong>Pseudonymized TXT/CSV</strong> only using Web Crypto PBKDF2-HMAC-SHA256 ({VAULT_DEFAULT_ITERATIONS.toLocaleString()} iterations) + AES-GCM-256. Full/partial masks and flattened images are irreversible. Passwords are never persisted or recoverable.
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Export Vault */}
        <section className="ae-card p-6 sm:p-8 space-y-5 text-sm">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[#E1F5EF] text-[#087F6D] flex items-center justify-center shrink-0">
              <Lock className="w-5 h-5" aria-hidden="true" />
            </div>
            <h2 className="text-xl font-semibold text-[#101828]">1. Export Encrypted Vault</h2>
          </div>

          {!stagedVaultPayload ? (
            <div className="rounded-2xl border border-dashed border-[#CBD5E1] bg-[#F7F9FC] p-10 text-center text-[#64748B]">
              In <strong>Text Shield</strong> or <strong>Data Shield</strong>, select <strong>Consistent Pseudonym</strong> mode and click <strong>Save Vault</strong> to stage reversible mappings here.
            </div>
          ) : (
            <form onSubmit={handleExportVault} className="space-y-4">
              <div className="ae-well p-4 font-mono text-xs space-y-1.5 text-[#475569]">
                <div>Format: <span className="font-semibold text-[#101828]">{stagedVaultPayload.format.toUpperCase()}</span></div>
                <div>Pseudonym Records: <span className="font-semibold text-[#087F6D]">{stagedVaultPayload.records.length}</span></div>
                <div className="truncate">Sanitized SHA-256: {stagedVaultPayload.sanitizedSha256}</div>
              </div>

              <label className="block space-y-1.5">
                <span className="text-[#101828] font-medium">Vault Passphrase (min 8 chars, unique &amp; strong)</span>
                <input
                  type="password"
                  required
                  minLength={8}
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  className="ae-input w-full px-3.5 h-11 text-sm"
                />
              </label>

              <label className="block space-y-1.5">
                <span className="text-[#101828] font-medium">Confirm Passphrase</span>
                <input
                  type="password"
                  required
                  minLength={8}
                  value={confirmPassphrase}
                  onChange={(e) => setConfirmPassphrase(e.target.value)}
                  className="ae-input w-full px-3.5 h-11 text-sm"
                />
              </label>

              <button
                type="submit"
                disabled={encryptBusy}
                data-testid="export-vault-btn"
                className="ae-btn-primary inline-flex items-center gap-2 rounded-xl px-5 h-11 text-[15px] disabled:opacity-45 cursor-pointer"
              >
                <KeyRound className="w-4 h-4" aria-hidden="true" />
                <span>{encryptBusy ? 'Deriving Key & Encrypting...' : 'Download Encrypted Vault (.ciphermask-vault.json)'}</span>
              </button>
            </form>
          )}
        </section>

        {/* Restore Workspace */}
        <section className="ae-card p-6 sm:p-8 space-y-5 text-sm">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[#ECFDF3] text-[#15803D] flex items-center justify-center shrink-0">
              <Unlock className="w-5 h-5" aria-hidden="true" />
            </div>
            <h2 className="text-xl font-semibold text-[#101828]">2. Restore Pseudonyms Locally</h2>
          </div>

          <form onSubmit={handleRestore} className="space-y-4">
            <label className="block space-y-1.5">
              <span className="text-[#101828] font-medium">Sanitized TXT or CSV File</span>
              <input
                type="file"
                data-testid="restore-sanitized-input"
                onChange={(e) => setSanitizedFile(e.target.files?.[0] ?? null)}
                className="ae-input w-full p-2.5 text-sm text-[#475569]"
              />
            </label>

            <label className="block space-y-1.5">
              <span className="text-[#101828] font-medium">Encrypted Vault (.ciphermask-vault.json)</span>
              <input
                type="file"
                accept=".json,application/json"
                data-testid="restore-vault-input"
                onChange={(e) => setVaultFile(e.target.files?.[0] ?? null)}
                className="ae-input w-full p-2.5 text-sm text-[#475569]"
              />
            </label>

            <label className="block space-y-1.5">
              <span className="text-[#101828] font-medium">Passphrase</span>
              <input
                type="password"
                required
                data-testid="restore-passphrase-input"
                value={restorePassphrase}
                onChange={(e) => setRestorePassphrase(e.target.value)}
                className="ae-input w-full px-3.5 h-11 text-sm"
              />
            </label>

            <button
              type="submit"
              disabled={restoreBusy}
              data-testid="restore-submit-btn"
              className="ae-btn-primary inline-flex items-center gap-2 rounded-xl px-5 h-11 text-[15px] disabled:opacity-45 cursor-pointer"
            >
              {restoreBusy ? 'Decrypting & Verifying SHA-256...' : 'Verify & Restore Locally'}
            </button>
          </form>

          {restoreError && (
            <div className="rounded-xl border border-[#FECACA] bg-[#FEF2F2] p-4 font-medium text-[#DC2626]">
              {restoreError}
            </div>
          )}

          {restoreResult && (
            <div data-testid="restore-success-box" className="rounded-xl border border-[#BBF7D0] bg-[#ECFDF3] p-4 space-y-2.5">
              <div className="flex items-center gap-2 font-semibold text-[#15803D] text-base">
                <CheckCircle2 className="w-5 h-5" />
                <span>Verified SHA-256 &amp; Restored {restoreResult.restoredCount} Occurrence(s)</span>
              </div>
              {restoreResult.notes.map((n, i) => (
                <p key={i} className="text-xs text-[#475569]">{n}</p>
              ))}
              <button
                type="button"
                onClick={handleDownloadRestored}
                className="ae-btn-primary inline-flex items-center gap-2 rounded-xl px-4 h-10 text-sm cursor-pointer"
              >
                <Download className="w-4 h-4" /> Download Restored File
              </button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
