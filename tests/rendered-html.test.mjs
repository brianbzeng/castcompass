import assert from "node:assert/strict";
import { access, readFile, readdir, stat } from "node:fs/promises";
import test from "node:test";
import { gzipSync } from "node:zlib";

async function render(path = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${path}`, {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the CastingCompass product shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>CastingCompass — California halibut opportunity planner(?: · CastingCompass)?<\/title>/i);
  assert.match(html, /Find the water/);
  assert.match(html, /California halibut/);
  assert.match(html, /Pick the hours you have/);
  assert.match(html, /Work in progress/);
  assert.match(html, /currently hunts for California halibut only/);
  assert.match(html, /It is <strong>not<\/strong> an 80% chance/i);
  assert.match(html, /CDFW Bay regulations/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|SkeletonPreview/i);
});

test("ships install and offline assets", async () => {
  const [manifest, serviceWorker, headerIcon] = await Promise.all([
    readFile(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"),
    readFile(new URL("../public/sw.js", import.meta.url), "utf8"),
    stat(new URL("../public/icons/icon-192.png", import.meta.url)),
    access(new URL("../public/icons/icon-192.png", import.meta.url)),
    access(new URL("../public/icons/icon-512.png", import.meta.url)),
  ]);

  const parsed = JSON.parse(manifest);
  assert.equal(parsed.name, "CastingCompass — Halibut Opportunity Planner");
  assert.equal(parsed.display, "standalone");
  assert.equal(parsed.icons.length, 2);
  assert.match(serviceWorker, /\/data\/opportunities\.json/);
  assert.match(serviceWorker, /\/data\/community-pulse\.json/);
  assert.match(serviceWorker, /\/topography-contours-v2\.webp/);
  assert.match(serviceWorker, /caches\.match/);
  assert.ok(headerIcon.size < 50_000, `header icon is ${headerIcon.size} bytes`);
});

test("avoids third-party font requests and oversized header-icon references", async () => {
  const response = await render();
  const html = await response.text();
  const assetNames = await readdir(new URL("../dist/client/assets/", import.meta.url));
  const builtCss = (
    await Promise.all(
      assetNames
        .filter((name) => name.endsWith(".css"))
        .map((name) => readFile(new URL(`../dist/client/assets/${name}`, import.meta.url), "utf8")),
    )
  ).join("\n");
  const [layout, sourceCss] = await Promise.all([
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(html, /fonts\.(?:googleapis|gstatic)\.com/i);
  assert.doesNotMatch(html, /<link[^>]+rel="preload"[^>]+as="font"/i);
  assert.doesNotMatch(builtCss, /fonts\.(?:googleapis|gstatic)\.com|@font-face/i);
  assert.doesNotMatch(layout, /next\/font\/google|castingcompass-icon\.png/);
  assert.match(layout, /\/icons\/icon-192\.png/);
  assert.match(layout, /\/icons\/icon-512\.png/);
  assert.match(sourceCss, /url\("\/icons\/icon-192\.png"\)/);
  assert.doesNotMatch(sourceCss, /url\("\/castingcompass-icon\.png"\)/);
});

test("keeps the score framed as a relative ranking", async () => {
  const app = await readFile(
    new URL("../app/components/OpportunityApp.tsx", import.meta.url),
    "utf8",
  );
  assert.match(app, /ranks within the current comparison set/);
  assert.match(app, /It is <strong>not<\/strong> an 80% chance/);
  assert.match(app, /Old weather and tide readings are not treated as live/);
  assert.match(app, /research pipeline, not the live score/i);
  assert.match(app, /ten-channel, three-scale bathymetry stack/i);
  assert.match(app, /Full-survey self-supervised pretraining is complete/i);
  assert.match(app, /What anglers have said/);
  assert.match(app, /not a live bite report/i);
  assert.match(app, /\["today", "Today"\]/);
  assert.match(app, /\["custom", "Custom"\]/);
  assert.doesNotMatch(app, /Best next|\["weekend", "Weekend"\]/);
  assert.match(app, /America\/Los_Angeles/);
});

test("filters forecasts to the hours an angler can actually fish", async () => {
  const app = await readFile(
    new URL("../app/components/OpportunityApp.tsx", import.meta.url),
    "utf8",
  );

  assert.match(app, /When can you fish\?/);
  assert.match(app, /The best time to fish is when you have time/);
  assert.match(app, /type="time"/);
  assert.match(app, /availabilityFit/);
  assert.match(app, /within an hour of them/);
  assert.match(app, /Best match for your hours/);
  assert.match(app, /Opportunity through the day/);
  assert.match(app, /Previous fishing window/);
  assert.match(app, /Next fishing window/);
});

test("surfaces the expanded halibut condition set and first-visit stewardship notice", async () => {
  const app = await readFile(
    new URL("../app/components/OpportunityApp.tsx", import.meta.url),
    "utf8",
  );

  assert.match(app, /Cloud cover/);
  assert.match(app, /Pressure/);
  assert.match(app, /Moon/);
  assert.match(app, /Tide cycle/);
  assert.match(app, /Respect the water/);
  assert.match(app, /Do not show this reminder again/);
  assert.match(app, /Install app — coming soon/);
  assert.doesNotMatch(app, /What does the score mean\?/);
});

test("turns site structure tags into angler-facing water-reading cues", async () => {
  const app = await readFile(
    new URL("../app/components/OpportunityApp.tsx", import.meta.url),
    "utf8",
  );

  assert.match(app, /Structure to look for/);
  assert.match(app, /How to fish it:/);
  assert.match(app, /Channel edge/);
  assert.match(app, /Rip channel/);
  assert.match(app, /Rock-to-sand edge/);
  assert.match(app, /Eelgrass edge/);
});

test("uses a marine basemap with map-native clustered points and deterministic Bay controls", async () => {
  const map = await readFile(
    new URL("../app/components/ContourMap.tsx", import.meta.url),
    "utf8",
  );

  assert.match(map, /World_Ocean_Base/);
  assert.match(map, /World_Ocean_Reference/);
  assert.match(map, /type: "geojson"/);
  assert.match(map, /cluster: true/);
  assert.match(map, /scrollZoom: false/);
  assert.match(map, /cooperativeGestures: true/);
  assert.match(map, /new ResizeObserver/);
  assert.match(map, /retainPadding: false/);
  assert.match(map, /Center Bay/);
  assert.doesNotMatch(map, /new maplibregl\.Marker/);
  assert.doesNotMatch(map, /openfreemap|versatiles/i);
  assert.doesNotMatch(map, /tile\.openstreetmap\.org/);
});

test("keeps maps and source navigation immediately reachable", async () => {
  const [app, css] = await Promise.all([
    readFile(new URL("../app/components/OpportunityApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.ok(app.indexOf('className="place-media-block"') < app.indexOf('className="detail-score-block"'));
  assert.match(app, /scrollToSection\("sources"\)/);
  assert.match(app, /role="dialog"/);
  assert.match(app, /aria-modal="true"/);
  assert.match(css, /\.map-wrap\s*\{[^}]*min-height:\s*0/s);
  assert.match(css, /\.ranking-panel\s*\{[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.site-list\s*\{[^}]*overscroll-behavior-y:\s*auto/s);
  assert.match(css, /\.detail-sheet\s*\{[^}]*height:\s*100dvh/s);
  assert.match(css, /\.source-section\s*\{[^}]*scroll-margin-top:\s*88px/s);
});

test("defers the interactive map and keeps the offline snapshot lightweight", async () => {
  const [app, css, snapshot] = await Promise.all([
    readFile(new URL("../app/components/OpportunityApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../public/data/opportunities.json", import.meta.url)),
  ]);

  assert.match(app, /lazy\(\(\) => import\("\.\/ContourMap"\)/);
  assert.match(app, /new IntersectionObserver/);
  assert.match(app, /Open interactive map/);
  const transferSize = gzipSync(snapshot).byteLength;
  assert.ok(transferSize < 150_000, `compressed forecast snapshot is ${transferSize} bytes`);
  assert.match(css, /url\("\/topography-contours-v2\.webp"\)/);
  assert.match(css, /content-visibility:\s*auto/);
});
