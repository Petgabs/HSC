/* ---------------------------------------------------------------------------
 * School Cloud service worker — resilient offline delivery.
 *
 * The public library is hosted on a CDN-backed static site, so every visitor
 * gets their own download connection. This worker keeps the page responsive
 * when the network is slow, avoids duplicate requests for the same file, and
 * bounds the download cache so a busy school cannot exhaust device storage.
 *
 * Strategies:
 *   App shell                 -> stale-while-revalidate
 *   Library manifests/data    -> network-first, canonical cache key
 *   Published downloads       -> bounded cache-first with request coalescing
 *   Counters, GitHub API and  -> network only
 *   Legacy review data         -> network only
 * ------------------------------------------------------------------------- */

const VERSION = 'v1.11.0';
const SHELL_CACHE = `schoolcloud-shell-${VERSION}`;
const DATA_CACHE = `schoolcloud-data-${VERSION}`;
const FILE_CACHE = `schoolcloud-files-${VERSION}`;
const NETWORK_TIMEOUT_MS = 12_000;
const MAX_CACHED_FILE_BYTES = 20 * 1024 * 1024;
const MAX_CACHED_FILES = 40;

// One in-flight fetch per URL means two cards/tabs asking for the same file at
// once share one network response instead of doubling bandwidth and memory.
const inFlight = new Map();

const SHELL_ASSETS = [
  './',
  './index.html',
  './offline.html',
  './sw.js',
  './assets/css/app.css',
  './assets/js/app.js',
  './assets/js/register-sw.js',
  './assets/js/config.js',
  './assets/js/lib/metadata.js',
  './assets/js/lib/search.js',
  './assets/js/lib/counters.js',
  './assets/js/lib/format.js',
  './assets/js/lib/preview.js',
  './assets/js/lib/githubPublish.js',
  './assets/vendor/alpine.esm.js',
  './assets/vendor/lucide.min.js',
  './assets/vendor/libsodium-wrappers.mjs',
  './assets/vendor/libsodium.mjs'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // One missing optional asset must never leave the whole shell empty.
    await Promise.all(SHELL_ASSETS.map(async asset => {
      try {
        await cache.add(new Request(asset, { cache: 'reload' }));
      } catch (error) {
        console.warn('[sw] could not precache', asset, error);
      }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, DATA_CACHE, FILE_CACHE]);
    const names = await caches.keys();
    await Promise.all(names.map(name => (keep.has(name) ? null : caches.delete(name))));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

function isLibraryData(url) {
  return url.pathname.endsWith('/apps.json') ||
    url.pathname.endsWith('/library.json') ||
    url.pathname.endsWith('/stats/downloads.json');
}

function isDownloadableFile(url) {
  return /\/apps\/.+\.(?:html?|pdf|docx?|xlsx?|pptx?)$/i.test(url.pathname);
}

/** Remove cache-busting query strings from data cache keys. */
function cacheRequest(request, canonicalData = false) {
  if (!canonicalData) return request;
  const url = new URL(request.url);
  url.search = '';
  return new Request(url.href, { method: 'GET', headers: request.headers });
}

async function fetchWithTimeout(request) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);
  try {
    return await fetch(request, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function sharedFetch(request) {
  const key = request.url;
  if (inFlight.has(key)) return inFlight.get(key);
  const promise = fetchWithTimeout(request).finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

async function trimFileCache(cache) {
  const requests = await cache.keys();
  if (requests.length <= MAX_CACHED_FILES) return;
  // Cache.keys() is insertion ordered in browsers. Removing the oldest
  // entries keeps storage bounded without affecting the active response.
  await Promise.all(requests.slice(0, requests.length - MAX_CACHED_FILES).map(request => cache.delete(request)));
}

async function cacheFileIfSmall(cache, request, response) {
  const length = Number(response.headers.get('content-length'));
  // If the server does not provide a trustworthy size, do not risk putting a
  // very large file in a device cache. The download still succeeds normally.
  if (!Number.isFinite(length) || length < 0 || length > MAX_CACHED_FILE_BYTES) return;
  await cache.put(request, response.clone());
  await trimFileCache(cache);
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = sharedFetch(request)
    .then(response => {
      if (response?.ok) return cache.put(request, response.clone()).then(() => response);
      return response;
    })
    .catch(() => null);
  const response = cached || (await network);
  return response?.clone?.() || response || Response.error();
}

async function networkFirst(request, cacheName, canonicalData = false) {
  const cache = await caches.open(cacheName);
  const key = cacheRequest(request, canonicalData);
  try {
    const response = await sharedFetch(request);
    if (response?.ok) {
      await cache.put(key, response.clone());
      return response.clone();
    }
    const cached = await cache.match(key);
    return (cached || response)?.clone?.() || cached || response;
  } catch (error) {
    const cached = await cache.match(key);
    if (cached) return cached;
    throw error;
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await sharedFetch(request);
  if (response?.ok) await cacheFileIfSmall(cache, request, response);
  return response?.clone?.() || response;
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never cache counters or GitHub API traffic. Plaintext access tokens are
  // never read from or written to repository files, and GitHub Actions secret
  // traffic is network-only as well.
  if (url.hostname.includes('abacus') || url.hostname === 'api.github.com') return;

  // Cross-origin requests (including the Office viewer) go straight to the
  // network. The service worker can only safely manage first-party assets.
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await networkFirst(request, SHELL_CACHE);
      } catch {
        const cache = await caches.open(SHELL_CACHE);
        return (await cache.match('./index.html')) ||
          (await cache.match('./offline.html')) || Response.error();
      }
    })());
    return;
  }

  if (isLibraryData(url)) {
    event.respondWith(networkFirst(request, DATA_CACHE, true).catch(async () => {
      const cache = await caches.open(DATA_CACHE);
      return (await cache.match(cacheRequest(request, true))) ||
        new Response('[]', { headers: { 'Content-Type': 'application/json' } });
    }));
    return;
  }

  if (isDownloadableFile(url)) {
    event.respondWith(cacheFirst(request, FILE_CACHE).catch(() => Response.error()));
    return;
  }

  event.respondWith(staleWhileRevalidate(request, SHELL_CACHE));
});
