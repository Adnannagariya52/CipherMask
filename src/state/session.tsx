import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AuditReceipt,
  DetectionCandidate,
  DetectionResult,
  RedactionOutput,
  RedactionPolicy,
} from '../engine/types.ts';
import { createDefaultPolicy } from '../engine/redaction.ts';
import { applyRedactionPolicy, runDetectionPipeline } from '../engine/pipeline.ts';
import type { VaultPayload } from '../engine/crypto/vault.ts';
import { sharedGemmaReasoner } from '../intelligence/localReasoner.ts';
import { sharedOutboundFirewall } from '../gateway/firewall.ts';

export type AppModuleId =
  | 'overview'
  | 'chat'
  | 'text'
  | 'vision'
  | 'data'
  | 'benchmark'
  | 'audit'
  | 'vault'
  | 'privacy'
  | 'setup'
  | 'promptLog';

export interface CloudConfig {
  organizerPermitted: boolean;
  modelId: string;
  providerTier: 'unpaid-demo' | 'authorized-paid';
  transportMode: 'relay' | 'direct-byok';
}

export interface ToastItem {
  id: string;
  kind: 'success' | 'error' | 'info' | 'warning';
  message: string;
}

export interface SessionContextValue {
  activeModule: AppModuleId;
  setActiveModule: (m: AppModuleId) => void;
  sessionId: string;
  sessionRevision: number;
  resetCounter: number;
  resetSession: () => void;

  // Text Shield shared volatile state
  textInput: string;
  setTextInput: (val: string) => void;
  textFilename: string;
  setTextFilename: (name: string) => void;
  textPolicy: RedactionPolicy;
  setTextPolicy: React.Dispatch<React.SetStateAction<RedactionPolicy>>;
  textDetection: DetectionResult;
  textRedaction: RedactionOutput;
  textBusy: boolean;
  nerStatus: 'idle' | 'loading' | 'ready' | 'unavailable';
  nerProgress: number;
  nerMessage: string;
  nerCandidates: DetectionCandidate[];
  runNerScan: () => void;

  // Shared Audit & Vault staging (volatile session memory only)
  lastAuditReceipt: AuditReceipt | null;
  setLastAuditReceipt: (r: AuditReceipt | null) => void;
  stagedVaultPayload: VaultPayload | null;
  setStagedVaultPayload: (p: VaultPayload | null) => void;

  // V2 Cloud & Ephemeral Key Configuration (memory only)
  cloudConfig: CloudConfig;
  setCloudConfig: React.Dispatch<React.SetStateAction<CloudConfig>>;
  ephemeralApiKey: string;
  setEphemeralApiKey: (k: string) => void;

