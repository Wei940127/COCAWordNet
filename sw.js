/* COCAWordNet service worker — offline app shell + word data.
   Bump CACHE whenever app files or data.js change, so clients pick up the new version. */
"use strict";

const CACHE = "cocawn-v2";

/* Small app shell. */
const CORE = [
  "./",
  "./index.html",
  "./app.js",
  "./style.css",
  "./d3.min.js",
  "./manifest.webmanifest",
  "./icon.png",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png",
  "./favicon.ico"
];

/* The 7.5 MB word database. Kept separate so a slow/failed copy can never
   abort the install — each URL is fetched independently. */
const DATA = ["./data.js"];

const ALL = CORE.concat(DATA);

self.addEventListener("install", e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    /* Never use addAll(): it is atomic, so one bad URL would cache nothing.
       Fetch each entry on its own and swallow individual failures. */
    await Promise.all(ALL.map(u => c.add(new Request(u, { cache: "reload" })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  let url;
  try { url = new URL(req.url); } catch (_) { return; }

  /* cross-origin (e.g. Youdao pronunciation audio) goes straight to network */
  if (url.origin !== self.location.origin) return;

  /* navigations: network first so updates land, cache as offline fallback */
  if (req.mode === "navigate") {
    e.respondWith((async () => {
      try {
        const r = await fetch(req);
        if (r && r.ok) {
          const cp = r.clone();
          caches.open(CACHE).then(c => c.put("./index.html", cp)).catch(() => {});
        }
        return r;
      } catch (_) {
        const hit = await caches.match("./index.html") || await caches.match("./");
        return hit || new Response("离线且暂无缓存", {
          status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" }
        });
      }
    })());
    return;
  }

  /* static assets + data.js: cache-first, refresh in the background */
  e.respondWith((async () => {
    const hit = await caches.match(req, { ignoreSearch: true });
    if (hit) {
      fetch(req).then(r => {
        if (r && r.ok) {
          const cp = r.clone();
          caches.open(CACHE).then(c => c.put(req, cp)).catch(() => {});
        }
      }).catch(() => {});
      return hit;
    }
    try {
      const r = await fetch(req);
      if (r && r.ok) {
        const cp = r.clone();
        caches.open(CACHE).then(c => c.put(req, cp)).catch(() => {});
      }
      return r;
    } catch (err) {
      return new Response("", { status: 504, statusText: "offline" });
    }
  })());
});
