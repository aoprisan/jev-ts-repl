/*
 * Offline is the point, so the shell is precached whole: the page, the styles, the app modules and
 * every module of `jev-repl/core` behind them. The build stamps the list and the version in.
 *
 * Only same-origin GETs are touched. API calls carry a key and their answers are nobody's to keep,
 * so they are never seen by this worker, let alone stored.
 */

const VERSION = "__VERSION__";
const CACHE = `jev-${VERSION}`;
const ASSETS = __PRECACHE__;

self.addEventListener("install", (event) => {
  // Straight from the network: the host may still be handing out the last deploy's copies for a
  // few more minutes, and a precache is only worth having if it holds what was just published.
  const fresh = ASSETS.map((url) => new Request(url, { cache: "reload" }));
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(fresh))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // A shared link is a fragment on the same page, so any navigation resolves to the shell.
  if (request.mode === "navigate") {
    event.respondWith(
      caches
        .match("./index.html")
        .then((hit) => hit ?? fetch(request).catch(() => caches.match("./"))),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit) return hit;
      return fetch(request)
        .then((response) => {
          if (response.ok && response.type === "basic") {
            const copy = response.clone();
            void caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => hit ?? Response.error());
    }),
  );
});
