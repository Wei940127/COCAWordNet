/* COCAWordNet service worker — offline app shell + word data.

   Design note (v35): 词库被拆成「骨架 + 10 个词层块 + 词表外词两份」。
   骨架（data_core.js，约 200KB gzip）跟着 shell 一起预缓存，首屏用它就能渲染；
   各词层块由页面按需插 <script> 取用，走下面的 fetch 处理器时会自动写进缓存。
   放 install 里全量预缓存会拖慢激活、慢网下还可能中断 —— 所以一概不预缓存大文件。

   Bump CACHE whenever app files or data files change, so clients pick up the new version. */
"use strict";

const CACHE = "cocawn-v43";

/* Small app shell — must all fit in the install step.
   data_core.js（骨架：词表/词层/下标/别名，约 200KB gzip）是启动必需，放这里预缓存；
   10 个词层块（data_b01..b10）和词表外词那两份由页面按需拉取，
   经过 fetch 处理器时会被自动写进缓存，所以离线只覆盖「看过/预取过」的词层 —— 
   首次进入后页面的预取队列会把 10 块补齐，正常使用一个会话就全了。 */
const SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./style.css",
  "./d3.min.js",
  "./data_core.js",
  "./manifest.webmanifest",
  "./icon.png",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png",
  "./favicon.ico"
];

/* 词层数据块（data_b01..b10 / data_extra.js / data_extra_def.js）不在这里预热：
   页面按需取用，经过下面的 fetch 处理器时自动进缓存，省掉用户没看过的词层的流量。 */
const WARM = [];

/* Fetch a URL and store it, reusing the HTTP cache when possible.
   Never rejects: a failed warm-up must not break anything. */
async function cacheUrl(url) {
  try {
    const c = await caches.open(CACHE);
    if (await c.match(url)) return true;
    const res = await fetch(url, { credentials: "same-origin" });
    if (res && res.ok) await c.put(url, res.clone());
    return true;
  } catch (_) { return false; }
}

self.addEventListener("install", e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    /* Never use addAll(): it is atomic, so one bad URL would cache nothing. */
    await Promise.all(SHELL.map(u => c.add(new Request(u, { cache: "reload" })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
    /* Background warm-up: started but not awaited, so activation is instant. */
    WARM.forEach(u => { cacheUrl(u); });
  })());
});

/* The page asks the new worker to take over immediately so it can reload
   into the fresh version (iPad home-screen apps rarely update on their own). */
self.addEventListener("message", e => {
  if (e.data && e.data.type === "SKIP_WAITING") self.skipWaiting();
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
