import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workerSource = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
const registrationSource = await readFile(
  new URL("../app/register-service-worker.tsx", import.meta.url),
  "utf8",
);

test("service worker publishes a new cache and removes prior ContourCast releases", () => {
  assert.match(workerSource, /CACHE_NAME = "contourcast-v6"/);
  assert.match(workerSource, /key\.startsWith\(CACHE_PREFIX\) && key !== CACHE_NAME/);
  assert.match(workerSource, /caches\.delete\(key\)/);
});

test("live trip APIs bypass the offline response cache", () => {
  assert.match(workerSource, /url\.pathname\.startsWith\("\/api\/"\)/);
  assert.match(workerSource, /event\.respondWith\(fetch\(event\.request\)\)/);
});

test("registration bypasses cached worker scripts and checks for updates", () => {
  assert.match(registrationSource, /updateViaCache: "none"/);
  assert.match(registrationSource, /registration\.update\(\)/);
});

test("controller replacement reloads once without reloading a first install", () => {
  assert.match(registrationSource, /const hadController = navigator\.serviceWorker\.controller !== null/);
  assert.match(registrationSource, /if \(!hadController \|\| hasReloaded\) return/);
  assert.match(registrationSource, /addEventListener\("controllerchange", handleControllerChange\)/);
  assert.match(registrationSource, /hasReloaded = true;\s*window\.location\.reload\(\)/);
});
