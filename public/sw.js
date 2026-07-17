const CACHE_PREFIXES = ["castingcompass-", "castcompass-", "contourcast-"];
const CACHE_NAME = "castingcompass-v12";
const PUBLIC_NAVIGATION_PATHS = new Set(["/", "/privacy", "/terms", "/ai-disclosure"]);
const APP_SHELL = [
  "/",
  "/privacy",
  "/terms",
  "/ai-disclosure",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/topography-contours-v2.webp",
  "/data/sites.json",
  "/data/opportunities.json",
  "/data/community-pulse.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.allSettled(APP_SHELL.map((path) => cache.add(path))),
    ),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => CACHE_PREFIXES.some((prefix) => key.startsWith(prefix)) && key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);

  if (url.pathname.startsWith("/api/")) {
    event.respondWith(fetch(event.request));
    return;
  }

  if (url.pathname.startsWith("/data/")) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (cacheableResponse(response)) {
            const clone = response.clone();
            event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone)));
          }
          return response;
        })
        .catch(() => caches.match(event.request)),
    );
    return;
  }

  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (PUBLIC_NAVIGATION_PATHS.has(url.pathname) && cacheableResponse(response)) {
            const clone = response.clone();
            event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(url.pathname, clone)));
          }
          return response;
        })
        .catch(async () => (await caches.match(url.pathname)) || caches.match("/")),
    );
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(event.request).then((cached) =>
        cached || fetch(event.request).then((response) => {
          if (cacheableResponse(response)) {
            const clone = response.clone();
            event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone)));
          }
          return response;
        }),
      ),
    );
  }
});

function cacheableResponse(response) {
  const cacheControl = response.headers.get("Cache-Control")?.toLowerCase() ?? "";
  return response.ok && !cacheControl.includes("no-store") && !cacheControl.includes("private");
}
