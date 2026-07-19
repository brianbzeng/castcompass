import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function read(path) {
  return readFile(new URL(path, root), "utf8");
}

async function policy() {
  return JSON.parse(await read("seo/language-policy.json"));
}

function keys(value) {
  return Object.keys(value).sort();
}

const expectedPages = [
  {
    route: "/",
    canonical: "https://castingcompass.com/",
    title: "CastingCompass — California halibut opportunity planner",
    description: "Compare public Bay Area shore, beach, jetty, and pier fishing windows using explainable relative rankings from habitat, seasonality, and current conditions.",
  },
  {
    route: "/privacy",
    canonical: "https://castingcompass.com/privacy",
    title: "Privacy Policy · CastingCompass",
    description: "How CastingCompass collects, uses, shares, retains, and protects information.",
  },
  {
    route: "/terms",
    canonical: "https://castingcompass.com/terms",
    title: "Terms of Service · CastingCompass",
    description: "Terms governing use of the CastingCompass fishing opportunity planner and account features.",
  },
  {
    route: "/ai-disclosure",
    canonical: "https://castingcompass.com/ai-disclosure",
    title: "AI and Forecast Disclosure · CastingCompass",
    description: "How CastingCompass uses a heuristic relative ranker, public forecast inputs, model research, and human-gated AI review.",
  },
];

test("SEO language policy is exact, four-page, and bound to current metadata", async () => {
  const value = await policy();
  assert.deepEqual(keys(value), [
    "evidenceContract",
    "excludedRoutes",
    "indexableRoutes",
    "pages",
    "providerActionsEnabled",
    "providerBaseline",
    "reviewedOn",
    "schemaVersion",
    "siteOrigin",
    "truthfulLanguage",
  ]);
  assert.equal(value.schemaVersion, 1);
  assert.match(value.reviewedOn, /^\d{4}-\d{2}-\d{2}$/u);
  assert.equal(value.siteOrigin, "https://castingcompass.com");
  assert.deepEqual(value.indexableRoutes, expectedPages.map(({ route }) => route));
  assert.equal(new Set(value.indexableRoutes).size, value.indexableRoutes.length);
  assert.equal(value.pages.length, expectedPages.length);

  for (const expected of expectedPages) {
    const page = value.pages.find(({ route }) => route === expected.route);
    assert.ok(page, `${expected.route} language sheet is missing`);
    assert.deepEqual(keys(page), [
      "audienceQuestions",
      "candidateSearchPhrases",
      "canonical",
      "currentDescription",
      "currentTitle",
      "desiredSnippet",
      "indexingIntent",
      "nextAction",
      "pagePurpose",
      "route",
    ]);
    assert.equal(page.canonical, expected.canonical);
    assert.equal(page.indexingIntent, "index");
    assert.equal(page.currentTitle, expected.title);
    assert.equal(page.currentDescription, expected.description);
    assert.equal(page.desiredSnippet, expected.description);
    assert.ok(page.audienceQuestions.length >= 3);
    assert.ok(page.audienceQuestions.every((question) => question.endsWith("?")));
    assert.ok(page.candidateSearchPhrases.length >= 4);
    assert.ok(page.pagePurpose.length >= 80);
    assert.ok(page.nextAction.length >= 50);
  }
});

