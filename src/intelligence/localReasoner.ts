import { FilesetResolver, LlmInference } from '@mediapipe/tasks-genai';
import { formatGemma3TurnPrompt } from './prompts.ts';

export type LocalModelState =
  | 'unavailable'
  | 'needs-assets'
  | 'asset-verified'
  | 'checking'
  | 'loading'
  | 'warming'
  | 'ready'
  | 'busy'
  | 'cancelling'
  | 'error'
  | 'disposed';

export type TaskKind =
  | 'smoke_test'
  | 'semantic_detect'
  | 'privacyscript_compile'
  | 'court_guardian'
  | 'court_advocate'
  | 'court_judge'
  | 'semantic_review'
  | 'csv_column_advisor'
  | 'private_chat';

export interface LocalModelConfig {
  sourceKind: 'same-origin' | 'local-file';
  modelPath?: string;
  localFile?: File;
  maxTokens?: number;
  temperature?: number;
  topK?: number;
  randomSeed?: number;
}

export interface ModelDiagnostics {
  modelId: string;
  artifactName: string;
  runtimePackage: string;
  state: LocalModelState;
  sourceKind: 'same-origin' | 'local-file' | 'none';
  loadDurationMs?: number;
  warmUpDurationMs?: number;
  timeToFirstTokenMs?: number;
  lastInferenceMs?: number;
  outputTokenCount?: number;
  tokensPerSec?: number;
  smokePassed?: boolean;
  smokeOutputPreview?: string;
  smokeSemanticPreview?: string;
  errorMessage?: string;
}

export interface LocalRunRequest {
  jobId: string;
  task: TaskKind;
  prompt: string;
  maxOutputTokens?: number;
}

export interface LocalRunHooks {
  onPartial?: (partialText: string) => void;
  signal?: AbortSignal;
}

export interface LocalResult {
  jobId: string;
  status: 'completed' | 'cancelled' | 'error';
  text: string;
  elapsedMs: number;
  timeToFirstTokenMs?: number;
  outputTokenCount?: number;
  modelId: string;
  errorMessage?: string;
}

export interface LocalReasoner {
  init(options: LocalModelConfig): Promise<ModelDiagnostics>;
  getStatus(): ModelDiagnostics;
  run(request: LocalRunRequest, hooks?: LocalRunHooks): Promise<LocalResult>;
  cancel(jobId: string): void;
  dispose(): Promise<void>;
}

const DEFAULT_MODEL_ID = 'Gemma 3 4B Instruct (INT4 WebGPU)';
const DEFAULT_MODEL_PATH = '/models/gemma3-4b-it-int4-web.task';
const GENAI_WASM_BASE = '/wasm/genai';

function isRealHostedModelResponse(res: Response): boolean {
  if (!res.ok) return false;
  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('text/html') || contentType.includes('application/json')) {
    return false;
  }
  const lenHeader = res.headers.get('content-length');
  if (lenHeader !== null) {
    const parsedLen = Number(lenHeader);
    if (Number.isFinite(parsedLen) && parsedLen < 10_000_000) {
      return false;
    }
  }
  return true;
}

function isLocalhostOrigin(): boolean {
  if (typeof window === 'undefined') return true;
  const host = window.location.hostname;
  return host === 'localhost' || host === '127.0.0.1';
}

function sanitizeErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/[A-Za-z]:\\[^\s'"]+/g, '[local-path]').slice(0, 320);
}

export class MediaPipeGemmaReasoner implements LocalReasoner {
  private llm: LlmInference | null = null;
  private state: LocalModelState = 'needs-assets';
  private sourceKind: 'same-origin' | 'local-file' | 'none' = 'none';
  private artifactName = 'gemma3-4b-it-int4-web.task';
  private loadDurationMs?: number;
  private warmUpDurationMs?: number;
  private timeToFirstTokenMs?: number;
  private lastInferenceMs?: number;
  private outputTokenCount?: number;
  private tokensPerSec?: number;
  private smokePassed?: boolean;
  private smokeOutputPreview?: string;
  private smokeSemanticPreview?: string;
  private errorMessage?: string;
  private activeJobId: string | null = null;
  private cancelledJobs = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  private listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  getStatus(): ModelDiagnostics {
    return {
      modelId: DEFAULT_MODEL_ID,
      artifactName: this.artifactName,
      runtimePackage: '@mediapipe/tasks-genai@0.10.30',
      state: this.state,
      sourceKind: this.sourceKind,
      loadDurationMs: this.loadDurationMs,
      warmUpDurationMs: this.warmUpDurationMs,
      timeToFirstTokenMs: this.timeToFirstTokenMs,
      lastInferenceMs: this.lastInferenceMs,
      outputTokenCount: this.outputTokenCount,
      tokensPerSec: this.tokensPerSec,
      smokePassed: this.smokePassed,
      smokeOutputPreview: this.smokeOutputPreview,
      smokeSemanticPreview: this.smokeSemanticPreview,
      errorMessage: this.errorMessage,
    };
  }