  // UI feedback
  toasts: ToastItem[];
  pushToast: (kind: ToastItem['kind'], message: string) => void;
  dismissToast: (id: string) => void;
  liveAnnouncement: string;
  announce: (msg: string) => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

function makeSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `sess_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

const EMPTY_DETECTION: DetectionResult = {
  revision: 0,
  accepted: [],
  rejected: [],
  uncertain: [],
  durationMs: 0,
  countsByType: {},
  totalAcceptedOccurrences: 0,
  uniqueAcceptedCount: 0,
};

const EMPTY_REDACTION: RedactionOutput = {
  sanitizedText: '',
  transformations: [],
  appliedCount: 0,
  excludedCount: 0,
  pseudonymCount: 0,
  verification: {
    cleanByEnabledChecks: true,
    statusLabel: 'No supported patterns detected by enabled checks',
    findings: [],
    remainingCount: 0,
    excludedCount: 0,
    partialRetainedCount: 0,
    pendingCount: 0,
    checkedAtMs: 0,
  },
  durationMs: 0,
};

export const SessionProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [activeModule, setActiveModule] = useState<AppModuleId>('text');
  const [sessionId, setSessionId] = useState<string>(() => makeSessionId());
  const [sessionRevision, setSessionRevision] = useState<number>(1);
  const [resetCounter, setResetCounter] = useState<number>(0);

  const [textInput, setTextInputRaw] = useState<string>('');
  const [textFilename, setTextFilename] = useState<string>('pasted-note.txt');
  const [textPolicy, setTextPolicy] = useState<RedactionPolicy>(() => createDefaultPolicy('AI_SAFE'));
  const [textDetection, setTextDetection] = useState<DetectionResult>(EMPTY_DETECTION);
  const [textRedaction, setTextRedaction] = useState<RedactionOutput>(EMPTY_REDACTION);
  const [textBusy, setTextBusy] = useState<boolean>(false);

  const [nerStatus, setNerStatus] = useState<'idle' | 'loading' | 'ready' | 'unavailable'>('idle');
  const [nerProgress, setNerProgress] = useState<number>(0);
  const [nerMessage, setNerMessage] = useState<string>('');
  const [nerCandidates, setNerCandidates] = useState<DetectionCandidate[]>([]);

  const [lastAuditReceipt, setLastAuditReceipt] = useState<AuditReceipt | null>(null);
  const [stagedVaultPayload, setStagedVaultPayload] = useState<VaultPayload | null>(null);
  const [cloudConfig, setCloudConfig] = useState<CloudConfig>({
    organizerPermitted: false,
    modelId: 'gemini-flash-lite-latest',
    providerTier: 'unpaid-demo',
    transportMode: 'relay',
  });
  const [ephemeralApiKey, setEphemeralApiKey] = useState<string>('');
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [liveAnnouncement, setLiveAnnouncement] = useState<string>('');

  const textWorkerRef = useRef<Worker | null>(null);
  const nerWorkerRef = useRef<Worker | null>(null);
  const latestTextReqId = useRef<string>('');
  const latestNerReqId = useRef<string>('');
  const sessionIdRef = useRef<string>(sessionId);
  const revisionRef = useRef<number>(sessionRevision);

  useEffect(() => {
    sessionIdRef.current = sessionId;
    revisionRef.current = sessionRevision;
  }, [sessionId, sessionRevision]);

  const pushToast = useCallback((kind: ToastItem['kind'], message: string) => {
    const id = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    setToasts((prev) => [...prev.slice(-3), { id, kind, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4500);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const announce = useCallback((msg: string) => {
    setLiveAnnouncement(msg);
  }, []);

  const setTextInput = useCallback((val: string) => {
    setTextInputRaw(val);
    setSessionRevision((r) => r + 1);
    setNerCandidates([]);
    if (!val) {
      setTextDetection(EMPTY_DETECTION);
      setTextRedaction(EMPTY_REDACTION);
      setTextBusy(false);
    }
    setTextPolicy((prev) => ({
      ...prev,
      entityOverrides: {},
      manualSpans: [],
    }));
  }, []);

  // Initialize Text Worker cleanly
  const ensureTextWorker = useCallback(() => {
    if (textWorkerRef.current) return textWorkerRef.current;
    if (typeof Worker === 'undefined') return null;
    try {
      const worker = new Worker(new URL('../workers/text.worker.ts', import.meta.url), {
        type: 'module',
      });
      worker.onmessage = (ev: MessageEvent) => {
        const msg = ev.data;
        if (!msg || msg.requestId !== latestTextReqId.current) return;
        if (msg.sessionId !== sessionIdRef.current || msg.revision !== revisionRef.current) return;

        setTextBusy(false);
        if (msg.type === 'result') {
          setTextDetection(msg.detection);
          if (msg.redaction) setTextRedaction(msg.redaction);
        } else if (msg.type === 'error') {
          pushToast('error', msg.message || 'Text processing error');
        }
      };
      textWorkerRef.current = worker;
      return worker;
    } catch {
      return null;
    }
  }, [pushToast]);

  // Run text detection & redaction with short debounce on typing, instant reuse on policy switches
  useEffect(() => {
    if (!textInput) {
      return;
    }

    const reqId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    latestTextReqId.current = reqId;

    const timer = setTimeout(() => {
      setTextBusy(true);
      const worker = ensureTextWorker();
      if (worker) {
        worker.postMessage({
          requestId: reqId,
          sessionId: sessionIdRef.current,
          revision: sessionRevision,
          action: 'detectAndRedact',
          text: textInput,
          policy: textPolicy,
          nerCandidates,
        });
      } else {
        // Fallback synchronous execution if Web Workers unavailable
        const det = runDetectionPipeline(textInput, {
          revision: sessionRevision,
          policy: textPolicy,
          nerCandidates,
        });
        const red = applyRedactionPolicy(textInput, det, textPolicy);
        if (latestTextReqId.current === reqId) {
          setTextDetection(det);
          setTextRedaction(red);
          setTextBusy(false);
        }
      }
    }, 120);

    return () => clearTimeout(timer);
  }, [textInput, textPolicy, nerCandidates, sessionRevision, ensureTextWorker]);

  const runNerScan = useCallback(() => {
    if (!textInput.trim()) {
      pushToast('info', 'Enter or load text before scanning with local NER.');
      return;
    }
    if (typeof Worker === 'undefined') {
      setNerStatus('unavailable');
      pushToast('error', 'Web Workers are required for local ONNX NER.');
      return;
    }

    const reqId = `ner_${Date.now()}`;
    latestNerReqId.current = reqId;
    setNerStatus('loading');
    setNerProgress(0.05);
    setNerMessage('Starting local BERT-NER worker...');

    if (!nerWorkerRef.current) {
      const w = new Worker(new URL('../workers/ner.worker.ts', import.meta.url), {
        type: 'module',
      });
      nerWorkerRef.current = w;
    }

    const w = nerWorkerRef.current;
    w.onmessage = (ev: MessageEvent) => {
      const msg = ev.data;
      if (!msg || msg.requestId !== latestNerReqId.current) return;
      if (msg.type === 'progress') {
        setNerStatus('loading');
        setNerProgress(typeof msg.progress === 'number' ? msg.progress : 0.2);
        setNerMessage(msg.message || 'Running local NER...');
      } else if (msg.type === 'result') {
        setNerStatus('ready');
        setNerProgress(1);
        setNerMessage(`Local NER found ${msg.candidates.length} contextual candidate(s).`);
        setNerCandidates(msg.candidates);
        setTextPolicy((prev) => ({ ...prev, enableNer: true }));
        pushToast('success', `Local NER proposed ${msg.candidates.length} contextual entity candidate(s) for review.`);
      } else if (msg.type === 'error') {
        setNerStatus('unavailable');
        setNerMessage(msg.message || 'Local NER failed to load.');
        pushToast('error', `Local NER unavailable: ${msg.message}`);
      }
    };

    w.postMessage({ requestId: reqId, action: 'detect', text: textInput });
  }, [textInput, pushToast]);

  const resetSession = useCallback(() => {
    latestTextReqId.current = '';
    latestNerReqId.current = '';

    if (textWorkerRef.current) {
      textWorkerRef.current.terminate();
      textWorkerRef.current = null;
    }
    if (nerWorkerRef.current) {
      nerWorkerRef.current.terminate();
      nerWorkerRef.current = null;
    }

    setSessionId(makeSessionId());
    setSessionRevision(1);
    setResetCounter((c) => c + 1);
    setTextInputRaw('');
    setTextFilename('pasted-note.txt');
    setTextPolicy(createDefaultPolicy('AI_SAFE'));
    setTextDetection(EMPTY_DETECTION);
    setTextRedaction(EMPTY_REDACTION);
    setTextBusy(false);
    setNerStatus('idle');
    setNerProgress(0);
    setNerMessage('');
    setNerCandidates([]);
    setLastAuditReceipt(null);
    setStagedVaultPayload(null);
    setEphemeralApiKey('');
    sharedOutboundFirewall.clearAll();
    sharedGemmaReasoner.dispose().catch(() => {});

    announce('Session reset. All volatile document state, workers, and mappings cleared.');
    pushToast('info', 'Session cleared. Note: JavaScript cannot guarantee physical RAM erasure.');
  }, [announce, pushToast]);

  useEffect(() => {
    return () => {
      textWorkerRef.current?.terminate();
      nerWorkerRef.current?.terminate();
    };
  }, []);

  const value = useMemo<SessionContextValue>(
    () => ({
      activeModule,
      setActiveModule,
      sessionId,
      sessionRevision,
      resetCounter,
      resetSession,
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
      nerCandidates,
      runNerScan,
      lastAuditReceipt,
      setLastAuditReceipt,
      stagedVaultPayload,
      setStagedVaultPayload,
      cloudConfig,
      setCloudConfig,
      ephemeralApiKey,
      setEphemeralApiKey,
      toasts,
      pushToast,
      dismissToast,
      liveAnnouncement,
      announce,
    }),
    [
      activeModule,
      sessionId,
      sessionRevision,
      resetCounter,
      resetSession,
      textInput,
      setTextInput,
      textFilename,
      textPolicy,
      textDetection,
      textRedaction,
      textBusy,
      nerStatus,
      nerProgress,
      nerMessage,
      nerCandidates,
      runNerScan,
      lastAuditReceipt,
      stagedVaultPayload,
      cloudConfig,
      ephemeralApiKey,
      toasts,
      pushToast,
      dismissToast,
      liveAnnouncement,
      announce,
    ],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
};

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside SessionProvider');
  return ctx;
}
