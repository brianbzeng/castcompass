import assert from "node:assert/strict";
import test from "node:test";

import { applyCurrentWaterQualityFreshness } from "../app/lib/water-quality-freshness.ts";

function assessment(overrides = {}) {
  return {
    status: "no-active-posting",
    recommendationEffect: "neutral",
    officialLabel: "No active posting reported",
    detail: "Neutral official context that does not improve the fishing score.",
    stationIds: ["4612"],
    stationNames: ["Crissy Field Beach East"],
    sampleDates: ["2026-07-13"],
    checkedAt: "2026-07-20T20:00:00Z",
    scoreDelta: null,
    sourceUrl: "https://webapps.sfpuc.org/sapps/beachesandbay.html",
    ...overrides,
  };
}

function snapshot(siteAssessment) {
  return {
    schemaVersion: "castingcompass.water-quality-advisory/1.0.0",
    policyVersion: "test-policy",
    policySha256: "a".repeat(64),
    collectorSha256: "b".repeat(64),
    siteCatalogSha256: "c".repeat(64),
    generatedAt: "2026-07-20T20:00:00Z",
    status: "fresh",
    meaning: "human-health water-contact advisory overlay",
    freshness: { maximumSampleAgeDays: 10 },
    scoreContribution: {
      mode: "excluded-pending-frozen-baseline-validation",
      positiveContributionAllowed: false,
      activeAgencyStatusSuppressesRecommendation: true,
    },
    source: {
      agency: "San Francisco Public Utilities Commission",
      programUrl: "https://www.sfpuc.gov/programs/ocean-and-beach-monitoring",
      statusUrl: "https://webapps.sfpuc.org/sapps/beachesandbay.html",
      machineUrl: "https://infrastructure.sfwater.org/lims.asmx/getBeaches",
      errorCategory: null,
    },
    sites: { "crissy-field-east-beach": siteAssessment },
  };
}

test("neutral agency status remains neutral through its Pacific-calendar freshness limit", () => {
  const current = applyCurrentWaterQualityFreshness(
    snapshot(assessment()),
    Date.parse("2026-07-24T06:30:00Z"),
  );
  assert.equal(current.sites["crissy-field-east-beach"].status, "no-active-posting");
  assert.equal(current.sites["crissy-field-east-beach"].recommendationEffect, "neutral");
});

test("neutral agency status expires independently in an old deployed browser artifact", () => {
  const original = snapshot(assessment());
  const current = applyCurrentWaterQualityFreshness(
    original,
    Date.parse("2026-07-24T07:30:00Z"),
  );
  assert.equal(current.sites["crissy-field-east-beach"].status, "stale");
  assert.equal(current.sites["crissy-field-east-beach"].recommendationEffect, "unknown");
  assert.match(current.sites["crissy-field-east-beach"].detail, /older than the 10-day freshness limit/);
  assert.equal(original.sites["crissy-field-east-beach"].status, "no-active-posting");
});

test("missing, invalid, and future neutral sample dates fail closed", () => {
  for (const sampleDates of [[], ["not-a-date"], ["2026-07-31"]]) {
    const current = applyCurrentWaterQualityFreshness(
      snapshot(assessment({ sampleDates })),
      Date.parse("2026-07-20T20:00:00Z"),
    );
    assert.equal(current.sites["crissy-field-east-beach"].status, "stale");
    assert.equal(current.sites["crissy-field-east-beach"].recommendationEffect, "unknown");
  }
});

test("active official status remains conservatively suppressed when refresh evidence ages", () => {
  const current = applyCurrentWaterQualityFreshness(
    snapshot(assessment({
      status: "posted",
      recommendationEffect: "suppress",
      officialLabel: "Official water-contact posting",
    })),
    Date.parse("2026-09-01T20:00:00Z"),
  );
  assert.equal(current.sites["crissy-field-east-beach"].status, "posted");
  assert.equal(current.sites["crissy-field-east-beach"].recommendationEffect, "suppress");
});