  async checkSameOriginAssetExists(): Promise<boolean> {
    try {
      const res = await fetch('/models/manifest.json', { cache: 'no-store' });
      let manifestStatus: string | undefined;
      if (res.ok) {
        const manifest = await res.json();
        manifestStatus = manifest?.model?.status;
        if (manifestStatus === 'ready') {
          if (this.state === 'needs-assets') {
            this.state = 'asset-verified';
            this.emit();
          }
          return true;
        }
      }
      // On non-localhost hosted builds (e.g., Firebase Hosting SPA), avoid probing missing weights when manifest marks them device-local.
      if (!isLocalhostOrigin() && manifestStatus === 'needs-assets') {
        return false;
      }
      const head = await fetch(DEFAULT_MODEL_PATH, { method: 'HEAD' });
      if (isRealHostedModelResponse(head)) {
        if (this.state === 'needs-assets') {
          this.state = 'asset-verified';
          this.emit();
        }
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  async init(options: LocalModelConfig): Promise<ModelDiagnostics> {
    if (this.state === 'loading' || this.state === 'warming') {
      return this.getStatus();
    }
    await this.dispose();
    this.state = 'loading';
    this.errorMessage = undefined;
    this.smokePassed = undefined;
    this.smokeOutputPreview = undefined;
    this.smokeSemanticPreview = undefined;
    this.sourceKind = options.sourceKind;
    this.artifactName = options.localFile
      ? options.localFile.name.replace(/[^A-Za-z0-9._-]/g, '_')
      : 'gemma3-4b-it-int4-web.task';
    this.emit();

    const t0 = performance.now();
    try {
      if (typeof window !== 'undefined' && !window.isSecureContext) {
        throw new Error('Secure context (localhost or HTTPS) is required for WebGPU.');
      }
      if (typeof navigator === 'undefined' || !('gpu' in navigator)) {
        throw new Error('WebGPU API unavailable in this browser.');
      }

      if (options.sourceKind === 'same-origin') {
        const path = options.modelPath || DEFAULT_MODEL_PATH;
        const head = await fetch(path, { method: 'HEAD' });
        if (!isRealHostedModelResponse(head)) {
          this.state = 'needs-assets';
          this.errorMessage = `Hosted Gemma weights are not bundled at ${path}. Select your local .task file directly from disk.`;
          this.emit();
          return this.getStatus();
        }
      } else if (!options.localFile) {
        this.state = 'needs-assets';
        this.errorMessage = 'No local .task file selected.';
        this.emit();
        return this.getStatus();
      }

      const fileset = await FilesetResolver.forGenAiTasks(GENAI_WASM_BASE);
      const maxTokens = options.maxTokens ?? 1536;
      const temperature = options.temperature ?? 0.1;
      const topK = options.topK ?? 1;
      const randomSeed = options.randomSeed ?? 42;

      if (options.sourceKind === 'local-file' && options.localFile) {
        const reader = options.localFile.stream().getReader();
        this.llm = await LlmInference.createFromOptions(fileset, {
          baseOptions: { modelAssetBuffer: reader },
          maxTokens,
          temperature,
          topK,
          randomSeed,
        });
      } else {
        this.llm = await LlmInference.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: options.modelPath || DEFAULT_MODEL_PATH },
          maxTokens,
          temperature,
          topK,
          randomSeed,
        });
      }

      this.loadDurationMs = Math.round(performance.now() - t0);
      this.state = 'warming';
      this.emit();

      // Smoke Test 1: Deterministic exact phrase generation
      const warmT0 = performance.now();
      const smokePrompt1 = formatGemma3TurnPrompt('Respond with exactly the phrase LOCAL MODEL WORKING.');
      const smokeRes1 = await this.executeSingle({
        jobId: `smoke1_${Date.now()}`,
        task: 'smoke_test',
        prompt: smokePrompt1,
        maxOutputTokens: 64,
      });

      if (smokeRes1.status !== 'completed' || !smokeRes1.text.trim()) {
        throw new Error(smokeRes1.errorMessage || 'Warm-up smoke test 1 failed.');
      }
      this.smokeOutputPreview = smokeRes1.text.trim().slice(0, 160);

      // Smoke Test 2: Semantic PII identification check
      const smokePrompt2 = formatGemma3TurnPrompt(
        'Identify the sensitive information in this sentence in one concise sentence: A fictional employee named Alex Example recently received medical treatment and is experiencing financial difficulties.',
      );
      const smokeRes2 = await this.executeSingle({
        jobId: `smoke2_${Date.now()}`,
        task: 'smoke_test',
        prompt: smokePrompt2,
        maxOutputTokens: 128,
      });

      this.warmUpDurationMs = Math.round(performance.now() - warmT0);
      if (smokeRes2.status === 'completed' && smokeRes2.text.trim()) {
        this.smokeSemanticPreview = smokeRes2.text.trim().slice(0, 240);
      }

      this.smokePassed =
        smokeRes1.text.toUpperCase().includes('LOCAL MODEL WORKING') &&
        Boolean(smokeRes2.status === 'completed' && smokeRes2.text.trim().length > 0);
      this.state = 'ready';
      this.emit();
      return this.getStatus();
    } catch (err) {
      this.state = 'error';
      this.errorMessage = sanitizeErrorMessage(err);
      this.llm = null;
      this.emit();
      return this.getStatus();
    }
  }

