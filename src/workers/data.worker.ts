import { optimizeGeneralizationPolicy, type ColumnOptimizerConfig } from '../engine/csv/optimizer.ts';

interface DataWorkerRequest {
  requestId: string;
  revision: number;
  action: 'optimize' | 'cancel';
  dataRows?: string[][];
  configs?: ColumnOptimizerConfig[];
  targetK?: number;
  sensitiveColumnIndex?: number | null;
  searchBudget?: number;
}

const cancelledIds = new Set<string>();

self.addEventListener('message', (event: MessageEvent<DataWorkerRequest>) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;

  if (msg.action === 'cancel') {
    cancelledIds.add(msg.requestId);
    return;
  }

  if (msg.action === 'optimize') {
    try {
      const result = optimizeGeneralizationPolicy({
        dataRows: msg.dataRows || [],
        configs: msg.configs || [],
        targetK: msg.targetK || 2,
        sensitiveColumnIndex: msg.sensitiveColumnIndex ?? null,
        searchBudget: msg.searchBudget ?? 600,
        shouldCancel: () => cancelledIds.has(msg.requestId),
      });
      cancelledIds.delete(msg.requestId);
      self.postMessage({
        type: 'result',
        requestId: msg.requestId,
        revision: msg.revision,
        result,
      });
    } catch (err) {
      self.postMessage({
        type: 'error',
        requestId: msg.requestId,
        revision: msg.revision,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
});
