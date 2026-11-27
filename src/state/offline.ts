export interface OfflineFeatureStatus {
  total: number;
  cached: number;
  ready: boolean;
}

export interface OfflineStatusReport {
  swSupported: boolean;
  swControlled: boolean;
  version: string;
  shellReady: boolean;
  shellTotal: number;
  shellCached: number;
  ocr: OfflineFeatureStatus;
  vision: OfflineFeatureStatus;
  ner: OfflineFeatureStatus;
  storageUsageBytes?: number;
  storageQuotaBytes?: number;
  manifestLoaded: boolean;
}

export interface AssetManifestSummary {
  ocrCount: number;
  visionCount: number;
  nerCount: number;
  ocrBytes: number;
  visionBytes: number;
  nerBytes: number;
  unavailableCount: number;
}

export async function registerCipherMaskServiceWorker(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return false;
  }
  try {
    await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    return true;
  } catch {
    return false;
  }
}

export async function fetchLocalAssetManifestSummary(): Promise<AssetManifestSummary | null> {
  try {
    const res = await fetch('/assets/manifest.json', { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    const assets = Array.isArray(data.assets) ? data.assets : [];
    const summary: AssetManifestSummary = {
      ocrCount: 0,
      visionCount: 0,
      nerCount: 0,
      ocrBytes: 0,
      visionBytes: 0,
      nerBytes: 0,
      unavailableCount: 0,
    };
    for (const a of assets) {
      if (a.status !== 'ready') {
        summary.unavailableCount += 1;
        continue;
      }
      if (a.feature === 'ocr') {
        summary.ocrCount += 1;
        summary.ocrBytes += a.size || 0;
      } else if (a.feature === 'vision') {
        summary.visionCount += 1;
        summary.visionBytes += a.size || 0;
      } else if (a.feature === 'ner') {
        summary.nerCount += 1;
        summary.nerBytes += a.size || 0;
      }
    }
    return summary;
  } catch {
    return null;
  }
}

async function queryServiceWorker<T>(message: Record<string, unknown>, onProgress?: (p: { done: number; total: number; current: string }) => void): Promise<T | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  const reg = await navigator.serviceWorker.getRegistration('/');
  const worker = navigator.serviceWorker.controller || reg?.active;
  if (!worker) return null;

  return new Promise<T | null>((resolve) => {
    const channel = new MessageChannel();
    const timeout = setTimeout(() => resolve(null), 120_000);
    channel.port1.onmessage = (ev) => {
      const payload = ev.data;
      if (payload?.type === 'PROGRESS' && onProgress) {
        onProgress({ done: payload.done, total: payload.total, current: payload.current });
      } else {
        clearTimeout(timeout);
        resolve(payload as T);
      }
    };
    worker.postMessage(message, [channel.port2]);
  });
}

export async function checkOfflineStatus(): Promise<OfflineStatusReport> {
  const swSupported = typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
  let storageUsageBytes: number | undefined;
  let storageQuotaBytes: number | undefined;
  if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
    try {
      const est = await navigator.storage.estimate();
      storageUsageBytes = est.usage;
      storageQuotaBytes = est.quota;
    } catch {
      // ignore
    }
  }

  const swControlled = swSupported && Boolean(navigator.serviceWorker.controller);
  const swStatus = await queryServiceWorker<{
    type: string;
    version: string;
    shellReady: boolean;
    shellTotal: number;
    shellCached: number;
    ocr: OfflineFeatureStatus;
    vision: OfflineFeatureStatus;
    ner: OfflineFeatureStatus;
  }>({ type: 'CHECK_OFFLINE_STATUS' });

  if (!swStatus) {
    return {
      swSupported,
      swControlled,
      version: 'dev-or-unregistered',
      shellReady: false,
      shellTotal: 0,
      shellCached: 0,
      ocr: { total: 0, cached: 0, ready: false },
      vision: { total: 0, cached: 0, ready: false },
      ner: { total: 0, cached: 0, ready: false },
      storageUsageBytes,
      storageQuotaBytes,
      manifestLoaded: false,
    };
  }

  return {
    swSupported,
    swControlled,
    version: swStatus.version,
    shellReady: swStatus.shellReady,
    shellTotal: swStatus.shellTotal,
    shellCached: swStatus.shellCached,
    ocr: swStatus.ocr,
    vision: swStatus.vision,
    ner: swStatus.ner,
    storageUsageBytes,
    storageQuotaBytes,
    manifestLoaded: swStatus.shellTotal > 0,
  };
}

export async function precacheOfflineModels(
  prefix: '' | '/assets/ocr/' | '/assets/vision/' | '/assets/ner/' = '',
  onProgress?: (p: { done: number; total: number; current: string }) => void,
): Promise<{ done: number; total: number; failed: Array<{ path: string; status?: number; error?: string }> } | null> {
  const res = await queryServiceWorker<{
    type: string;
    done: number;
    total: number;
    failed: Array<{ path: string; status?: number; error?: string }>;
  }>({ type: 'PRECACHE_MODELS', prefix }, onProgress);

  if (!res) return null;
  return { done: res.done, total: res.total, failed: res.failed || [] };
}