  private async executeSingle(request: LocalRunRequest, hooks?: LocalRunHooks): Promise<LocalResult> {
    if (!this.llm) {
      return {
        jobId: request.jobId,
        status: 'error',
        text: '',
        elapsedMs: 0,
        modelId: DEFAULT_MODEL_ID,
        errorMessage: 'Local Gemma model is not loaded.',
      };
    }

    if (hooks?.signal?.aborted || this.cancelledJobs.has(request.jobId)) {
      return {
        jobId: request.jobId,
        status: 'cancelled',
        text: '',
        elapsedMs: 0,
        modelId: DEFAULT_MODEL_ID,
      };
    }

    this.activeJobId = request.jobId;
    if (this.state === 'ready') {
      this.state = 'busy';
      this.emit();
    }

    const t0 = performance.now();
    let ttft: number | undefined;
    let collected = '';
    const onAbort = () => {
      this.cancel(request.jobId);
    };
    hooks?.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      this.llm.clearCancelSignals();
      const resultText = await this.llm.generateResponse(request.prompt, (partial, _done) => {
        if (this.cancelledJobs.has(request.jobId)) return;
        if (ttft === undefined && partial.length > 0) {
          ttft = Math.round(performance.now() - t0);
        }
        collected += partial;
        hooks?.onPartial?.(collected);
      });

      const elapsedMs = Math.round(performance.now() - t0);
      const finalText = resultText || collected;
      this.lastInferenceMs = elapsedMs;
      this.timeToFirstTokenMs = ttft;

      let outTokens: number | undefined;
      try {
        outTokens = this.llm.sizeInTokens(finalText) ?? undefined;
      } catch {
        outTokens = undefined;
      }
      this.outputTokenCount = outTokens;
      this.tokensPerSec =
        outTokens !== undefined && elapsedMs > 0
          ? Number(((outTokens / elapsedMs) * 1000).toFixed(1))
          : undefined;

      if (this.cancelledJobs.has(request.jobId) || hooks?.signal?.aborted) {
        return {
          jobId: request.jobId,
          status: 'cancelled',
          text: '',
          elapsedMs,
          modelId: DEFAULT_MODEL_ID,
        };
      }

      return {
        jobId: request.jobId,
        status: 'completed',
        text: finalText,
        elapsedMs,
        timeToFirstTokenMs: ttft,
        outputTokenCount: outTokens,
        modelId: DEFAULT_MODEL_ID,
      };
    } catch (err) {
      const elapsedMs = Math.round(performance.now() - t0);
      if (this.cancelledJobs.has(request.jobId)) {
        return {
          jobId: request.jobId,
          status: 'cancelled',
          text: '',
          elapsedMs,
          modelId: DEFAULT_MODEL_ID,
        };
      }
      return {
        jobId: request.jobId,
        status: 'error',
        text: '',
        elapsedMs,
        modelId: DEFAULT_MODEL_ID,
        errorMessage: sanitizeErrorMessage(err),
      };
    } finally {
      hooks?.signal?.removeEventListener('abort', onAbort);
      this.activeJobId = null;
      if (this.state === 'busy' || this.state === 'cancelling') {
        this.state = this.llm ? 'ready' : 'disposed';
        this.emit();
      }
    }
  }

  run(request: LocalRunRequest, hooks?: LocalRunHooks): Promise<LocalResult> {
    const taskPromise = this.queue.then(() => this.executeSingle(request, hooks));
    this.queue = taskPromise.then(
      () => undefined,
      () => undefined,
    );
    return taskPromise;
  }

  cancel(jobId: string): void {
    this.cancelledJobs.add(jobId);
    if (this.activeJobId === jobId && this.llm) {
      this.state = 'cancelling';
      this.emit();
      try {
        this.llm.cancelProcessing();
      } catch {
        // ignore if runtime not currently decoding
      }
    }
  }

  sizeInTokens(prompt: string): number | null {
    if (!this.llm || this.state !== 'ready') return null;
    try {
      return this.llm.sizeInTokens(prompt) ?? null;
    } catch {
      return null;
    }
  }

  async dispose(): Promise<void> {
    if (this.activeJobId) {
      this.cancel(this.activeJobId);
    }
    if (this.llm) {
      try {
        this.llm.close();
      } catch {
        // ignore
      }
      this.llm = null;
    }
    this.state = 'disposed';
    this.emit();
  }
}

export const sharedGemmaReasoner = new MediaPipeGemmaReasoner();
