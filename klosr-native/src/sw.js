// Klosr PWA Service Worker — minimal, just enough to satisfy PWA install
// criteria (Chrome requires an active SW + manifest for the install prompt).
//
// We intentionally do NOT cache anything aggressive because this is a live
// app that hits /api/intel for every action. Caching HTML/JS would cause
// stale-code issues when we deploy. Keep it simple.

const VERSION = "klosr-pwa-v1";

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Pass-through fetch handler. Network-first; no offline mode yet.
self.addEventListener("fetch", (event) => {
  // Let the browser handle everything normally. We're online-only for v1.
  return;
});
