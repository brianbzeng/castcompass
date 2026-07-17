import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render(path) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("seo-test", `${process.pid}-${Date.now()}-${path}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`http://localhost${path}`, { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

function tags(html, name) {
  return [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, "gi"))].map((match) => match[0]);
}

function attribute(tag, name) {
  return tag.match(new RegExp(`\\b${name}="([^"]*)"`, "i"))?.[1] ?? null;
}

function metaValues(html, key, value) {
  return tags(html, "meta")
    .filter((tag) => attribute(tag, key) === value)
    .map((tag) => attribute(tag, "content"));
}

function canonicalValues(html) {
  return tags(html, "link")
    .filter((tag) => attribute(tag, "rel") === "canonical")
    .map((tag) => attribute(tag, "href"));
}

function elementText(html, name) {
  return html.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, "i"))?.[1] ?? null;
}

const publicRoutes = [
  {
    path: "/",
    canonical: "https://castingcompass.com/",
    title: "CastingCompass — California halibut opportunity planner",
    description: "Compare public Bay Area shore, beach, jetty, and pier fishing windows using explainable relative rankings from habitat, seasonality, and current conditions.",
  },
  {
    path: "/privacy",
    canonical: "https://castingcompass.com/privacy",
    title: "Privacy Policy · CastingCompass",
    description: "How CastingCompass collects, uses, shares, retains, and protects information.",
  },
  {
    path: "/terms",
    canonical: "https://castingcompass.com/terms",
    title: "Terms of Service · CastingCompass",
    description: "Terms governing use of the CastingCompass fishing opportunity planner and account features.",
  },
  {
    path: "/ai-disclosure",
    canonical: "https://castingcompass.com/ai-disclosure",
    title: "AI and Forecast Disclosure · CastingCompass",
    description: "How CastingCompass uses a heuristic relative ranker, public forecast inputs, model research, and human-gated AI review.",
  },
];

test("public pages render one self-canonical and truthful route-specific social metadata", async () => {
  for (const route of publicRoutes) {
    const response = await render(route.path);
    assert.equal(response.status, 200, route.path);
    const html = await response.text();
    assert.equal(elementText(html, "title"), route.title);
    assert.deepEqual(metaValues(html, "name", "description"), [route.description]);
    assert.deepEqual(canonicalValues(html), [route.canonical], `${route.path} canonical`);
    assert.deepEqual(metaValues(html, "property", "og:url"), [route.canonical]);
    assert.deepEqual(metaValues(html, "property", "og:title"), [route.title]);
    assert.deepEqual(metaValues(html, "property", "og:description"), [route.description]);
    assert.deepEqual(metaValues(html, "property", "og:site_name"), ["CastingCompass"]);
    assert.deepEqual(metaValues(html, "property", "og:image:width"), ["1200"]);
    assert.deepEqual(metaValues(html, "property", "og:image:height"), ["630"]);
    assert.deepEqual(metaValues(html, "property", "og:image:alt"), ["CastingCompass — California Halibut Opportunity Planner"]);
    assert.deepEqual(metaValues(html, "property", "og:image"), ["https://castingcompass.com/og.png"]);
    assert.deepEqual(metaValues(html, "name", "twitter:card"), ["summary_large_image"]);
    assert.deepEqual(metaValues(html, "name", "twitter:title"), [route.title]);
    assert.deepEqual(metaValues(html, "name", "twitter:description"), [route.description]);
    assert.deepEqual(metaValues(html, "name", "twitter:image"), ["https://castingcompass.com/og.png"]);
    assert.deepEqual(metaValues(html, "name", "twitter:image:alt"), ["CastingCompass — California Halibut Opportunity Planner"]);
    assert.equal(metaValues(html, "name", "robots").some((value) => /noindex/i.test(value ?? "")), false);
    assert.doesNotMatch(html, /<meta[^>]+(?:google-site-verification|msvalidate\.01)/i);
  }
});

test("the account-only profile is self-canonical and noindex without a robots.txt block", async () => {
  const response = await render("/profile");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.deepEqual(canonicalValues(html), ["https://castingcompass.com/profile"]);
  const robots = metaValues(html, "name", "robots").join(",").toLowerCase();
  assert.match(robots, /noindex/);
  assert.match(robots, /nofollow/);

  const robotsText = await readFile(new URL("../public/robots.txt", import.meta.url), "utf8");
  assert.doesNotMatch(robotsText, /disallow:\s*\/profile/i);
});

test("robots and the XML sitemap publish exactly the intended crawl set", async () => {
  const [robots, sitemap, builtRobots, builtSitemap] = await Promise.all([
    readFile(new URL("../public/robots.txt", import.meta.url), "utf8"),
    readFile(new URL("../public/sitemap.xml", import.meta.url), "utf8"),
    readFile(new URL("../dist/client/robots.txt", import.meta.url), "utf8"),
    readFile(new URL("../dist/client/sitemap.xml", import.meta.url), "utf8"),
  ]);
  assert.equal(builtRobots, robots);
  assert.equal(builtSitemap, sitemap);
  assert.match(robots, /^User-agent: \*$/m);
  assert.match(robots, /^Allow: \/$/m);
  assert.match(robots, /^Sitemap: https:\/\/castingcompass\.com\/sitemap\.xml$/m);
  assert.doesNotMatch(robots, /^Disallow:/m);

  const locations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
  assert.deepEqual(locations, publicRoutes.map((route) => route.canonical));
  assert.doesNotMatch(sitemap, /\/profile|\/api\//);
  assert.doesNotMatch(sitemap, /<lastmod>/);
  assert.match(sitemap, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
});

test("homepage JSON-LD is a narrow truthful WebSite declaration", async () => {
  const response = await render("/");
  const html = await response.text();
  const match = html.match(/<script[^>]*id="castingcompass-website-schema"[^>]*>([\s\S]*?)<\/script>/);
  assert.ok(match, "homepage WebSite JSON-LD must render");
  const structuredData = JSON.parse(match[1]);
  assert.deepEqual(structuredData, {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "CastingCompass",
    alternateName: "Casting Compass",
    url: "https://castingcompass.com/",
    description: publicRoutes[0].description,
    inLanguage: "en-US",
  });
  assert.doesNotMatch(JSON.stringify(structuredData), /rating|accuracy|probability|localbusiness|product|dataset/i);
});
