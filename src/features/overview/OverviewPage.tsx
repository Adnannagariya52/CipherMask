import React, { useEffect, useState } from 'react';
import {
  FileText,
  Image as ImageIcon,
  Table2,
  MessageSquareLock,
  ArrowRight,
  ShieldCheck,
  Cpu,
  Lock,
  KeyRound,
  FileCheck2,
} from 'lucide-react';
import { useSession } from '../../state/session.tsx';
import { sharedGemmaReasoner, type ModelDiagnostics } from '../../intelligence/localReasoner.ts';
import { checkOfflineStatus, type OfflineStatusReport } from '../../state/offline.ts';
import { IS_CLOUD_BUILD_PROFILE } from '../../gateway/firewall.ts';

export const OverviewPage: React.FC = () => {
  const { setActiveModule, textDetection, lastAuditReceipt } = useSession();
  const [modelDiag, setModelDiag] = useState<ModelDiagnostics>(() => sharedGemmaReasoner.getStatus());
  const [offline, setOffline] = useState<OfflineStatusReport | null>(null);

  useEffect(() => {
    checkOfflineStatus().then(setOffline).catch(() => {});
    return sharedGemmaReasoner.subscribe(() => setModelDiag(sharedGemmaReasoner.getStatus()));
  }, []);

  const shields = [
    {
      id: 'text' as const,
      title: 'Text Shield',
      desc: 'Deterministic regex, Luhn & Verhoeff checksums, Unicode Leak Hunter, and optional local BERT-NER or Gemma hybrid review.',
      cta: 'Open Text Shield',
      icon: FileText,
    },
    {
      id: 'vision' as const,
      title: 'Vision Shield',
      desc: 'In-browser Tesseract OCR, MediaPipe face concealment, QR/barcode redaction, EXIF stripping, and Canvas pixel flattening.',
      cta: 'Open Vision Shield',
      icon: ImageIcon,
    },
    {
      id: 'data' as const,
      title: 'Data Shield',
      desc: 'CSV cell pseudonymization, formula injection checks, k-anonymity group risk measurement, and utility-preserving optimization.',
      cta: 'Open Data Shield',
      icon: Table2,
    },
  ];

  return (
    <div className="space-y-12 ae-fade-in">
      {/* Editorial Hero */}
      <section className="relative overflow-hidden ae-card p-8 sm:p-12">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-24 -right-24 h-72 w-72 rounded-full bg-[#E1F5EF]/70 blur-3xl"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute bottom-0 left-0 right-0 h-[2px] bg-gradient-to-r from-[#087F6D] via-[#C5A66A]/60 to-transparent"
        />

        <div className="relative max-w-3xl space-y-6">
          <div className="inline-flex items-center gap-2 rounded-full border border-[#E2E8F0] bg-[#F7F9FC] px-3.5 py-1.5 text-[13px] font-medium text-[#475569]">
            <Lock className="w-3.5 h-3.5 text-[#087F6D]" aria-hidden="true" />
            <span>Zero-Upload Browser Architecture</span>
            <span className="text-[#CBD5E1]">|</span>
            <span className="text-[#087F6D] font-semibold">
              {IS_CLOUD_BUILD_PROFILE ? 'Optional Cloud Relay Enabled' : 'Strict-Local Profile'}
            </span>
          </div>

          <h1 className="text-4xl sm:text-5xl lg:text-[56px] font-semibold leading-[1.1] tracking-[-0.03em] text-[#101828]">
            Intelligence without exposure.
          </h1>

          <p className="text-lg sm:text-xl leading-relaxed text-[#475569] max-w-2xl">
            Detect, protect and transform sensitive information before it leaves your device. Built for verifiable client-side sanitization across documents, spreadsheets, images, and AI conversations.
          </p>

          <div className="flex flex-wrap items-center gap-3 pt-2">
            <button
              type="button"
              onClick={() => setActiveModule('text')}
              className="ae-btn-primary inline-flex items-center gap-2 rounded-xl px-6 h-12 text-[15px] cursor-pointer"
            >
              <span>Start in Text Shield</span>
              <ArrowRight className="w-4 h-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => setActiveModule('chat')}
              className="ae-btn-indigo inline-flex items-center gap-2 rounded-xl px-6 h-12 text-[15px] cursor-pointer"
            >
              <MessageSquareLock className="w-4 h-4" aria-hidden="true" />
              <span>Open CipherChat</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveModule('setup')}
              className="ae-btn-secondary inline-flex items-center gap-2 rounded-xl px-5 h-12 text-[15px] cursor-pointer"
            >
              <Cpu className="w-4 h-4 text-[#475569]" aria-hidden="true" />
              <span>Local Model Setup</span>
            </button>
          </div>
        </div>
      </section>

      {/* Honest Session & Runtime Snapshot */}
      <section aria-label="System state" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
        <div className="ae-card p-6 space-y-1.5">
          <div className="text-[13px] font-medium text-[#64748B]">Core Sanitization Engine</div>
          <div className="text-xl font-semibold text-[#101828] flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-[#087F6D]" aria-hidden="true" />
            <span>Ready Locally</span>
          </div>
          <p className="text-sm text-[#475569]">Deterministic rules, OCR, vision, and CSV run in volatile memory.</p>
        </div>

        <div className="ae-card p-6 space-y-1.5">
          <div className="text-[13px] font-medium text-[#64748B]">Local Gemma 3 4B (WebGPU)</div>
          <div className="text-xl font-semibold text-[#101828] flex items-center gap-2">
            <Cpu className="w-5 h-5 text-[#6366F1]" aria-hidden="true" />
            <span>{modelDiag.state === 'ready' ? 'Loaded & Ready' : 'Not Loaded'}</span>
          </div>
          <p className="text-sm text-[#475569]">
            {modelDiag.state === 'ready'
              ? 'Device-local WebGPU inference active.'
              : 'Select your local .task file in Local AI & Cloud when needed.'}
          </p>
        </div>

        <div className="ae-card p-6 space-y-1.5">
          <div className="text-[13px] font-medium text-[#64748B]">Active Session Findings</div>
          <div className="text-xl font-semibold font-mono tabular-nums text-[#101828]">
            {textDetection.totalAcceptedOccurrences} entities
          </div>
          <p className="text-sm text-[#475569]">
            {lastAuditReceipt
              ? `Latest receipt: ${lastAuditReceipt.outputSha256.slice(0, 10)}…`
              : 'No SHA-256 export receipt generated yet.'}
          </p>
        </div>

        <div className="ae-card p-6 space-y-1.5">
          <div className="text-[13px] font-medium text-[#64748B]">Offline Shell Cache</div>
          <div className="text-xl font-semibold text-[#101828]">
            {offline?.shellReady ? 'Cached Offline' : 'Browser Online Runtime'}
          </div>
          <p className="text-sm text-[#475569]">
            Precache local WASM and model bundles in Privacy Center.
          </p>
        </div>
      </section>

      {/* Three Privacy Shields */}
      <section className="space-y-5">
        <div className="space-y-1">
          <h2 className="text-2xl font-semibold text-[#101828]">Three Dedicated Privacy Shields</h2>
          <p className="text-base text-[#475569]">
            Separate processing pipelines tailored for unstructured text, images, and structured datasets.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {shields.map((item) => {
            const Icon = item.icon;
            return (
              <div key={item.id} className="ae-card p-7 flex flex-col justify-between gap-6 hover:border-[#087F6D]/45 transition-colors">
                <div className="space-y-3">
                  <div className="w-11 h-11 rounded-xl bg-[#E1F5EF] text-[#087F6D] flex items-center justify-center">
                    <Icon className="w-5 h-5" aria-hidden="true" />
                  </div>
                  <h3 className="text-xl font-semibold text-[#101828]">{item.title}</h3>
                  <p className="text-[15px] leading-relaxed text-[#475569]">{item.desc}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setActiveModule(item.id)}
                  className="inline-flex items-center gap-2 text-[15px] font-semibold text-[#087F6D] hover:text-[#066557] cursor-pointer"
                >
                  <span>{item.cta}</span>
                  <ArrowRight className="w-4 h-4" aria-hidden="true" />
                </button>
              </div>
            );
          })}
        </div>
      </section>

      {/* AI & Verification Row */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="ae-card p-7 space-y-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[#EEF2FF] text-[#6366F1] flex items-center justify-center">
              <MessageSquareLock className="w-5 h-5" aria-hidden="true" />
            </div>
            <div>
              <h3 className="text-xl font-semibold text-[#101828]">CipherChat, PrivacyScript &amp; Privacy Court</h3>
              <p className="text-sm text-[#475569]">Trust-separated local and explicit-approval AI workflows</p>
            </div>
          </div>
          <p className="text-[15px] leading-relaxed text-[#475569]">
            Translate natural-language privacy intent into validated rules via PrivacyScript, review trade-offs in Privacy Court, maintain pseudonyms with Identity Bridge, and enforce fail-closed outbound verification.
          </p>
          <button
            type="button"
            onClick={() => setActiveModule('chat')}
            className="ae-btn-indigo inline-flex items-center gap-2 rounded-xl px-5 h-11 text-[15px] cursor-pointer"
          >
            <span>Launch CipherChat</span>
            <ArrowRight className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        <div className="ae-card p-7 space-y-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[#F1F5F9] text-[#101828] flex items-center justify-center">
              <FileCheck2 className="w-5 h-5" aria-hidden="true" />
            </div>
            <div>
              <h3 className="text-xl font-semibold text-[#101828]">Audit Receipts &amp; Encrypted Identity Vault</h3>
              <p className="text-sm text-[#475569]">Cryptographic integrity and optional reversible mappings</p>
            </div>
          </div>
          <p className="text-[15px] leading-relaxed text-[#475569]">
            Generate SHA-256 export receipts without storing raw PII, evaluate detector precision/recall in Benchmark Lab, or encrypt reversible TXT/CSV pseudonym vaults locally with AES-GCM-256.
          </p>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => setActiveModule('audit')}
              className="ae-btn-secondary inline-flex items-center gap-2 rounded-xl px-4 h-11 text-[15px] cursor-pointer"
            >
              <FileCheck2 className="w-4 h-4 text-[#087F6D]" aria-hidden="true" />
              <span>Audit &amp; Verify</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveModule('vault')}
              className="ae-btn-secondary inline-flex items-center gap-2 rounded-xl px-4 h-11 text-[15px] cursor-pointer"
            >
              <KeyRound className="w-4 h-4 text-[#087F6D]" aria-hidden="true" />
              <span>Identity Vault</span>
            </button>
          </div>
        </div>
      </section>
    </div>
  );
};
