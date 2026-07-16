import assert from "node:assert/strict";
import test from "node:test";

import {
  applyCurrentFreshness,
  hasLiveForecastInputs,
  sourceStatusTone,
} from "../app/lib/forecast-freshness.ts";

const NOW = Date.parse("2026-07-16T12:00:00.000Z");

function source(overrides = {}) {
  return {
    name: "Example forecast",
    observedAt: "2026-07-16T05:00:00.000Z",
    status: "fresh; generated successfully",
    freshnessLimitHours: 6,
    ...overrides,
  };
}

function snapshot(rootSource, nestedSource = rootSource) {
  return {
    generatedAt: "2026-07-16T05:00:00.000Z",
    modelVersion: "test",
    sources: [rootSource],
    windows: [{
      id: "window-1",
      siteId: "site-1",
      start: "2026-07-16T12:00:00.000Z",
      end: "2026-07-16T14:00:00.000Z",
      score: 50,
      habitatScore: 50,
      seasonalityScore: 50,
      dynamicScore: 50,
      fishabilityScore: 50,
      confidence: "low",
      explanationFactors: [],
      conditions: {},
      sources: [nestedSource],
    }],
  };
}

test("deployed forecast sources become stale when their real freshness limit passes", () => {
  const original = snapshot(source());
  const current = applyCurrentFreshness(original, NOW);

  assert.match(current.sources[0].status, /^stale;/);
  assert.equal(current.sources[0].ageMinutes, 420);
  assert.match(current.windows[0].sources[0].status, /^stale;/);
  assert.match(original.sources[0].status, /^fresh;/, "the loaded snapshot is not mutated");
});

test("fresh sources remain fresh within minute- or hour-based limits", () => {
  const withinLimit = source({
    observedAt: "2026-07-16T07:00:00.000Z",
    freshnessLimitMinutes: 360,
    freshnessLimitHours: undefined,
  });
  const current = applyCurrentFreshness(snapshot(withinLimit), NOW);

  assert.match(current.sources[0].status, /^fresh;/);
  assert.equal(current.sources[0].ageMinutes, 300);
});

test("a source cannot remain fresh with an invalid observation timestamp", () => {
  const current = applyCurrentFreshness(snapshot(source({ observedAt: "invalid" })), NOW);
  assert.match(current.sources[0].status, /^stale;/);
  assert.match(current.sources[0].detail, /invalid/i);
});

test("a long-lived tide source cannot keep the overall badge live after dynamic inputs age out", () => {
  const current = applyCurrentFreshness({
    ...snapshot(source()),
    sources: [
      source({ name: "National Weather Service", freshnessLimitHours: 6 }),
      source({ name: "NOAA NDBC buoy", freshnessLimitHours: 6 }),
      source({
        name: "NOAA tide predictions",
        observedAt: "2026-07-16T05:00:00.000Z",
        freshnessLimitHours: 84,
      }),
    ],
  }, NOW);

  assert.equal(hasLiveForecastInputs(current), false);
  assert.match(current.sources[0].status, /^stale;/);
  assert.match(current.sources[2].status, /^fresh;/);
});

test("the live badge requires at least two current time-sensitive inputs", () => {
  const current = applyCurrentFreshness({
    ...snapshot(source()),
    sources: [
      source({ name: "Weather", observedAt: "2026-07-16T10:00:00.000Z", freshnessLimitMinutes: 360 }),
      source({ name: "Buoy", observedAt: "2026-07-16T10:30:00.000Z", freshnessLimitMinutes: 360 }),
    ],
  }, NOW);

  assert.equal(hasLiveForecastInputs(current), true);
  assert.equal(hasLiveForecastInputs({ ...current, sources: current.sources.slice(0, 1) }), false);
});

test("expired and unavailable source labels use the stale visual tone", () => {
  assert.equal(sourceStatusTone("fresh; generated successfully"), "fresh");
  assert.equal(sourceStatusTone("aging; approaching limit"), "aging");
  assert.equal(sourceStatusTone("provisional prior"), "aging");
  assert.equal(sourceStatusTone("stale; freshness limit exceeded"), "stale");
  assert.equal(sourceStatusTone("unavailable-excluded"), "stale");
});
