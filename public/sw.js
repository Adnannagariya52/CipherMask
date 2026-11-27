/* CipherMask Versioned Service Worker
 * Caches ONLY static allowlisted application shell and verified local model assets.
 * Never caches user documents, blob URLs, external origins, or POST payloads.
 */

const MODEL_CACHE_NAME = 'ciphermask-models-v1';
let currentShellCache = 'ciphermask-shell-dev';
let allowlistedShell = new Set(['/']);
let allowlistedModels = new Set();

async function loadManifest() {
  try {
    const res = await fetch('/precache-manifest.json', { cache: 'no-store' });
    if (!res.ok) return null;
    const manifest = await res.json();
    if (manifest && typeof manifest.version === 'string') {
      currentShellCache = `ciphermask-shell-${manifest.version}`;
      allowlistedShell = new Set(Array.isArray(manifest.shellAssets) ? manifest.shellAssets : ['/']);
      allowlistedModels = new Set(Array.isArray(manifest.modelAssets) ? manifest.modelAssets : []);
    }
    return manifest;
  } catch {
    return null;
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const manifest = await loadManifest();
      if (!manifest) return;
      const cache = await caches.open(currentShellCache);
      for (const assetPath of allowlistedShell) {
        try {
          const req = new Request(assetPath, { cache: 'reload' });
          const resp = await fetch(req);
          if (resp.ok) {
            await cache.put(assetPath, resp);
          }
        } catch {
          // Non-fatal in dev or partial offline install; verified via status check
        }
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      await loadManifest();
      const keys = await caches.keys();
      await Promise.all(
        keys.map((key) => {
          if (key.startsWith('ciphermask-shell-') && key !== currentShellCache) {
            return caches.delete(key);
          }
          return Promise.resolve(false);
        }),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  const pathname = url.pathname;

  // Navigation requests fall back to cached / or /index.html when offline
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        await loadManifestIfEmpty();
        const cache = await caches.open(currentShellCache);
        const cached = (await cache.match('/index.html')) || (await cache.match('/'));
        try {
          const networkResp = await fetch(request);
          return networkResp;
        } catch {
          if (cached) return cached;
          return new Response('Offline and application shell is not cached.', {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          });
        }
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      await loadManifestIfEmpty();
      const isShell = allowlistedShell.has(pathname);
      const isModel = allowlistedModels.has(pathname) || pathname.startsWith('/assets/ocr/') || pathname.startsWith('/assets/vision/') || pathname.startsWith('/assets/ner/');

      if (isShell) {
        const cache = await caches.open(currentShellCache);
        const cached = await cache.match(pathname);
        if (cached) return cached;
        const resp = await fetch(request);
        if (resp.ok) {
          await cache.put(pathname, resp.clone());
        }
        return resp;
      }

      if (isModel) {
        const modelCache = await caches.open(MODEL_CACHE_NAME);
        const cached = await modelCache.match(pathname);
        if (cached) return cached;
        const resp = await fetch(request);
        if (resp.ok) {
          await modelCache.put(pathname, resp.clone());
        }
        return resp;
      }

      // Not allowlisted for caching; pass straight to same-origin network without caching
      return fetch(request);
    })(),
  );
});

let manifestLoaded = false;
async function loadManifestIfEmpty() {
  if (manifestLoaded) return;
  const m = await loadManifest();
  if (m) manifestLoaded = true;
}

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;

  if (data.type === 'PRECACHE_MODELS') {
    const port = event.ports && event.ports[0];
    event.waitUntil(
      (async () => {
        const manifest = await loadManifest();
        const modelCache = await caches.open(MODEL_CACHE_NAME);
        const targets = manifest && Array.isArray(manifest.modelAssets) ? manifest.modelAssets : [];
        const filterPrefix = typeof data.prefix === 'string' ? data.prefix : '';
        const selected = filterPrefix ? targets.filter((p) => p.startsWith(filterPrefix)) : targets;

        let done = 0;
        const failed = [];
        for (const assetPath of selected) {
          try {
            const existing = await modelCache.match(assetPath);
            if (!existing) {
              const resp = await fetch(assetPath, { cache: 'reload' });
              if (!resp.ok) {
                failed.push({ path: assetPath, status: resp.status });
              } else {
                await modelCache.put(assetPath, resp);
              }
            }
          } catch (err) {
            failed.push({ path: assetPath, error: String(err) });
          }
          done += 1;
          if (port) {
            port.postMessage({ type: 'PROGRESS', done, total: selected.length, current: assetPath });
          }
        }
        if (port) {
          port.postMessage({ type: 'COMPLETE', done, total: selected.length, failed });
        }
      })(),
    );
  } else if (data.type === 'CHECK_OFFLINE_STATUS') {
    const port = event.ports && event.ports[0];
    event.waitUntil(
      (async () => {
        const manifest = await loadManifest();
        const shellCache = await caches.open(currentShellCache);
        const modelCache = await caches.open(MODEL_CACHE_NAME);
        const shellKeys = new Set((await shellCache.keys()).map((r) => new URL(r.url).pathname));
        const modelKeys = new Set((await modelCache.keys()).map((r) => new URL(r.url).pathname));

        const shellAssets = manifest?.shellAssets ?? [];
        const modelAssets = manifest?.modelAssets ?? [];

        const shellReady = shellAssets.length > 0 && shellAssets.every((p) => shellKeys.has(p));
        const checkGroup = (prefix) => {
          const group = modelAssets.filter((p) => p.startsWith(prefix));
          return {
            total: group.length,
            cached: group.filter((p) => modelKeys.has(p)).length,
            ready: group.length > 0 && group.every((p) => modelKeys.has(p)),
          };
        };

        if (port) {
          port.postMessage({
            type: 'STATUS',
            version: manifest?.version ?? 'dev',
            shellReady,
            shellTotal: shellAssets.length,
            shellCached: shellAssets.filter((p) => shellKeys.has(p)).length,
            ocr: checkGroup('/assets/ocr/'),
            vision: checkGroup('/assets/vision/'),
            ner: checkGroup('/assets/ner/'),
          });
        }
      })(),
    );
  }
});
