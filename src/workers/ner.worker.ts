import { env, pipeline } from '@huggingface/transformers';
import { aggregateNerTokensToCandidates, chunkTextUnicodeSafe, mergeChunkNerCandidates, type NerTokenOutput } from '../engine/ner/adapter.ts';
import type { DetectionCandidate } from '../engine/types.ts';

type TokenClassifier = (text: string, options?: Record<string, unknown>) => Promise<NerTokenOutput[]>;

let classifierPromise: Promise<TokenClassifier> | null = null;
let loadedClassifier: TokenClassifier | null = null;

function configureLocalOnlyTransformersEnv() {
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = '/assets/ner/models/';
  env.useBrowserCache = false;
  env.useWasmCache = false;
  if (env.backends?.onnx?.wasm) {
    env.backends.onnx.wasm.wasmPaths = {
      mjs: '/assets/ner/wasm/ort-wasm-simd-threaded.asyncify.mjs',
      wasm: '/assets/ner/wasm/ort-wasm-simd-threaded.asyncify.wasm',
    };
  }
}

async function ensureModelLoaded(requestId: string): Promise<TokenClassifier> {
  if (loadedClassifier) return loadedClassifier;
  if (!classifierPromise) {
    configureLocalOnlyTransformersEnv();
    self.postMessage({ type: 'progress', requestId, status: 'loading_model', progress: 0.05, message: 'Loading local Xenova/bert-base-NER ONNX weights...' });
    classifierPromise = pipeline('token-classification', 'Xenova/bert-base-NER', {
      device: 'wasm',
      dtype: 'q8',
      local_files_only: true,
      progress_callback: (info: { status?: string; file?: string; progress?: number }) => {
        self.postMessage({
          type: 'progress',
          requestId,
          status: info.status || 'loading',
          progress: typeof info.progress === 'number' ? info.progress / 100 : 0.3,
          message: info.file ? `Loading ${info.file}` : 'Initializing local ONNX NER...',
        });
      },
    }) as Promise<TokenClassifier>;
  }
  loadedClassifier = await classifierPromise;
  return loadedClassifier;
}

self.addEventListener('message', async (event: MessageEvent) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;

  const { requestId, action, text } = msg as { requestId: string; action: string; text?: string };

  if (action === 'warmup') {
    try {
      await ensureModelLoaded(requestId);
      self.postMessage({ type: 'ready', requestId });
    } catch (err) {
      classifierPromise = null;
      loadedClassifier = null;
      self.postMessage({ type: 'error', requestId, message: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  if (action === 'detect') {
    try {
      const clf = await ensureModelLoaded(requestId);
      const input = typeof text === 'string' ? text : '';
      const chunks = chunkTextUnicodeSafe(input, 1100, 150);
      const all: DetectionCandidate[] = [];

      for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i];
        self.postMessage({
          type: 'progress',
          requestId,
          status: 'inferring',
          progress: (i + 1) / Math.max(1, chunks.length),
          message: `Running local NER on chunk ${i + 1}/${chunks.length}`,
        });
        const outputs = await clf(chunk.text, { ignore_labels: ['O'] });
        const mapped = aggregateNerTokensToCandidates(chunk.text, chunk.start, outputs, 0.65);
        all.push(...mapped);
      }

      const merged = mergeChunkNerCandidates(all);
      self.postMessage({ type: 'result', requestId, candidates: merged });
    } catch (err) {
      self.postMessage({ type: 'error', requestId, message: err instanceof Error ? err.message : String(err) });
    }
  }
});
