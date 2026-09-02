/* ============================================================
   HPF Digital Portal — service worker.

   Scope: the application SHELL only. This deliberately does NOT cache
   Supabase API responses. Two reasons, both learned from what already
   exists in this app:

     1. Serving a stale API response would silently contradict the sync
        states in offline.js — an officer could see a "synced" visit that
        the server has never heard of. Data goes through IndexedDB, where
        it carries an explicit state, or it doesn't get served offline at
        all.
     2. Every Supabase request carries an Authorization header. Caching
        authenticated responses in a shared Cache Storage bucket is how
        one user's data ends up in another's browser on a shared field
        device — exactly the deployment this portal targets.

   So: cache-first for the shell (fast, works offline), network-only for
   everything else, with a navigation fallback so a cold offline reload of
   any SPA route still boots the app. Route handling itself is app.js's
   job — the shell just has to load.
   ============================================================ */

const VERSION = "hpf-shell-v1";
const SHELL = [
  "./",
  "./index.html",
  "./404.html",
  "./styles.css",
  "./app.js",
  "./dashboards.js",
  "./data.js",
  "./util.js",
  "./icons.js",
  "./supabase.js",
  "./recovery.js",
  "./config.js",
  "./offline.js",
  "./manifest.webmanifest",
  "./favicon.ico",
  "./assets/icon-192.png",
  "./assets/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(VERSION);
      // addAll() is all-or-nothing: one 404 (a renamed asset, a partial
      // deploy) would leave the app with no offline shell at all and no
      // clue why. Cache what resolves, and let the rest fall through to
      // the network — a partially warm shell beats none.
      await Promise.all(
        SHELL.map((url) =>
          cache.add(new Request(url, { cache: "reload" })).catch((err) => {
            console.warn("[sw] shell asset skipped:", url, err.message);
          })
        )
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

/* The one message the page sends: "a new build is live, take over now". */
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

const isShellRequest = (url) =>
  url.origin === self.location.origin &&
  SHELL.some((p) => url.pathname === new URL(p, self.registration.scope).pathname);

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return; // never interfere with a write

  const url = new URL(request.url);

  // Anything not our own origin (Supabase, esm.sh) goes straight to the
  // network. esm.sh module fetches are the one cross-origin case that
  // matters offline, and they are already cached by the browser's own HTTP
  // cache with long max-age — duplicating that here would only add a
  // second, staler copy we would then have to invalidate.
  if (url.origin !== self.location.origin) return;

  // SPA navigation: try the network first so a fresh deploy is picked up,
  // fall back to the cached shell so a cold offline load of /field-officer
  // still boots instead of showing the browser's dinosaur.
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          return await fetch(request);
        } catch {
          const cache = await caches.open(VERSION);
          return (
            (await cache.match("./index.html")) ||
            (await cache.match("./")) ||
            new Response("Offline and no cached shell available.", {
              status: 503,
              headers: { "content-type": "text/plain" },
            })
          );
        }
      })()
    );
    return;
  }

  if (!isShellRequest(url)) return;

  // Shell asset: cache-first, then refresh the copy in the background so
  // the next load gets the new build without ever blocking this one.
  event.respondWith(
    (async () => {
      const cache = await caches.open(VERSION);
      const hit = await cache.match(request);
      const network = fetch(request)
        .then((res) => {
          if (res && res.ok) cache.put(request, res.clone());
          return res;
        })
        .catch(() => null);
      return hit || (await network) || new Response("", { status: 504 });
    })()
  );
});