test("private profile and provider actions stay fail closed", async () => {
  const value = await policy();
  assert.deepEqual(value.excludedRoutes, [{
    route: "/profile",
    indexingIntent: "noindex,nofollow",
    sitemapAllowed: false,
    indexingRequestAllowed: false,
    reason: "Account-only utility page, not a public search landing page.",
  }]);
  assert.ok(Object.values(value.providerActionsEnabled).every((enabled) => enabled === false));

  for (const [provider, baseline] of Object.entries(value.providerBaseline)) {
    assert.match(baseline.dashboardCreation, /^operator_reported_2026-07-17$/u, provider);
    for (const [state, observed] of Object.entries(baseline)) {
      if (state === "dashboardCreation" || state === "propertyType" || state === "verificationMethod") continue;
      assert.equal(observed, false, `${provider}.${state} cannot be pre-approved`);
    }
  }

  const [sitemap, profileSource] = await Promise.all([
    read("public/sitemap.xml"),
    read("app/profile/page.tsx"),
  ]);
  const sitemapUrls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/gu)].map((match) => match[1]);
  assert.deepEqual(sitemapUrls, expectedPages.map(({ canonical }) => canonical));
  assert.doesNotMatch(sitemap, /\/profile|\/api\//u);
  assert.match(profileSource, /index:\s*false/u);
  assert.match(profileSource, /follow:\s*false/u);
});

test("strategy content rejects prohibited claims and secret material", async () => {
  const value = await policy();
  assert.deepEqual(value.truthfulLanguage.requiredConcepts, [
    "explainable relative rankings",
    "heuristic",
    "public forecast inputs",
    "uncertainty",
    "freshness",
    "verify current conditions, regulations, access, and safety",
  ]);
  assert.deepEqual(
    value.truthfulLanguage.prohibitedClaimGroups.map(({ group }) => group),
    [
      "catch outcomes and superiority",
      "model validation and training",
      "freshness, regulations, access, and safety",
      "agency endorsement",
      "search and release status",
    ],
  );

  const forbidden = value.truthfulLanguage.prohibitedClaimGroups.flatMap(({ phrases }) => phrases);
  assert.equal(new Set(forbidden.map((phrase) => phrase.toLowerCase())).size, forbidden.length);
  const strategyText = value.pages.map((page) => [
    page.pagePurpose,
    ...page.audienceQuestions,
    ...page.candidateSearchPhrases,
    page.currentTitle,
    page.currentDescription,
    page.desiredSnippet,
    page.nextAction,
  ].join("\n")).join("\n").toLowerCase();
  for (const phrase of forbidden) {
    assert.equal(strategyText.includes(phrase.toLowerCase()), false, `prohibited strategy claim: ${phrase}`);
  }

  const raw = JSON.stringify(value);
  assert.doesNotMatch(raw, /google-site-verification\s*[=:]/iu);
  assert.doesNotMatch(raw, /msvalidate\.01\s*[=:]/iu);
  assert.doesNotMatch(raw, /authorization:\s*bearer/iu);
  assert.doesNotMatch(raw, /(?:api|access|session)[_-]?(?:key|token|cookie)\s*[=:]\s*["'][A-Za-z0-9_-]{12,}/iu);
});

test("evidence states stay independent and documentation stays truthful", async () => {
  const value = await policy();
  assert.deepEqual(value.evidenceContract.states, [
    "dashboard_created",
    "ownership_verified",
    "sitemap_submitted",
    "sitemap_processed",
    "live_url_tested",
    "indexing_requested",
    "indexed",
    "performance_observed",
  ]);
  assert.equal(value.evidenceContract.storage, "private_outside_repository");
  assert.ok(value.evidenceContract.prohibitedFields.includes("DNS verification value"));
  assert.ok(value.evidenceContract.prohibitedFields.includes("session cookie"));
  assert.ok(value.evidenceContract.prohibitedFields.includes("user or trip data"));

  const [launch, language, goals] = await Promise.all([
    read("docs/SEO_LAUNCH.md"),
    read("docs/SEO_LANGUAGE_AND_EVIDENCE.md"),
    read("docs/GOAL_STATUS.md"),
  ]);
  assert.match(launch, /SEO_LANGUAGE_AND_EVIDENCE\.md/u);
  assert.match(language, /does not authorize a DNS change/u);
  assert.match(language, /does not guarantee an\s+indexed result/u);
  assert.match(language, /private_outside_repository|outside Git/u);
  assert.match(goals, /\[x\] Prepare an SEO language sheet:/u);
  assert.match(goals, /\[ \] Record current Google\/Bing dashboard ownership/u);
});
