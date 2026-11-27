import { applyRedactionPolicy, runDetectionPipeline } from '../engine/pipeline.ts';
import type { DetectionCandidate, RedactionPolicy } from '../engine/types.ts';

interface TextWorkerRequest {
  requestId: string;
  sessionId: string;
  revision: number;
  action: 'detect' | 'redact' | 'detectAndRedact';
  text: string;
  policy: RedactionPolicy;
  nerCandidates?: DetectionCandidate[];
}

self.addEventListener('message', (event: MessageEvent<TextWorkerRequest>) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;

  try {
    const detection = runDetectionPipeline(msg.text, {
      revision: msg.revision,
      policy: msg.policy,
      nerCandidates: msg.nerCandidates,
    });

    if (msg.action === 'detect') {
      self.postMessage({
        type: 'result',
        requestId: msg.requestId,
        sessionId: msg.sessionId,
        revision: msg.revision,
        detection,
      });
      return;
    }

    const redaction = applyRedactionPolicy(msg.text, detection, msg.policy);
    self.postMessage({
      type: 'result',
      requestId: msg.requestId,
      sessionId: msg.sessionId,
      revision: msg.revision,
      detection,
      redaction,
    });
  } catch (err) {
    self.postMessage({
      type: 'error',
      requestId: msg.requestId,
      sessionId: msg.sessionId,
      revision: msg.revision,
      message: err instanceof Error ? err.message : String(err),
    });
  }
});
