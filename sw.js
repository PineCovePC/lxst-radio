const CACHE = "lxst-radio-v6";
const PRECACHE = ["index.html", "manifest.webmanifest", "styles.css?v=6", "app.js?v=6", "favicon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) =>
        Promise.all(PRECACHE.map((u) => c.add(u).catch(() => {}))),
      )
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  const isDoc =
    event.request.mode === "navigate" ||
    url.pathname.endsWith(".html") ||
    url.pathname.endsWith("/") ||
    url.pathname.endsWith("/lxst-radio");
  event.respondWith(
    (async () => {
      try {
        const net = await fetch(event.request);
        if (net.ok && url.origin === self.location.origin) {
          const copy = net.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy));
        }
        return net;
      } catch {
        const hit = await caches.match(event.request);
        if (hit) return hit;
        if (isDoc) return caches.match("index.html");
        throw new Error("offline");
      }
    })(),
  );
});
