import React, { useEffect, useRef, useState } from 'react';
import {
  Cpu,
  Cloud,
  CheckCircle2,
  AlertTriangle,
  Upload,
  RefreshCw,
  Trash2,
  ShieldAlert,
  Lock,
} from 'lucide-react';
import { runWebGpuDiagnostic, type WebGpuDiagnosticReport } from '../../intelligence/webgpu.ts';
import { sharedGemmaReasoner, type ModelDiagnostics } from '../../intelligence/localReasoner.ts';
import { IS_CLOUD_BUILD_PROFILE } from '../../gateway/firewall.ts';
import { useSession } from '../../state/session.tsx';
import { PageHeader } from '../../components/ui/PageHeader.tsx';

export const ModelSetupPanel: React.FC = () => {
  const {
    cloudConfig,
    setCloudConfig,
    ephemeralApiKey,
    setEphemeralApiKey,
    pushToast,
  } = useSession();

  const fileRef = useRef<HTMLInputElement>(null);
  const [gpuReport, setGpuReport] = useState<WebGpuDiagnosticReport | null>(null);
  const [modelDiag, setModelDiag] = useState<ModelDiagnostics>(() => sharedGemmaReasoner.getStatus());
  const [sameOriginAvailable, setSameOriginAvailable] = useState<boolean>(false);

  useEffect(() => {
    runWebGpuDiagnostic().then(setGpuReport);
    sharedGemmaReasoner.checkSameOriginAssetExists().then(setSameOriginAvailable);
    const unsub = sharedGemmaReasoner.subscribe(() => {
      setModelDiag(sharedGemmaReasoner.getStatus());
    });
    return () => {
      unsub();
    };
  }, []);

  const handleInitSameOrigin = async () => {
    const diag = await sharedGemmaReasoner.init({ sourceKind: 'same-origin' });
    setModelDiag(diag);
    if (diag.state === 'ready') {
      pushToast('success', `Gemma 3 4B ready (${diag.loadDurationMs} ms load).`);
    } else {
      pushToast('warning', diag.errorMessage || `Gemma state: ${diag.state}`);
    }
  };

  const handleInitLocalFile = async (file: File) => {
    const diag = await sharedGemmaReasoner.init({ sourceKind: 'local-file', localFile: file });
    setModelDiag(diag);
    if (diag.state === 'ready') {
      pushToast('success', `Loaded ${file.name} via WebGPU (${diag.loadDurationMs} ms).`);
    } else {
      pushToast('error', diag.errorMessage || 'Failed to initialize selected .task file.');
    }
  };

  return (
    <div className="space-y-8 ae-fade-in">
      <PageHeader
        eyebrow="AI Runtime & Gateway"
        title="Local AI &amp; Cloud Setup"
        description="Activate in-browser Gemma 3 4B inference from your own device without uploading weights, and review optional cloud gateway status."
      />

      {/* Local Gemma 3 4B + WebGPU Section */}
      <section className="ae-card p-6 sm:p-8 space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 rounded-2xl bg-[#EEF2FF] text-[#6366F1] flex items-center justify-center shrink-0">
              <Cpu className="w-6 h-6" aria-hidden="true" />
            </div>
            <div className="space-y-1">
              <h2 className="text-xl font-semibold text-[#101828]">
                Gemma 3 4B Instruct (Local Browser AI)
              </h2>
              <p className="text-[15px] text-[#475569] leading-relaxed max-w-2xl">
                Runs privately inside Chrome or Edge using graphics acceleration (WebGPU). All deterministic rules, OCR, vision, and CSV tools work even when Gemma is not loaded.
              </p>
            </div>
          </div>

          <span
            data-testid="gemma-status-badge"
            className={`rounded-full px-4 py-1.5 text-xs font-semibold border tracking-wide ${
              modelDiag.state === 'ready'
                ? 'border-[#BBF7D0] bg-[#ECFDF3] text-[#15803D]'
                : modelDiag.state === 'asset-verified'
                  ? 'border-[#BBF7D0] bg-[#ECFDF3] text-[#15803D]'
                  : modelDiag.state === 'loading' || modelDiag.state === 'warming'
                    ? 'border-[#C7D2FE] bg-[#EEF2FF] text-[#4338CA]'
                    : 'border-[#FDE68A] bg-[#FFFBEB] text-[#B45309]'
            }`}
          >
            {modelDiag.state === 'ready'
              ? 'READY'
              : modelDiag.state === 'asset-verified'
                ? 'ASSET VERIFIED'
                : modelDiag.state === 'needs-assets'
                  ? 'NEEDS ASSETS'
                  : modelDiag.state.toUpperCase()}
          </span>
        </div>

        {/* Primary Model Loading Controls */}
        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={fileRef}
            type="file"
            accept=".task,.litertlm,.bin"
            className="hidden"
            data-testid="gemma-local-file-input"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleInitLocalFile(f);
              e.target.value = '';
            }}
          />
          <button
            type="button"
            data-testid="gemma-select-file-btn"
            disabled={modelDiag.state === 'loading' || modelDiag.state === 'warming'}
            onClick={() => fileRef.current?.click()}
            className={`inline-flex items-center gap-2 rounded-xl px-5 h-12 text-[15px] disabled:opacity-45 cursor-pointer ${
              !sameOriginAvailable ? 'ae-btn-primary' : 'ae-btn-secondary'
            }`}
          >
            <Upload className={`w-4 h-4 ${!sameOriginAvailable ? '' : 'text-[#087F6D]'}`} />
            <span>Select Local .task File (Streaming Reader)</span>
          </button>

          {sameOriginAvailable && (
            <button
              type="button"
              disabled={modelDiag.state === 'loading' || modelDiag.state === 'warming'}
              onClick={handleInitSameOrigin}
              className="ae-btn-primary rounded-xl px-5 h-12 text-[15px] disabled:opacity-45 cursor-pointer"
            >
              Initialize /models/gemma3-4b-it-int4-web.task
            </button>
          )}

          {modelDiag.state === 'ready' && (
            <button
              type="button"
              onClick={() => sharedGemmaReasoner.dispose()}
              className="ae-btn-danger inline-flex items-center gap-2 rounded-xl px-4 h-12 text-[15px] cursor-pointer"
            >
              <Trash2 className="w-4 h-4" /> Unload Model
            </button>
          )}
        </div>

        <div className="ae-well p-5 text-[15px] text-[#475569] space-y-2">
          <div className="font-semibold text-[#101828]">
            How Device-Local Loading Works
          </div>
          <p className="text-sm leading-relaxed">
            Because the quantized Gemma 3 4B package (<code>gemma3-4b-it-int4-web.task</code>, ~2.56 GB) is large and license-gated, it is not hosted remotely. Accept Google&apos;s license at{' '}
            <a
              href="https://huggingface.co/litert-community/Gemma3-4B-IT"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[#087F6D] font-semibold underline hover:text-[#066557]"
            >
              Hugging Face (litert-community/Gemma3-4B-IT)
            </a>
            , download the file to your device, and select it above to stream weights directly into browser memory.
          </p>
        </div>

        {/* Expandable Hardware Compatibility Details */}
        <details className="ae-card p-5 text-sm">
          <summary className="cursor-pointer font-semibold text-[#101828] flex items-center justify-between gap-2 list-none">
            <span>
              Browser Hardware Compatibility:{' '}
              <span className={gpuReport?.statusLabel === 'READY' ? 'text-[#15803D]' : 'text-[#B45309]'}>
                {gpuReport ? gpuReport.statusLabel : 'Checking WebGPU...'}
              </span>
            </span>
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                runWebGpuDiagnostic().then(setGpuReport);
              }}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-[#087F6D] hover:underline cursor-pointer"
            >
              <RefreshCw className="w-4 h-4" /> Re-check GPU
            </button>
          </summary>

          {gpuReport && (
            <div className="mt-4 pt-4 border-t border-[#EDF0F4] space-y-2">
              <div className="flex flex-wrap gap-5 font-mono text-xs text-[#475569]">
                <span>Secure Context: <strong className="text-[#101828]">{String(gpuReport.isSecureContext)}</strong></span>
                <span>Adapter: <strong className="text-[#101828]">{gpuReport.adapterAvailable ? 'Yes' : 'No'}</strong></span>
                <span>shader-f16: <strong className="text-[#101828]">{gpuReport.shaderF16 ? 'Yes' : 'No'}</strong></span>
                {gpuReport.adapterDescription && (
                  <span>Device: <strong className="text-[#101828]">{gpuReport.adapterDescription}</strong></span>
                )}
              </div>
              {gpuReport.guidance.map((g, i) => (
                <p key={i} className="text-sm text-[#64748B]">{g}</p>
              ))}
            </div>
          )}
        </details>

        {modelDiag.errorMessage && (
          <div className="rounded-xl border border-[#FDE68A] bg-[#FFFBEB] p-4 text-sm text-[#B45309] space-y-2">
            <div className="font-semibold flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" />
              <span>Local Gemma unavailable — deterministic engine remains active</span>
            </div>
            <p className="font-mono text-xs">{modelDiag.errorMessage}</p>
          </div>
        )}

        {modelDiag.state === 'ready' && (
          <div className="rounded-xl border border-[#BBF7D0] bg-[#ECFDF3] p-4 text-sm font-mono space-y-1.5 text-[#15803D]">
            <div className="flex items-center gap-2 font-sans font-semibold text-base">
              <CheckCircle2 className="w-5 h-5" />
              <span>Smoke Tests {modelDiag.smokePassed ? 'PASSED' : 'Completed'}</span>
            </div>
            <div className="text-xs">
              Load: {modelDiag.loadDurationMs} ms | Warm-up: {modelDiag.warmUpDurationMs ?? '-'} ms | TTFT: {modelDiag.timeToFirstTokenMs ?? '-'} ms | Last inference: {modelDiag.lastInferenceMs ?? '-'} ms
              {modelDiag.tokensPerSec ? ` | ${modelDiag.tokensPerSec} tok/s` : ''}
            </div>
            {modelDiag.smokeOutputPreview && <div className="text-xs">Smoke 1: {modelDiag.smokeOutputPreview}</div>}
            {modelDiag.smokeSemanticPreview && <div className="text-xs">Smoke 2: {modelDiag.smokeSemanticPreview}</div>}
          </div>
        )}
      </section>

      {/* Optional Protected Cloud / Gemini Configuration */}
      <section className="ae-card p-6 sm:p-8 space-y-5 text-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 rounded-2xl bg-[#F1F5F9] text-[#101828] flex items-center justify-center shrink-0">
              <Cloud className="w-6 h-6 text-[#087F6D]" aria-hidden="true" />
            </div>
            <div className="space-y-1">
              <h2 className="text-xl font-semibold text-[#101828]">
                Optional Protected Cloud (Gemini) Configuration
              </h2>
              <p className="text-[15px] text-[#475569] leading-relaxed max-w-2xl">
                Disabled in strict-local builds. Cloud mode requires organizer permission and explicit approval for every sanitized payload via the Outbound Privacy Firewall.
              </p>
            </div>
          </div>

          <span
            data-testid="cloud-profile-badge"
            className={`rounded-full px-3.5 py-1.5 text-xs font-semibold border ${
              IS_CLOUD_BUILD_PROFILE
                ? 'border-[#C7D2FE] bg-[#EEF2FF] text-[#4338CA]'
                : 'border-[#E2E8F0] bg-[#F1F5F9] text-[#475569]'
            }`}
          >
            {IS_CLOUD_BUILD_PROFILE ? 'CLOUD PROFILE BUILD' : 'STRICT-LOCAL BUILD (LOCKED)'}
          </span>
        </div>

        {!IS_CLOUD_BUILD_PROFILE ? (
          <div className="ae-well p-4 flex items-start gap-3 text-sm text-[#475569]">
            <Lock className="w-5 h-5 text-[#087F6D] shrink-0 mt-0.5" />
            <div className="leading-relaxed">
              This build was compiled with <code>npm run build:strict</code> (CSP <code>connect-src &apos;self&apos;</code>). Cloud outbound transport is compiled disabled so no remote requests can occur.
            </div>
          </div>
        ) : (
          <div className="space-y-4 ae-well p-5">
            <label className="flex items-center gap-2.5 cursor-pointer text-[#101828] font-medium text-[15px]">
              <input
                type="checkbox"
                checked={cloudConfig.organizerPermitted}
                onChange={(e) =>
                  setCloudConfig((prev) => ({ ...prev, organizerPermitted: e.target.checked }))
                }
                className="h-4 w-4 accent-[#087F6D]"
              />
              <span>Organizer / Owner explicitly authorized optional sanitized cloud AI extension</span>
            </label>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <label className="space-y-1.5">
                <span className="text-[#475569] font-medium block">Gemini Model ID</span>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={cloudConfig.modelId}
                    onChange={(e) =>
                      setCloudConfig((prev) => ({ ...prev, modelId: e.target.value.trim() }))
                    }
                    className="ae-input flex-1 px-3 h-10 font-mono text-sm"
                  />
                  {cloudConfig.transportMode === 'relay' && (
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          const endpoint =
                            typeof window !== 'undefined' &&
                            window.location.hostname !== '127.0.0.1' &&
                            window.location.hostname !== 'localhost'
                              ? '/api/models'
                              : 'http://127.0.0.1:8787/api/models';
                          const res = await fetch(endpoint);
                          const data = await res.json();
                          if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
                          setCloudConfig((prev) => ({ ...prev, modelId: data.selectedModel }));
                          pushToast('success', `Validated Gemini Flash model: ${data.selectedModel}`);
                        } catch (err) {
                          pushToast('error', `Model discovery failed: ${err instanceof Error ? err.message : String(err)}`);
                        }
                      }}
                      className="ae-btn-secondary rounded-xl px-3 h-10 text-xs font-semibold text-[#087F6D] cursor-pointer"
                    >
                      Auto-Select
                    </button>
                  )}
                </div>
              </label>

              <label className="space-y-1.5">
                <span className="text-[#475569] font-medium block">Provider Tier</span>
                <select
                  value={cloudConfig.providerTier}
                  onChange={(e) =>
                    setCloudConfig((prev) => ({
                      ...prev,
                      providerTier: e.target.value as 'unpaid-demo' | 'authorized-paid',
                    }))
                  }
                  className="ae-input w-full px-3 h-10 text-sm"
                >
                  <option value="unpaid-demo">Unpaid Demo (Synthetic/Public ONLY)</option>
                  <option value="authorized-paid">Authorized Paid Business Tier</option>
                </select>
              </label>

              <label className="space-y-1.5">
                <span className="text-[#475569] font-medium block">Transport</span>
                <select
                  value={cloudConfig.transportMode}
                  onChange={(e) =>
                    setCloudConfig((prev) => ({
                      ...prev,
                      transportMode: e.target.value as 'relay' | 'direct-byok',
                    }))
                  }
                  className="ae-input w-full px-3 h-10 text-sm"
                >
                  <option value="relay">Loopback / Same-Origin Relay</option>
                  <option value="direct-byok">Demo Direct BYOK (Ephemeral RAM Key)</option>
                </select>
              </label>
            </div>

            {cloudConfig.transportMode === 'direct-byok' && (
              <div className="space-y-2.5 rounded-xl border border-[#FDE68A] bg-[#FFFBEB] p-4 text-[#B45309]">
                <div className="flex items-start gap-2.5">
                  <ShieldAlert className="w-5 h-5 shrink-0 mt-0.5" />
                  <span>
                    Browser-held keys are accessible to extensions/devtools and are NOT production-safe. Key stays in volatile memory only and is cleared on Reset.
                  </span>
                </div>
                <input
                  type="password"
                  placeholder="Enter ephemeral restricted Gemini API key (memory only)"
                  value={ephemeralApiKey}
                  onChange={(e) => setEphemeralApiKey(e.target.value)}
                  className="ae-input w-full px-3.5 h-10 font-mono text-sm"
                />
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
};
