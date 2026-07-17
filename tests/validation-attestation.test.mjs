import assert from "node:assert/strict";
import test from "node:test";
import {
  clearAttestationCacheForTests,
  verifyOpportunityAttestation,
} from "../worker/validation.ts";

const scoringSha = "c".repeat(64);

function validIndex() {
  return {
    schema_version: "castingcompass.opportunity-attestation-index/1.0.0",
    generated_at: "2026-07-31T20:00:00Z",
    snapshot_sha256: "a".repeat(64),
    site_catalog_sha256: "b".repeat(64),
    target_taxon_id: "california-halibut",
    taxon_catalog_version: "castingcompass.taxa/1.0.0",
    observation_contract_version: "castingcompass.observation/2.0.0",
    model_run_contract_version: "castingcompass.model-run/2.0.0",
    opportunity_contract_version: "castingcompass.opportunity/2.0.0",
    scoring_system_kind: "heuristic-configuration",
    scoring_system_version: `heuristic-california-halibut-${scoringSha}`,
    scoring_system_sha256: scoringSha,
    windows: [[
      "ocean-beach--20260801T1000Z",
      "ocean-beach",
      "2026-08-01T10:00:00Z",
      "2026-08-01T12:00:00Z",
      67,
      55,
      66,
      77,
      88,
    ]],
  };
}

function assetsFor(value, headers = {}) {
  return {
    async fetch() {
      return new Response(typeof value === "string" ? value : JSON.stringify(value), {
        status: 200,
        headers: { "Content-Type": "application/json", ...headers },
      });
    },
  };
}

test("attestation accepts only an exact authoritative site-window tuple", async () => {
  const assets = assetsFor(validIndex());
  const verified = await verifyOpportunityAttestation(assets, "https://castingcompass.com/api/trips/start", {
    windowId: "ocean-beach--20260801T1000Z",
    siteId: "ocean-beach",
    startedAt: "2026-08-01T10:30:00.000Z",
  });
  assert.equal(verified.status, "verified");
  assert.equal(verified.opportunity?.scoringSystemSha256, scoringSha);
  assert.equal(verified.opportunity?.opportunityScore, 67);

  const wrongSite = await verifyOpportunityAttestation(assets, "https://castingcompass.com/api/trips/start", {
    windowId: "ocean-beach--20260801T1000Z",
    siteId: "another-site",
    startedAt: "2026-08-01T10:30:00.000Z",
  });
  assert.deepEqual(wrongSite, { status: "unverified_mismatch", opportunity: null });
  const atExclusiveEnd = await verifyOpportunityAttestation(assets, "https://castingcompass.com/api/trips/start", {
    windowId: "ocean-beach--20260801T1000Z",
    siteId: "ocean-beach",
    startedAt: "2026-08-01T12:00:00.000Z",
  });
  assert.deepEqual(atExclusiveEnd, { status: "unverified_mismatch", opportunity: null });
  clearAttestationCacheForTests(assets);
});

test("attestation parsing fails closed for malformed identity, dates, shape, and size", async () => {
  const cases = [
    { ...validIndex(), scoring_system_kind: "machine-learning-model" },
    { ...validIndex(), scoring_system_version: "heuristic-california-halibut-unbound" },
    { ...validIndex(), generated_at: "2026-02-31T20:00:00Z" },
    { ...validIndex(), unexpected: true },
    { ...validIndex(), windows: [["too-short"]] },
  ];
  for (const value of cases) {
    const assets = assetsFor(value);
    const result = await verifyOpportunityAttestation(assets, "https://castingcompass.com/api/trips/start", {
      windowId: "ocean-beach--20260801T1000Z",
      siteId: "ocean-beach",
      startedAt: "2026-08-01T10:30:00.000Z",
    });
    assert.deepEqual(result, { status: "unverified_asset", opportunity: null });
  }

  const oversized = assetsFor("{}", { "Content-Length": String(512 * 1024 + 1) });
  const oversizedResult = await verifyOpportunityAttestation(
    oversized,
    "https://castingcompass.com/api/trips/start",
    {
      windowId: "ocean-beach--20260801T1000Z",
      siteId: "ocean-beach",
      startedAt: "2026-08-01T10:30:00.000Z",
    },
  );
  assert.deepEqual(oversizedResult, { status: "unverified_asset", opportunity: null });
});
