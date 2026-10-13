// The smallest service worker that makes the portal installable on a phone,
// so Android's Share menu can send an Instagram profile to "Creator Growth".
// It caches nothing: every page comes from the server, as before.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
