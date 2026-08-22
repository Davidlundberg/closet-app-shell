/* David's Closet — service worker (Drop 5: cloud/phone).
 *
 * Works under BOTH serving roots:
 *   - local Mac/LAN:   scope '/'
 *   - cloud (Supabase Storage): scope '/storage/v1/object/public/closet/'
 * All shell paths are RELATIVE so precache resolves against the actual scope.
 *
 * Strategy:
 *   - App shell + static assets (relative, same-origin): cache-first, precached.
 *   - Navigations: NETWORK-FIRST to 'index.html' with a cached fallback (the
 *     storage root has no directory index, so navigations resolve to the
 *     shell). Cache-first here pinned the installed PWA to an old build.
 *   - Google Fonts: stale-while-revalidate runtime cache.
 *   - API + data (local '/api/', '/data/' and cloud '/functions/v1/closet-api/'):
 *     NETWORK ONLY — never cached. On network failure, weather/insights/trips
 *     get a synthetic {ok:false, offline:true} so the UI degrades gracefully.
 *   - Supabase auth/rest endpoints: untouched (never intercepted, never cached).
 *
 * Bump VERSION on any shell change — activate deletes all older caches.
 */
// Tracks APP_VERSION (was drifting: v1.8.2 shipped alongside app 1.10.0).
// Navigations are network-first as of v1.11.1, so a deploy now reaches the
// installed PWA on the next launch without depending on this bump. Keep
// bumping it anyway — it is what evicts stale precached static assets.
const VERSION = 'v1.15.0';

// How long a launch waits for the network before falling back to the cached
// shell. Long enough for a normal mobile round-trip, short enough that a dead
// connection doesn't hold the splash screen.
const NAV_NETWORK_TIMEOUT_MS = 3000;
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

  // Navigations: NETWORK-FIRST with a cached fallback (storage has no
  // directory index, so the shell is always keyed as 'index.html').
  //
  // This was cache-first with no revalidation, which meant the cached shell
  // was served unconditionally and forever. The only way a new build could
  // reach the app was a VERSION bump installing a new worker — and iOS only
  // re-fetches sw.js on a real navigation, which a PWA resumed from the app
  // switcher never performs. Net effect: David's phone kept rendering an old
  // shell after a deploy and the app "looked the same". Now a launch with any
  // connectivity always renders the deployed build.
  //
  // The timeout keeps launch instant: if the network hasn't answered by then we
  // serve the cached shell rather than staring at a blank screen. The download
  // is never cancelled, so it still writes through for the next launch.
  if (req.mode === 'navigate') {
    event.respondWith(
      caches.open(SHELL_CACHE).then(async (cache) => {
        const cached = await cache.match('index.html');
        // {cache:'reload'} bypasses the HTTP cache — the shell is served with
        // a max-age, and a stale-but-fresh-enough shell is the same bug.
        // The download is NOT aborted on timeout: the earlier version aborted
        // it, so on any connection consistently slower than the timeout the
        // fetch was cancelled every launch, nothing was ever cached, and the
        // PWA stayed pinned to the old build — the exact symptom this handler
        // exists to fix. Instead we race the response and let the download
        // finish into the cache in the background.
        const network = fetch(new Request('index.html', { cache: 'reload' }))
          .then((resp) => {
            if (resp && resp.ok) {
              // Held open past the response so termination can't cut the write.
              event.waitUntil(
                cache.put('index.html', resp.clone()).catch(() => {})
              );
              return resp;
            }
            return null;
          })
          .catch(() => null);   // offline

        if (!cached) return (await network) || fetch(req);

        const timeout = new Promise((res) => setTimeout(() => res(null), NAV_NETWORK_TIMEOUT_MS));
        const winner = await Promise.race([network, timeout]);
        if (winner) return winner;
        // Slow or offline: serve the cached shell now. `network` is still in
        // flight and still writes through, so the next launch is fresh.
        event.waitUntil(network);
        return cached;
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
