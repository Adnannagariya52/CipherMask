import { chunkTextUnicodeSafe } from '../engine/ner/chunking.ts';
import { buildSemanticDetectionPrompt } from './prompts.ts';
import { extractAndValidateJson, SemanticDetectionResponseSchema } from './schemas.ts';
import { groundSemanticFindings, type GroundedAiFinding } from './grounding.ts';
import type { LocalReasoner } from './localReasoner.ts';

export interface SemanticDetectionRunResult {
  grounded: GroundedAiFinding[];
  ungroundedCount: number;
  chunksScanned: number;
  totalChunks: number;
  incomplete: boolean;
  incompleteReasons: string[];
  elapsedMs: number;
}

export async function runGemmaSemanticDetection(
  reasoner: LocalReasoner,
  text: string,
  sourceId: string,
  sourceRevision: number,
  options?: {
    maxChunks?: number;
    chunkSize?: number;
    signal?: AbortSignal;
    onProgress?: (done: number, total: number) => void;
  },
): Promise<SemanticDetectionRunResult> {
  const t0 = performance.now();
  const maxChunks = options?.maxChunks ?? 8;
  const chunkSize = options?.chunkSize ?? 1200;

  if (!text.trim()) {
    return {
      grounded: [],
      ungroundedCount: 0,
      chunksScanned: 0,
      totalChunks: 0,
      incomplete: false,
      incompleteReasons: [],
      elapsedMs: 0,
    };
  }

  const chunks = chunkTextUnicodeSafe(text, chunkSize, 120);
  const cappedChunks = chunks.slice(0, maxChunks);
  const incompleteReasons: string[] = [];
  if (chunks.length > maxChunks) {
    incompleteReasons.push(
      `Document required ${chunks.length} chunks; bounded semantic scan capped at ${maxChunks} chunks.`,
    );
  }

  const allGrounded: GroundedAiFinding[] = [];
  let ungroundedCount = 0;
  let chunksScanned = 0;

  for (let i = 0; i < cappedChunks.length; i += 1) {
    if (options?.signal?.aborted) {
      incompleteReasons.push('Semantic detection cancelled by user.');
      break;
    }

    const ch = cappedChunks[i];
    const chunkId = `c${ch.index + 1}`;
    const prompt = buildSemanticDetectionPrompt(chunkId, ch.text);

    let res = await reasoner.run(
      { jobId: `sem_${sourceId}_${chunkId}_${Date.now()}`, task: 'semantic_detect', prompt, maxOutputTokens: 512 },
      { signal: options?.signal },
    );

    if (res.status === 'cancelled') {
      incompleteReasons.push('Semantic detection cancelled.');
      break;
    }
    if (res.status === 'error') {
      incompleteReasons.push(`Chunk ${chunkId} inference failed: ${res.errorMessage || 'error'}`);
      continue;
    }

    let validated = extractAndValidateJson(res.text, SemanticDetectionResponseSchema);
    if (!validated.ok) {
      // Single bounded schema correction retry
      const retryPrompt = buildSemanticDetectionPrompt(chunkId, ch.text.slice(0, 800));
      res = await reasoner.run(
        { jobId: `sem_retry_${sourceId}_${chunkId}_${Date.now()}`, task: 'semantic_detect', prompt: retryPrompt, maxOutputTokens: 512 },
        { signal: options?.signal },
      );
      if (res.status === 'completed') {
        validated = extractAndValidateJson(res.text, SemanticDetectionResponseSchema);
      }
    }

    if (!validated.ok || !validated.data) {
      incompleteReasons.push(`Chunk ${chunkId} returned invalid schema (${validated.error}).`);
      continue;
    }

    if (validated.data.chunkId !== chunkId) {
      incompleteReasons.push(`Chunk ${chunkId} returned mismatched chunkId '${validated.data.chunkId}'.`);
      continue;
    }

    if (validated.data.truncated) {
      incompleteReasons.push(`Chunk ${chunkId} marked findings as truncated by model budget.`);
    }

    const groundedOutcome = groundSemanticFindings(ch.text, ch.start, sourceId, sourceRevision, validated.data);
    allGrounded.push(...groundedOutcome.grounded);
    ungroundedCount += groundedOutcome.ungroundedQuotes.length;
    chunksScanned += 1;
    options?.onProgress?.(i + 1, cappedChunks.length);
  }

  return {
    grounded: allGrounded,
    ungroundedCount,
    chunksScanned,
    totalChunks: chunks.length,
    incomplete: incompleteReasons.length > 0,
    incompleteReasons,
    elapsedMs: Math.round(performance.now() - t0),
  };
}
