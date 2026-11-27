import React, { useEffect, useState } from 'react';
import { Lock, HardDriveDownload, CheckCircle2, AlertTriangle, Shield } from 'lucide-react';
import {
  checkOfflineStatus,
  fetchLocalAssetManifestSummary,
  precacheOfflineModels,
  type AssetManifestSummary,
  type OfflineStatusReport,
} from '../../state/offline.ts';
import { useSession } from '../../state/session.tsx';
import { PageHeader } from '../../components/ui/PageHeader.tsx';

export const PrivacyCenter: React.FC = () => {
  const { pushToast } = useSession();
  const [offline, setOffline] = useState<OfflineStatusReport | null>(null);
  const [manifest, setManifest] = useState<AssetManifestSummary | null>(null);
  const [cachingProgress, setCachingProgress] = useState<{ done: number; total: number; current: string } | null>(null);

  const refresh = async () => {
    const [o, m] = await Promise.all([checkOfflineStatus(), fetchLocalAssetManifestSummary()]);
    setOffline(o);
    setManifest(m);
  };

  useEffect(() => {
    let active = true;
    Promise.all([checkOfflineStatus(), fetchLocalAssetManifestSummary()]).then(([o, m]) => {
      if (!active) return;
      setOffline(o);
      setManifest(m);
    });
    return () => {
      active = false;
    };
  }, []);

  const handlePrepareOffline = async (prefix: '' | '/assets/ocr/' | '/assets/vision/' | '/assets/ner/') => {
    setCachingProgress({ done: 0, total: 1, current: 'Starting service worker precache...' });
    const res = await precacheOfflineModels(prefix, (p) => setCachingProgress(p));
    setCachingProgress(null);
    if (!res) {
      pushToast('warning', 'Service Worker is only active in production build (`npm run preview`) after initial registration.');
      return;
    }
    await refresh();
    if (res.failed.length > 0) {
      pushToast('warning', `Cached ${res.done - res.failed.length}/${res.total} files; ${res.failed.length} failed.`);
    } else {
      pushToast('success', `Offline cache ready (${res.done} local model/WASM assets verified).`);
    }
  };

  return (
    <div className="space-y-8 ae-fade-in">
      <PageHeader
        eyebrow="Security & Offline Control"
        title="Privacy Center"
        description="Inspect browser trust boundaries, prepare local OCR/Vision/NER caches for offline operation, and review honest engineering limits."
      />

      {/* Browser Trust Boundary Diagram */}
      <section className="ae-card p-6 sm:p-8 space-y-5">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-[#E1F5EF] text-[#087F6D] flex items-center justify-center shrink-0">
            <Lock className="w-5 h-5" aria-hidden="true" />
          </div>
          <h2 className="text-xl font-semibold text-[#101828]">Browser Trust Boundary &amp; Data Lifecycle</h2>
        </div>

        <svg
          viewBox="0 0 760 190"
          role="img"
          aria-label="Diagram showing all document processing inside browser volatile RAM and workers, separated from static same-origin asset hosting and blocked external origins"
          className="w-full max-w-3xl rounded-2xl border border-[#E2E8F0] bg-[#F7F9FC] p-3"
        >
          <rect x="20" y="20" width="440" height="150" rx="12" fill="#FFFFFF" stroke="#087F6D" strokeWidth="2" />
          <text x="36" y="44" fill="#087F6D" fontSize="12" fontWeight="bold">
            Browser Sandbox (Volatile Session RAM + Web Workers)
          </text>
          <text x="36" y="66" fill="#101828" fontSize="11">• Raw TXT / CSV / PNG / JPEG stay in memory only</text>
          <text x="36" y="86" fill="#101828" fontSize="11">• Rule Validators, Leak Hunter, K-Anonymity, Canvas Flatten</text>
          <text x="36" y="106" fill="#101828" fontSize="11">• Local Tesseract OCR, MediaPipe BlazeFace, ONNX BERT-NER</text>
          <text x="36" y="126" fill="#64748B" fontSize="10">• Zero localStorage / IndexedDB / URL / Cookie PII storage</text>
          <text x="36" y="146" fill="#64748B" fontSize="10">• Reset terminates workers &amp; clears all mappings/object URLs</text>

          <rect x="495" y="20" width="245" height="68" rx="12" fill="#FFFFFF" stroke="#6366F1" strokeWidth="1.5" />
          <text x="510" y="44" fill="#4338CA" fontSize="11" fontWeight="bold">Same-Origin Static Host / SW Cache</text>
          <text x="510" y="63" fill="#475569" fontSize="10">Serves JS, CSS, WASM &amp; Models only</text>
          <text x="510" y="78" fill="#64748B" fontSize="10">(GET allowlist; zero user data)</text>

          <rect x="495" y="102" width="245" height="68" rx="12" fill="#FEF2F2" stroke="#DC2626" strokeWidth="1.5" strokeDasharray="5 4" />
          <text x="510" y="126" fill="#DC2626" fontSize="11" fontWeight="bold">External Endpoints / Cloud AI</text>
          <text x="510" y="145" fill="#475569" fontSize="10">Blocked by CSP connect-src &apos;self&apos;</text>
          <text x="510" y="160" fill="#64748B" fontSize="10">Zero telemetry, zero remote fallback</text>
        </svg>
      </section>

      {/* Offline Model Asset Readiness */}
      <section className="ae-card p-6 sm:p-8 space-y-5 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-1 max-w-2xl">
            <h2 className="text-xl font-semibold text-[#101828]">Local Model Assets &amp; Offline Readiness</h2>
            <p className="text-[#475569]">
              Models are served strictly from <code>/assets/</code> on the same origin. Use <strong>Prepare All Offline Models</strong> to precache lightweight WASM &amp; ML weights into the Service Worker cache.
            </p>
          </div>
          <div className="flex flex-wrap gap-2.5">
            <button
              type="button"
              data-testid="prepare-offline-ocr-vision-btn"
              onClick={() => handlePrepareOffline('/assets/ocr/')}
              className="ae-btn-secondary rounded-xl px-4 h-11 text-sm cursor-pointer"
            >
              Cache OCR Assets
            </button>
            <button
              type="button"
              data-testid="prepare-offline-all-btn"
              onClick={() => handlePrepareOffline('')}
              className="ae-btn-primary inline-flex items-center gap-2 rounded-xl px-5 h-11 text-[15px] cursor-pointer"
            >
              <HardDriveDownload className="w-4 h-4" /> Prepare All Offline Models
            </button>
          </div>
        </div>

        {cachingProgress && (
          <div className="ae-well p-4 space-y-2 border-[#087F6D]/30 bg-[#E1F5EF]/50">
            <div className="flex justify-between text-[#087F6D] font-mono text-xs font-semibold">
              <span>Caching {cachingProgress.current}</span>
              <span>{cachingProgress.done}/{cachingProgress.total}</span>
            </div>
            <div className="w-full h-2.5 rounded-full bg-[#E2E8F0] overflow-hidden">
              <div
                className="h-full bg-[#087F6D]"
                style={{ width: `${Math.round((cachingProgress.done / Math.max(1, cachingProgress.total)) * 100)}%` }}
              />
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="ae-well p-4">
            <div className="text-xs font-medium text-[#64748B]">App Shell (SW)</div>
            <div className="font-mono font-semibold text-[#101828] mt-1.5 flex items-center gap-2 text-sm">
              {offline?.shellReady ? (
                <CheckCircle2 className="w-4 h-4 text-[#15803D]" />
              ) : (
                <AlertTriangle className="w-4 h-4 text-[#B45309]" />
              )}
              <span>
                {offline?.shellReady
                  ? `Cached (${offline.shellCached}/${offline.shellTotal})`
                  : offline?.swControlled
                    ? 'Controlled (partial)'
                    : 'Not SW-cached (dev or reload needed)'}
              </span>
            </div>
          </div>

          <div className="ae-well p-4">
            <div className="text-xs font-medium text-[#64748B]">Tesseract OCR (eng)</div>
            <div className="font-mono font-semibold text-[#101828] mt-1.5 text-sm">
              Manifest: {manifest ? `${manifest.ocrCount} files (${(manifest.ocrBytes / 1048576).toFixed(1)} MiB)` : 'Checking...'}
            </div>
            <div className="text-xs text-[#64748B] mt-1">
              SW Cache: {offline?.ocr.ready ? 'Offline Ready' : `${offline?.ocr.cached ?? 0}/${offline?.ocr.total ?? 0}`}
            </div>
          </div>

          <div className="ae-well p-4">
            <div className="text-xs font-medium text-[#64748B]">MediaPipe Face + Seg</div>
            <div className="font-mono font-semibold text-[#101828] mt-1.5 text-sm">
              Manifest: {manifest ? `${manifest.visionCount} files (${(manifest.visionBytes / 1048576).toFixed(1)} MiB)` : 'Checking...'}
            </div>
            <div className="text-xs text-[#64748B] mt-1">
              SW Cache: {offline?.vision.ready ? 'Offline Ready' : `${offline?.vision.cached ?? 0}/${offline?.vision.total ?? 0}`}
            </div>
          </div>

          <div className="ae-well p-4">
            <div className="text-xs font-medium text-[#64748B]">ONNX BERT-NER (q8)</div>
            <div className="font-mono font-semibold text-[#101828] mt-1.5 text-sm">
              Manifest: {manifest ? `${manifest.nerCount} files (${(manifest.nerBytes / 1048576).toFixed(1)} MiB)` : 'Checking...'}
            </div>
            <div className="text-xs text-[#64748B] mt-1">
              SW Cache: {offline?.ner.ready ? 'Offline Ready' : `${offline?.ner.cached ?? 0}/${offline?.ner.total ?? 0}`}
            </div>
          </div>
        </div>

        {offline?.storageQuotaBytes && (
          <div className="text-xs text-[#64748B] font-mono">
            Browser Storage Estimate: {((offline.storageUsageBytes ?? 0) / 1048576).toFixed(1)} MiB used of {(offline.storageQuotaBytes / 1048576).toFixed(0)} MiB quota.
          </div>
        )}
      </section>

      {/* Honest Limitations */}
      <section className="ae-card p-6 sm:p-8 space-y-3 text-[15px] text-[#475569]">
        <div className="flex items-center gap-2.5 font-semibold text-lg text-[#101828]">
          <Shield className="w-5 h-5 text-[#087F6D]" />
          <span>Scope &amp; Honest Engineering Limitations</span>
        </div>
        <ul className="list-disc pl-6 space-y-2 leading-relaxed">
          <li>CipherMask does not claim regulatory compliance (GDPR/HIPAA/DPDP), 100% recall, or zero risk.</li>
          <li>Luhn and Verhoeff validate numeric format and check digits only, never live financial accounts or UIDAI records.</li>
          <li>JavaScript garbage collection cannot guarantee immediate physical RAM erasure on session reset.</li>
          <li>CipherMask cannot protect against a compromised OS, keylogger, or privileged malicious browser extension.</li>
          <li>English BERT-NER weights (CoNLL-2003) carry documented training-distribution limitations on non-Western names and transliterations.</li>
        </ul>
      </section>
    </div>
  );
};
