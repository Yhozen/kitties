const CACHE = "kitties-shell-v2";
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(["/offline.html", "/icon-192.png"])),
  );
  self.skipWaiting();
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/v1/") ||
    url.pathname.startsWith("/guest/") ||
    url.pathname.startsWith("/hooks/")
  )
    return;
  if (event.request.mode === "navigate")
    event.respondWith(
      (async () => {
        const offline = async () => {
          const cached = await caches.match("/offline.html", { ignoreVary: true });
          return new Response(cached ? await cached.text() : "Sin conexión", {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        };
        if (!self.navigator.onLine) return offline();
        try {
          return await fetch(event.request);
        } catch {
          return offline();
        }
      })(),
    );
});
