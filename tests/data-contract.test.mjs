import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, root), "utf8"));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("curates the required number of reachable Bay Area access sites", async () => {
  const [sites, publicSites] = await Promise.all([
    readJson("data/sites.json"),
    readJson("public/data/sites.json"),
  ]);

  assert.ok(sites.length >= 30 && sites.length <= 50, `expected 30–50 sites, received ${sites.length}`);
  assert.equal(new Set(sites.map((site) => site.id)).size, sites.length);
  assert.deepEqual(publicSites, sites);

  for (const site of sites) {
    assert.match(site.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.ok(site.latitude >= 37.35 && site.latitude <= 38.25, `${site.id} latitude outside launch geography`);
    assert.ok(site.longitude >= -123.1 && site.longitude <= -121.9, `${site.id} longitude outside launch geography`);
    assert.ok(["Shore", "Beach", "Jetty", "Pier"].includes(site.type));
    assert.ok(site.regulationUrl.startsWith("https://wildlife.ca.gov/"));
    assert.ok(site.structureTags.length > 0);
    assert.ok(site.castingZone?.radiusMeters > 0);
    assert.ok(Number.isFinite(site.streetViewLatitude));
    assert.ok(Number.isFinite(site.streetViewLongitude));
    if (site.accessStatus === "closed") {
      assert.match(site.accessSourceUrl ?? "", /^https:\/\//);
      assert.ok(site.accessStatusNote?.length > 20);
    }
  }
});

test("publishes every two-hour window across the 72-hour snapshot", async () => {
  const [sites, snapshot] = await Promise.all([
    readJson("data/sites.json"),
    readJson("public/data/opportunities.json"),
  ]);
  const activeSites = sites.filter((site) => site.accessStatus !== "closed");
  const closedIds = new Set(sites.filter((site) => site.accessStatus === "closed").map((site) => site.id));
  const bySite = new Map();
  let windowsWithPressure = 0;
  let windowsWithWavePower = 0;

  assert.equal(snapshot.target_taxon_id, "california-halibut");
  assert.equal(snapshot.species, snapshot.target_taxon_id);
  assert.equal(snapshot.taxon_catalog_version, "castingcompass.taxa/1.0.0");
  assert.equal(snapshot.observation_contract_version, "castingcompass.observation/2.0.0");
  assert.equal(snapshot.model_run_contract_version, "castingcompass.model-run/2.0.0");
  assert.equal(snapshot.opportunity_contract_version, "castingcompass.opportunity/2.0.0");
  assert.equal(snapshot.scoring_system_kind, "heuristic-configuration");
  assert.match(snapshot.scoring_system_sha256, /^[a-f0-9]{64}$/);
  assert.equal(snapshot.modelVersion, snapshot.scoring_system_version);

  for (const window of snapshot.windows) {
    assert.equal(window.target_taxon_id, snapshot.target_taxon_id);
    assert.equal(window.species, window.target_taxon_id);
    assert.equal(window.taxon_catalog_version, snapshot.taxon_catalog_version);
    assert.equal(window.observation_contract_version, snapshot.observation_contract_version);
    assert.equal(window.model_run_contract_version, snapshot.model_run_contract_version);
    assert.equal(window.opportunity_contract_version, snapshot.opportunity_contract_version);
    assert.equal(window.scoring_system_kind, snapshot.scoring_system_kind);
    assert.equal(window.scoring_system_sha256, snapshot.scoring_system_sha256);
    assert.equal(window.modelVersion, snapshot.scoring_system_version);
    bySite.set(window.siteId, (bySite.get(window.siteId) ?? 0) + 1);
    assert.equal(new Date(window.end).getTime() - new Date(window.start).getTime(), 2 * 60 * 60 * 1000);
    for (const value of [window.score, window.habitatScore, window.seasonalityScore, window.dynamicScore]) {
      assert.ok(value >= 0 && value <= 100);
    }
    assert.ok(["low", "medium", "high"].includes(window.confidence));
    assert.ok(window.explanationFactors.length >= 3);
    assert.ok(Number.isFinite(window.conditions?.waterTempF), `${window.id} must include modeled SST`);
    assert.ok(Number.isFinite(window.conditions?.cloudCoverPct), `${window.id} must include NWS sky cover`);
    assert.ok(Number.isFinite(window.conditions?.moonIlluminationPct), `${window.id} must include lunar illumination`);
    assert.equal(window.conditions?.tideLevelsFeet?.length, 4, `${window.id} must include the tide-chart window`);
    if (Number.isFinite(window.conditions?.pressureHpa)) windowsWithPressure += 1;
    if (Number.isFinite(window.conditions?.wavePowerKwM)) {
      windowsWithWavePower += 1;
      assert.ok(Number.isFinite(window.conditions?.swellPeriodSeconds), `${window.id} wave power requires a period`);
    }
    assert.equal(closedIds.has(window.siteId), false, `${window.siteId} is closed and must not be ranked`);
  }

  assert.equal(snapshot.windows.length, activeSites.length * 36);
  for (const site of activeSites) assert.equal(bySite.get(site.id), 36, `${site.id} must have 36 windows`);
  assert.match(snapshot.scoreDefinition, /not an 80% catch probability/i);
  assert.ok(snapshot.sources.some((source) => source.status.startsWith("fresh")));
  assert.ok(snapshot.sources.some((source) => /not integrated|excluded/i.test(source.status)));
  assert.ok(snapshot.sources.some((source) => /Open-Meteo marine/i.test(source.name)));
  assert.ok(snapshot.sources.some((source) => /moon phase/i.test(source.name)));
  assert.ok(windowsWithPressure > 0, "near-term windows must use fresh buoy pressure when available");
  assert.ok(windowsWithWavePower > 0, "open-coast windows must include estimated wave power");
});

test("publishes a compact attestation index bound to the exact public assets", async () => {
  const [snapshotBytes, sitesBytes, attestationBytes] = await Promise.all([
    readFile(new URL("public/data/opportunities.json", root)),
    readFile(new URL("public/data/sites.json", root)),
    readFile(new URL("public/data/opportunity-attestations.json", root)),
  ]);
  const snapshot = JSON.parse(snapshotBytes.toString("utf8"));
  const attestation = JSON.parse(attestationBytes.toString("utf8"));

  assert.ok(attestationBytes.byteLength > 0 && attestationBytes.byteLength <= 512 * 1024);
  assert.equal(attestation.schema_version, "castingcompass.opportunity-attestation-index/1.0.0");
  assert.equal(attestation.snapshot_sha256, sha256(snapshotBytes));
  assert.equal(attestation.site_catalog_sha256, sha256(sitesBytes));
  assert.equal(attestation.target_taxon_id, "california-halibut");
  assert.equal(attestation.taxon_catalog_version, "castingcompass.taxa/1.0.0");
  assert.equal(attestation.observation_contract_version, "castingcompass.observation/2.0.0");
  assert.equal(attestation.model_run_contract_version, "castingcompass.model-run/2.0.0");
  assert.equal(attestation.opportunity_contract_version, "castingcompass.opportunity/2.0.0");
  assert.equal(attestation.scoring_system_kind, "heuristic-configuration");
  assert.match(attestation.scoring_system_sha256, /^[a-f0-9]{64}$/);
  assert.equal(
    attestation.scoring_system_version,
    `heuristic-california-halibut-${attestation.scoring_system_sha256}`,
  );
  assert.equal(attestation.windows.length, snapshot.windows.length);

  const snapshotById = new Map(snapshot.windows.map((window) => [window.id, window]));
  const seen = new Set();
  for (const tuple of attestation.windows) {
    assert.equal(tuple.length, 9);
    const [id, siteId, start, end, score, habitat, seasonality, conditions, fishability] = tuple;
    assert.equal(seen.has(id), false, `duplicate attestation ${id}`);
    seen.add(id);
    const window = snapshotById.get(id);
    assert.ok(window, `attestation ${id} must exist in the exact snapshot`);
    assert.deepEqual(
      [siteId, start, end, score, habitat, seasonality, conditions, fishability],
      [
        window.siteId,
        window.start,
        window.end,
        window.score,
        window.habitatScore,
        window.seasonalityScore,
        window.dynamicScore,
        window.fishabilityScore,
      ],
    );
  }
});

test("every supported snapshot refresh chains the byte-binding attestation emitter", async () => {
  const [packageJson, workflow, snapshotGenerator, attestationEmitter] = await Promise.all([
    readJson("package.json"),
    readFile(new URL(".github/workflows/refresh-snapshot.yml", root), "utf8"),
    readFile(new URL("scripts/generate_snapshot.py", root), "utf8"),
    readFile(new URL("scripts/generate_opportunity_attestations.py", root), "utf8"),
  ]);
  const refresh = packageJson.scripts["data:refresh"];
  assert.match(refresh, /PYTHONPATH=\. python3 scripts\/generate_snapshot\.py/);
  assert.match(refresh, /&& PYTHONPATH=\. python3 scripts\/generate_opportunity_attestations\.py/);
  assert.ok(
    refresh.indexOf("generate_snapshot.py") < refresh.indexOf("generate_opportunity_attestations.py"),
  );
  assert.match(workflow, /PYTHONPATH: \./);
  assert.ok(
    workflow.indexOf("python scripts/generate_snapshot.py") <
      workflow.indexOf("python scripts/generate_opportunity_attestations.py"),
  );
  assert.match(workflow, /python -m json\.tool public\/data\/opportunity-attestations\.json/);
  assert.doesNotMatch(snapshotGenerator, /opportunity-attestations|write_opportunity_attestation/);
  assert.match(attestationEmitter, /snapshot_path\.read_bytes\(\)/);
  assert.match(attestationEmitter, /site_catalog_path\.read_bytes\(\)/);
});

test("validation source sealing relies on the trusted service clock", async () => {
  const source = await readJson("pipeline/sources/castingcompass_trip_log.json");
  const command = source.access.ingestion_command;

  assert.match(command, /pipeline\.contourcast\.cli seal-validation-splits/);
  assert.match(command, /--manifest-chain PRIVATE_ACTIVATION\.json/);
  assert.match(command, /--output PRIVATE_SPLIT_MANIFEST\.json/);
  assert.doesNotMatch(command, /--(?:created-at|activated-at|label-open(?:ed)?-at)\b/);
});

test("publishes original community context separately from the score", async () => {
  const [community, publicCommunity] = await Promise.all([
    readJson("data/community-pulse.json"),
    readJson("public/data/community-pulse.json"),
  ]);
  const pulses = Array.isArray(community) ? community : community.pulses;

  assert.deepEqual(publicCommunity, community);
  assert.ok(Array.isArray(pulses) && pulses.length >= 7);
  for (const pulse of pulses) {
    assert.match(pulse.siteId, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.ok(["low", "medium", "high"].includes(pulse.confidence));
    assert.ok(pulse.summary.length >= 80);
    assert.ok(pulse.themes.length >= 2);
    assert.ok(pulse.sources.every((source) => /^https:\/\//.test(source.url)));
  }
});

test("database opportunity references bind target and exact model identity", async () => {
  const schema = await readFile(new URL("infra/schema.sql", root), "utf8");
  assert.match(
    schema,
    /UNIQUE\s*\(\s*id,\s*target_taxon_id,\s*model_version\s*\)/s,
  );
  assert.match(
    schema,
    /FOREIGN KEY\s*\(\s*model_run_id,\s*target_taxon_id,\s*model_version\s*\)\s*REFERENCES public\.model_runs\s*\(\s*id,\s*target_taxon_id,\s*model_version\s*\)/s,
  );
  assert.match(
    schema,
    /'heuristic-'\s*\|\|\s*target_taxon_id\s*\|\|\s*'-'\s*\|\|\s*scoring_system_sha256/s,
  );
});
