// NOTE: Keep this URL available to retire registrations from earlier releases.
self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      try {
        for (const name of await caches.keys()) {
          if (name.startsWith("kitties-shell-")) {
            await caches.delete(name);
          }
        }
      } finally {
        await self.clients.claim();
        await self.registration.unregister();
      }
    })(),
  );
});
