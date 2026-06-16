/* David's Closet — service worker (Drop 5: cloud/phone).
 *
 * Works under BOTH serving roots:
 *   - local Mac/LAN:   scope '/'
 *   - cloud (Supabase Storage): scope '/storage/v1/object/public/closet/'
 * All shell paths are RELATIVE so precache resolves against the actual scope.
 *
 * Strategy:
 *   - App shell + static assets (relative, same-origin): cache-first, precached.
 *   - Navigations: cache-first to 'index.html' (the storage root has no
 *     directory index, so navigations always resolve to the shell).
 *   - Google Fonts: stale-while-revalidate runtime cache.
 *   - API + data (local '/api/', '/data/' and cloud '/functions/v1/closet-api/'):
 *     NETWORK ONLY — never cached. On network failure, weather/insights/trips
 *     get a synthetic {ok:false, offline:true} so the UI degrades gracefully.
 *   - Supabase auth/rest endpoints: untouched (never intercepted, never cached).
 *
 * Bump VERSION on any shell change — activate deletes all older caches.
 */
const VERSION = 'v1.6.0';
const SHELL_CACHE = `closet-shell-${VERSION}`;
const FONT_CACHE = `closet-fonts-${VERSION}`;

const SHELL = [
  'index.html',
  'manifest.webmanifest',
  'static/icon.svg',
  'static/icon-180.png',
  'static/icon-192.png',
  'static/icon-512.png',
  'static/icon-512-maskable.png',
];

const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

// Network-only markers (local + cloud API paths).
const API_MARKERS = ['/api/', '/data/', '/functions/v1/closet-api/'];
// Endpoints whose UIs already handle {ok:false} gracefully (suffix match works
// for both '/api/weather' and '/functions/v1/closet-api/weather').
const OFFLINE_SUFFIX = ['/weather', '/insights', '/trips'];
// Supabase auth/data planes — never intercept.
const PASSTHROUGH_PREFIX = ['/auth/v1', '/rest/v1', '/storage/v1/object/sign'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      // {cache:'reload'} bypasses the HTTP cache so a version bump always
      // precaches the freshly deployed shell, never a heuristically-cached copy.
      .then((cache) => cache.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((k) => k.startsWith('closet-') && k !== SHELL_CACHE && k !== FONT_CACHE)
          .map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

function offlineJson() {
  return new Response(JSON.stringify({ ok: false, offline: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // POST/PUT/DELETE (chat, saves, trips) pass straight through

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  // Live data: network only. Never read from or write to cache.
  if (sameOrigin && API_MARKERS.some((m) => url.pathname.includes(m))) {
    event.respondWith(
      fetch(req).catch(() => {
        if (OFFLINE_SUFFIX.some((s) => url.pathname.endsWith(s))) return offlineJson();
        return new Response(JSON.stringify({ ok: false, offline: true, error: 'offline' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      })
    );
    return;
  }

  // Supabase auth/rest: untouched.
  if (sameOrigin && PASSTHROUGH_PREFIX.some((p) => url.pathname.startsWith(p))) return;

  // Google Fonts: stale-while-revalidate.
  if (FONT_HOSTS.includes(url.hostname)) {
    event.respondWith(
      caches.open(FONT_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        const refresh = fetch(req)
          .then((resp) => {
            if (resp && (resp.ok || resp.type === 'opaque')) cache.put(req, resp.clone());
            return resp;
          })
          .catch(() => cached);
        return cached || refresh;
      })
    );
    return;
  }

  // Navigations: serve the shell (storage has no directory index).
  if (req.mode === 'navigate') {
    event.respondWith(
      caches.open(SHELL_CACHE).then(async (cache) => {
        const cached = await cache.match('index.html');
        if (cached) return cached;
        const resp = await fetch(req);
        return resp;
      })
    );
    return;
  }

  // App shell + static assets within our scope: cache-first with network fill.
  const scopePath = new URL(self.registration.scope).pathname;
  if (sameOrigin && url.pathname.startsWith(scopePath)) {
    event.respondWith(
      caches.open(SHELL_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        if (cached) return cached;
        const resp = await fetch(req);
        if (resp && resp.ok) cache.put(req, resp.clone());
        return resp;
      })
    );
  }
});
